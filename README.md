# Spotihome

Client musical auto-hébergé qui réunit **Spotify**, **Deezer** et **YouTube Music** dans une seule appli web, pour toute la maison.

- Une recherche qui interroge les trois services en même temps, avec les résultats groupés par source.
- Une bibliothèque qui rassemble les playlists et titres likés de chaque compte relié.
- Des playlists Spotihome qui mélangent des titres des trois services, et l'import d'une playlist existante en un clic.
- Un seul lecteur et une seule file d'attente, avec lecture aléatoire, répétition, touches multimédia du système et raccourcis clavier.
- Les titres Spotify peuvent jouer **dans le navigateur** (Spotify Web Playback SDK) ou sur **n'importe quel appareil Spotify Connect** (enceinte, téléphone, PC), au choix dans la barre de lecture.
- Un compte par membre du foyer, chacun avec ses propres connexions et playlists.
- Aucune dépendance npm : uniquement Node.js 22 et yt-dlp.

## Comment chaque service est joué

| Source | Recherche et bibliothèque | Lecture |
|---|---|---|
| Spotify | API Web officielle (OAuth). La recherche fonctionne même sans compte relié. | Web Playback SDK dans le navigateur, ou appareil Spotify Connect. **Premium obligatoire.** Sinon, ou au choix, via la version YouTube Music du titre. |
| Deezer | API publique : recherche, et playlists et coups de cœur d'un **profil public** | Titre complet via la version YouTube Music correspondante, sinon extrait de 30 s |
| YouTube Music | API interne du site. Recherche et playlists publiques sans compte ; bibliothèque perso avec le cookie de session. | Flux audio obtenu par yt-dlp et relayé par le serveur (l'avance rapide fonctionne) |

La correspondance entre services compare le titre nettoyé (sans « feat. », « Remastered »…), les artistes et la durée. Si rien n'est assez proche, Spotihome lit l'extrait plutôt qu'un mauvais titre. Les correspondances sont gardées en cache.

### Limites à connaître

- **Spotify** : depuis février 2026, une appli en « mode développement » exige que son propriétaire soit Premium et accepte **5 utilisateurs maximum**. Chacun doit être ajouté dans le tableau de bord développeur. On ne peut lire le contenu que de ses **propres** playlists (ou collaboratives), et la recherche renvoie 10 résultats par page (« Plus de résultats » charge la suite).
- **Deezer** n'accepte plus de nouvelles applis développeur. Spotihome lit donc seulement ce que ton profil expose publiquement. Vérifie la confidentialité de tes playlists si elles n'apparaissent pas.
- **YouTube Music** n'a pas d'API officielle. Si YouTube change son site, la recherche ou la lecture peuvent casser temporairement. yt-dlp est mis à jour automatiquement chaque jour.
- La lecture Spotify dans le navigateur exige **HTTPS** (protection DRM). L'installation génère un certificat auto-signé.

## Installation sur un conteneur LXC (Ubuntu ou Debian)

En root dans le conteneur :

```bash
curl -fsSL https://raw.githubusercontent.com/xenix13/spotihome/main/deploy/install.sh | bash
```

Le script installe Node.js 22, yt-dlp (avec Deno, dont yt-dlp a besoin pour YouTube), le code dans `/opt/spotihome`, un certificat HTTPS auto-signé, le fichier `.env` avec un secret aléatoire, et le service systemd `spotihome`.

Ouvre ensuite `https://IP-DU-CONTENEUR:8443`, accepte l'avertissement du certificat, puis crée le compte administrateur. Tu peux ajouter les autres membres du foyer depuis **Réglages → Comptes du foyer**.

**Mise à jour** : relance la même commande. Ton `.env` et tes données sont conservés.

### Relier Spotify

1. Sur <https://developer.spotify.com/dashboard>, crée une appli en cochant **Web API** et **Web Playback SDK**.
2. Ajoute l'URI de redirection `https://IP-DU-CONTENEUR:8443/api/spotify/callback`. Elle doit correspondre exactement à `PUBLIC_URL` dans `.env`, suivi de `/api/spotify/callback`.
3. Dans **User Management**, ajoute l'adresse e-mail Spotify de chaque membre du foyer.
4. Renseigne `SPOTIFY_CLIENT_ID` et `SPOTIFY_CLIENT_SECRET` dans `/opt/spotihome/.env`, puis lance `systemctl restart spotihome`.
5. Dans Spotihome : **Réglages → Relier mon compte Spotify**.

### Relier Deezer

Dans **Réglages**, colle le lien de ton profil Deezer (par exemple `https://www.deezer.com/fr/profile/123456789`).

### Relier YouTube Music

La recherche et la lecture marchent sans compte. Pour retrouver ta bibliothèque (playlists, titres « J'aime ») :

1. Ouvre music.youtube.com en étant connecté, puis les outils de développement (F12), onglet Réseau.
2. Clique une requête `browse` et copie la valeur de l'en-tête de requête `cookie`.
3. Colle-la dans **Réglages → YouTube Music**.

Le cookie est chiffré sur le serveur (AES-256-GCM, avec la clé dérivée de `APP_SECRET`). Tu peux aussi ajouter une playlist publique par son lien depuis **Bibliothèque**, sans compte.

## Configuration (`.env`)

| Variable | Rôle |
|---|---|
| `APP_SECRET` | Clé de chiffrement des jetons et cookies enregistrés (générée par l'installation) |
| `PUBLIC_URL` | Adresse utilisée dans le navigateur ; sert à l'URI de redirection Spotify |
| `PORT`, `HOST` | Écoute (8443 sur toutes les interfaces par défaut) |
| `TLS_CERT`, `TLS_KEY` | Certificat HTTPS. Vide = HTTP simple (derrière un reverse proxy HTTPS par exemple) |
| `ALLOW_SIGNUP` | `first` (seul le premier compte s'inscrit), `yes` ou `no` |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Identifiants de l'appli Spotify |
| `MARKET`, `LANG_UI` | Pays du catalogue et langue des résultats (`FR`, `fr`) |
| `YTDLP_BIN`, `YTDLP_EXTRA_ARGS`, `YTDLP_COOKIES_FILE` | Réglages de yt-dlp (par exemple `--js-runtimes node` si tu préfères Node à Deno) |

Derrière un reverse proxy (Nginx Proxy Manager, Caddy…) avec un vrai certificat, vide `TLS_CERT` et `TLS_KEY` et mets `PUBLIC_URL=https://musique.mondomaine.fr`.

## Développement

```bash
cp .env.example .env      # renseigne au moins APP_SECRET, vide TLS_CERT/TLS_KEY
npm run dev               # http://127.0.0.1:8443
npm test                  # tests unitaires et de bout en bout (services simulés)
```

Organisation :

```
server/
  app.js              routes de l'API, sessions, fichiers statiques
  providers/          spotify.js, deezer.js, ytmusic.js, ytdlp.js
  match.js            correspondance d'un titre vers YouTube Music
  store.js            base JSON (data/spotihome.json), écriture atomique
public/               interface (JS sans build) : app.js, player.js, ui.js
deploy/               install.sh et services systemd
```

## Pistes pour la suite

- Une petite API de pilotage (lecture, pause, titre suivant) pour Home Assistant.
- Les paroles synchronisées.
- La lecture en continu basée sur des recommandations.
