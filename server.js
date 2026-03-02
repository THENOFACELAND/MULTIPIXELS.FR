const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
let nodemailer;
try {
  nodemailer = require("nodemailer");
} catch (_) {
  nodemailer = null;
}

const ROOT = __dirname;

function loadDotEnvFile() {
  const dotenvPath = path.join(ROOT, ".env");
  if (!fs.existsSync(dotenvPath)) return;

  const raw = fs.readFileSync(dotenvPath, "utf8");
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const sep = trimmed.indexOf("=");
    if (sep <= 0) return;
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  });
}

loadDotEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const API_KEY = (process.env.GOOGLE_MAPS_API_KEY || "").trim();
const DEFAULT_PLACE_ID = (process.env.GOOGLE_PLACE_ID || "").trim();
const DEFAULT_QUERY = (process.env.GOOGLE_PLACE_QUERY || "MULTIPIXELS, 190 Chemin Blanc, 62180 Rang-du-Fliers").trim();
const CONTACT_TO = (process.env.CONTACT_TO || "contact@multipixels.fr").trim();
const SMTP_HOST = (process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "").trim().toLowerCase() === "true" || SMTP_PORT === 465;
const SMTP_USER = (process.env.SMTP_USER || "").trim();
const SMTP_PASS = (process.env.SMTP_PASS || "").trim();
const CONTACT_FROM = (process.env.CONTACT_FROM || SMTP_USER || "no-reply@multipixels.fr").trim();

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function parseJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("REQUEST_BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error("INVALID_JSON"));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

function sanitizeLine(value, maxLen = 4000) {
  return String(value || "").replace(/\r?\n/g, " ").trim().slice(0, maxLen);
}

function repairText(value) {
  const raw = String(value || "");
  if (!raw) return "";

  const maybeMojibake = /Ã|Â|ðŸ|�/.test(raw);
  if (!maybeMojibake) {
    return raw;
  }

  const repaired = Buffer.from(raw, "latin1").toString("utf8");
  const stillBroken = /Ã|Â|ðŸ|�/.test(repaired);
  return stillBroken ? raw : repaired;
}

async function handleContactApi(req, res) {
  if (!nodemailer) {
    sendJson(res, 500, {
      ok: false,
      error: {
        code: "MAILER_UNAVAILABLE",
        message: "Module d'envoi d'email manquant (installez nodemailer)."
      }
    });
    return;
  }

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !CONTACT_TO) {
    sendJson(res, 500, {
      ok: false,
      error: {
        code: "SMTP_NOT_CONFIGURED",
        message: "Configuration SMTP incomplète sur le serveur."
      }
    });
    return;
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    if (error && error.message === "REQUEST_BODY_TOO_LARGE") {
      sendJson(res, 413, {
        ok: false,
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Le message est trop volumineux."
        }
      });
      return;
    }

    sendJson(res, 400, {
      ok: false,
      error: {
        code: "INVALID_JSON",
        message: "Format de requête invalide."
      }
    });
    return;
  }

  const nom = sanitizeLine(body.nom, 120);
  const email = sanitizeLine(body.email, 180);
  const tel = sanitizeLine(body.tel, 80);
  const service = sanitizeLine(body.service, 120);
  const message = String(body.message || "").trim().slice(0, 6000);

  if (!nom || !email || !message) {
    sendJson(res, 400, {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Nom, email et message sont obligatoires."
      }
    });
    return;
  }

  const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailIsValid) {
    sendJson(res, 400, {
      ok: false,
      error: {
        code: "INVALID_EMAIL",
        message: "Adresse email invalide."
      }
    });
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  const subject = `[MULTIPIXELS] Nouvelle demande - ${service || "Contact"}`;
  const text = [
    "Nouvelle demande depuis le formulaire contact",
    "",
    `Nom: ${nom}`,
    `Email: ${email}`,
    `Telephone: ${tel || "-"}`,
    `Service: ${service || "-"}`,
    "",
    "Message:",
    message
  ].join("\n");

  try {
    await transporter.sendMail({
      from: CONTACT_FROM,
      to: CONTACT_TO,
      replyTo: email,
      subject,
      text
    });
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: {
        code: "EMAIL_SEND_FAILED",
        message: "Impossible d'envoyer le message pour le moment."
      }
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    message: "Message envoyé avec succès."
  });
}

function sanitizePathname(urlPath) {
  try {
    const decoded = decodeURIComponent(urlPath);
    const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
    return normalized;
  } catch (_) {
    return "";
  }
}

function httpGetJson(urlString) {
  return new Promise((resolve, reject) => {
    https
      .get(urlString, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            reject(new Error("Reponse Google invalide (JSON non parseable)."));
            return;
          }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      })
      .on("error", (error) => {
        reject(error);
      });
  });
}

async function findPlaceIdByQuery(query) {
  const endpoint = new URL("https://maps.googleapis.com/maps/api/place/findplacefromtext/json");
  endpoint.searchParams.set("input", query);
  endpoint.searchParams.set("inputtype", "textquery");
  endpoint.searchParams.set("fields", "place_id,name");
  endpoint.searchParams.set("language", "fr");
  endpoint.searchParams.set("key", API_KEY);

  const { body } = await httpGetJson(endpoint.toString());
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (body.status !== "OK" || !candidates[0] || !candidates[0].place_id) {
    return null;
  }
  return candidates[0].place_id;
}

async function getPlaceDetails(placeId) {
  const endpoint = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  endpoint.searchParams.set("place_id", placeId);
  endpoint.searchParams.set("fields", "place_id,name,rating,user_ratings_total,reviews,url");
  endpoint.searchParams.set("reviews_sort", "newest");
  endpoint.searchParams.set("language", "fr");
  endpoint.searchParams.set("key", API_KEY);

  const { body } = await httpGetJson(endpoint.toString());
  if (body.status !== "OK" || !body.result) {
    return { ok: false, googleStatus: body.status || "UNKNOWN_ERROR" };
  }

  const result = body.result;
  const reviews = Array.isArray(result.reviews) ? result.reviews.slice(0, 3) : [];
  const normalizedReviews = reviews.map((review) => ({
    author: repairText(review.author_name || "Client Google"),
    rating: Number(review.rating || 0),
    text: repairText(review.text || "Avis client Google"),
    time: repairText(review.relative_time_description || "")
  }));

  return {
    ok: true,
    placeId: result.place_id || placeId,
    name: repairText(result.name || "Etablissement Google"),
    rating: Number(result.rating || 0),
    ratingCount: Number(result.user_ratings_total || 0),
    url: repairText(result.url || ""),
    reviews: normalizedReviews
  };
}

async function handleReviewsApi(req, res, requestUrl) {
  if (!API_KEY) {
    sendJson(res, 500, {
      ok: false,
      error: {
        code: "MISSING_API_KEY",
        message: "Variable GOOGLE_MAPS_API_KEY manquante sur le serveur."
      }
    });
    return;
  }

  const placeIdFromQuery = (requestUrl.searchParams.get("placeId") || "").trim();
  const queryFromQuery = (requestUrl.searchParams.get("query") || "").trim();

  let selectedPlaceId = placeIdFromQuery || DEFAULT_PLACE_ID;
  if (!selectedPlaceId) {
    const queryCandidates = [queryFromQuery || DEFAULT_QUERY, "MULTIPIXELS Rang-du-Fliers", "MULTIPIXELS"];
    for (const query of queryCandidates) {
      if (!query) continue;
      selectedPlaceId = await findPlaceIdByQuery(query);
      if (selectedPlaceId) break;
    }
  }

  if (!selectedPlaceId) {
    sendJson(res, 404, {
      ok: false,
      error: {
        code: "PLACE_NOT_FOUND",
        message: "Impossible de trouver la fiche Google a partir des requetes configurees."
      }
    });
    return;
  }

  const place = await getPlaceDetails(selectedPlaceId);
  if (!place.ok) {
    sendJson(res, 502, {
      ok: false,
      error: {
        code: "GOOGLE_PLACE_DETAILS_FAILED",
        message: "Google n'a pas retourne les details de la fiche.",
        googleStatus: place.googleStatus
      }
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    source: "google_places_api",
    placeId: place.placeId,
    name: place.name,
    rating: place.rating,
    ratingCount: place.ratingCount,
    url: place.url,
    reviews: place.reviews
  });
}

function serveStaticFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        sendText(res, 404, "Not Found");
        return;
      }
      sendText(res, 500, "Internal Server Error");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendText(res, 400, "Bad Request");
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/google-reviews") {
    try {
      await handleReviewsApi(req, res, requestUrl);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error && error.message ? error.message : "Erreur serveur."
        }
      });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/contact") {
    try {
      await handleContactApi(req, res);
    } catch (_) {
      sendJson(res, 500, {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Erreur serveur."
        }
      });
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const rawPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const safePath = sanitizePathname(rawPath);
  const absolutePath = path.resolve(ROOT, `.${safePath.startsWith(path.sep) ? safePath : `/${safePath}`}`);

  if (!absolutePath.startsWith(ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  serveStaticFile(res, absolutePath);
});

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
