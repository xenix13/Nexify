// Point d'entrée : charge la configuration et démarre le serveur HTTP ou HTTPS.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { loadDotEnv, getConfig } from './config.js';
import { createApp } from './app.js';

loadDotEnv();
const config = getConfig();

if (!config.appSecret) {
  console.error('APP_SECRET manquant : copiez .env.example vers .env et renseignez-le (ou relancez deploy/install.sh).');
  process.exit(1);
}

const app = createApp(config);
const handler = (req, res) => { app.handle(req, res); };
const server = config.https
  ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handler)
  : http.createServer(handler);

server.listen(config.port, config.host, () => {
  console.log(`Nexify écoute sur ${config.https ? 'https' : 'http'}://${config.host}:${config.port}`);
  console.log(`URL publique : ${config.publicUrl}`);
  console.log(`Spotify : ${app.providers.spotify.configured ? `configuré (URI de redirection : ${config.publicUrl}/api/spotify/callback)` : 'non configuré'}`);
});

const stop = () => {
  app.store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
