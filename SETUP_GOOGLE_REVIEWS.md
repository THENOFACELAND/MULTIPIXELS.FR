# Setup Google Reviews (Backend Proxy)

## 1. Creer votre fichier d'environnement

Copiez `.env.example` vers `.env` puis renseignez:

- `GOOGLE_MAPS_API_KEY`
- `GOOGLE_PLACE_ID` (recommande, format `ChIJ...`)
- `GOOGLE_PLACE_QUERY` (optionnel si `GOOGLE_PLACE_ID` est renseigne)

## 2. Demarrer le serveur

```bash
npm start
```

Le site est servi avec l'API proxy sur le meme serveur:

- Site: `http://localhost:3000`
- API: `http://localhost:3000/api/google-reviews`

## 3. Config Google Cloud obligatoire

- Activer la facturation.
- Activer `Places API`.
- Restreindre la cle API (IP serveur ou referrer selon votre hebergement).

## 4. Verification rapide

Ouvrez:

`http://localhost:3000/api/google-reviews`

Vous devez voir `{"ok":true,...}` avec vos vrais avis.
