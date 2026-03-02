const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "assets", "data", "google-reviews.json");

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

function httpGetJson(urlString) {
  return new Promise((resolve, reject) => {
    https
      .get(urlString, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ statusCode: res.statusCode || 0, body: JSON.parse(raw) });
          } catch (_) {
            reject(new Error("Reponse Google invalide (JSON non parseable)."));
          }
        });
      })
      .on("error", (error) => reject(error));
  });
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

async function findPlaceIdByQuery(query, apiKey) {
  const endpoint = new URL("https://maps.googleapis.com/maps/api/place/findplacefromtext/json");
  endpoint.searchParams.set("input", query);
  endpoint.searchParams.set("inputtype", "textquery");
  endpoint.searchParams.set("fields", "place_id,name");
  endpoint.searchParams.set("language", "fr");
  endpoint.searchParams.set("key", apiKey);

  const { body } = await httpGetJson(endpoint.toString());
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (body.status !== "OK" || !candidates[0] || !candidates[0].place_id) {
    return null;
  }
  return candidates[0].place_id;
}

async function getPlaceDetails(placeId, apiKey) {
  const endpoint = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  endpoint.searchParams.set("place_id", placeId);
  endpoint.searchParams.set("fields", "place_id,name,rating,user_ratings_total,reviews,url");
  endpoint.searchParams.set("reviews_sort", "newest");
  endpoint.searchParams.set("language", "fr");
  endpoint.searchParams.set("key", apiKey);

  const { body } = await httpGetJson(endpoint.toString());
  if (body.status !== "OK" || !body.result) {
    throw new Error("Google Place Details indisponible: " + (body.status || "UNKNOWN_ERROR"));
  }

  const result = body.result;
  const reviews = Array.isArray(result.reviews) ? result.reviews.slice(0, 3) : [];

  return {
    ok: true,
    source: "google_places_api",
    generatedAt: new Date().toISOString(),
    placeId: result.place_id || placeId,
    name: repairText(result.name || "Etablissement Google"),
    rating: Number(result.rating || 0),
    ratingCount: Number(result.user_ratings_total || 0),
    url: repairText(result.url || ""),
    reviews: reviews.map((review) => ({
      author: repairText(review.author_name || "Client Google"),
      rating: Number(review.rating || 0),
      text: repairText(review.text || "Avis client Google"),
      time: repairText(review.relative_time_description || "")
    }))
  };
}

async function main() {
  loadDotEnvFile();

  const apiKey = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  const defaultPlaceId = String(process.env.GOOGLE_PLACE_ID || "").trim();
  const defaultQuery = String(process.env.GOOGLE_PLACE_QUERY || "MULTIPIXELS, 190 Chemin Blanc, 62180 Rang-du-Fliers").trim();

  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY manquante dans .env");
  }

  let placeId = defaultPlaceId;
  if (!placeId) {
    const queryCandidates = [defaultQuery, "MULTIPIXELS Rang-du-Fliers", "MULTIPIXELS"];
    for (const query of queryCandidates) {
      if (!query) continue;
      placeId = await findPlaceIdByQuery(query, apiKey);
      if (placeId) break;
    }
  }

  if (!placeId) {
    throw new Error("Impossible de trouver la fiche Google (place_id introuvable).");
  }

  const payload = await getPlaceDetails(placeId, apiKey);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log("Avis Google mis a jour:", OUTPUT_PATH);
}

main().catch((error) => {
  console.error("Echec mise a jour avis Google:", error && error.message ? error.message : error);
  process.exit(1);
});
