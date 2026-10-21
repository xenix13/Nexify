#!/usr/bin/env bash
# Installation / mise à jour de Spotihome sur Ubuntu ou Debian (conteneur LXC ou VM), en root.
#   curl -fsSL https://raw.githubusercontent.com/xenix13/spotihome/main/deploy/install.sh | bash
# Relancer le script met à jour Spotihome (git pull) et yt-dlp, sans toucher au fichier .env.
set -euo pipefail

REPO="${SPOTIHOME_REPO:-https://github.com/xenix13/spotihome.git}"
BRANCH="${SPOTIHOME_BRANCH:-main}"
APP_DIR="${SPOTIHOME_DIR:-/opt/spotihome}"
PORT="${SPOTIHOME_PORT:-8443}"
SVC_USER=spotihome

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Lance ce script en root (sudo)."; exit 1; }

case "$(uname -m)" in
  x86_64) YTDLP_ASSET=yt-dlp_linux; DENO_ARCH=x86_64-unknown-linux-gnu ;;
  aarch64|arm64) YTDLP_ASSET=yt-dlp_linux_aarch64; DENO_ARCH=aarch64-unknown-linux-gnu ;;
  *) echo "Architecture $(uname -m) non prise en charge par ce script."; exit 1 ;;
esac

say "Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git openssl unzip >/dev/null

NODE_MAJOR=0
command -v node >/dev/null && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  say "Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node.js $(node -v)"

say "yt-dlp (lecture YouTube Music)"
curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}" -o /usr/local/bin/yt-dlp.new
chmod 755 /usr/local/bin/yt-dlp.new && mv /usr/local/bin/yt-dlp.new /usr/local/bin/yt-dlp
echo "yt-dlp $(/usr/local/bin/yt-dlp --version)"

# yt-dlp a besoin d'un moteur JavaScript pour YouTube ; Deno est celui qu'il utilise par défaut
if ! command -v deno >/dev/null; then
  say "Deno (moteur JavaScript pour yt-dlp)"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/denoland/deno/releases/latest/download/deno-${DENO_ARCH}.zip" -o "$tmp/deno.zip"
  unzip -q -o "$tmp/deno.zip" -d /usr/local/bin && chmod 755 /usr/local/bin/deno
  rm -rf "$tmp"
fi

say "Code de Spotihome dans $APP_DIR"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SVC_USER"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  mkdir -p "$APP_DIR"
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR.tmp"
  cp -a "$APP_DIR.tmp/." "$APP_DIR/" && rm -rf "$APP_DIR.tmp"
fi
git config --global --add safe.directory "$APP_DIR" || true

if [ ! -f "$APP_DIR/public/fonts/archivo.ttf" ]; then
  say "Police Archivo (facultative)"
  mkdir -p "$APP_DIR/public/fonts"
  curl -fsSL "https://raw.githubusercontent.com/google/fonts/main/ofl/archivo/Archivo%5Bwdth%2Cwght%5D.ttf" -o "$APP_DIR/public/fonts/archivo.ttf" \
    || echo "Police non téléchargée, l'interface utilisera les polices du système."
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
IP="${IP:-127.0.0.1}"

mkdir -p "$APP_DIR/data" "$APP_DIR/certs"
if [ ! -f "$APP_DIR/certs/spotihome.crt" ]; then
  say "Certificat HTTPS auto-signé pour $IP"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$APP_DIR/certs/spotihome.key" -out "$APP_DIR/certs/spotihome.crt" \
    -subj "/CN=spotihome" -addext "subjectAltName=IP:${IP},DNS:spotihome,DNS:localhost" 2>/dev/null
fi

if [ ! -f "$APP_DIR/.env" ]; then
  say "Fichier de configuration .env"
  sed \
    -e "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -hex 32)|" \
    -e "s|^PORT=.*|PORT=${PORT}|" \
    -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://${IP}:${PORT}|" \
    -e "s|^TLS_CERT=.*|TLS_CERT=${APP_DIR}/certs/spotihome.crt|" \
    -e "s|^TLS_KEY=.*|TLS_KEY=${APP_DIR}/certs/spotihome.key|" \
    -e "s|^DATA_DIR=.*|DATA_DIR=${APP_DIR}/data|" \
    "$APP_DIR/.env.example" > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"

say "Service systemd"
sed "s|/opt/spotihome|${APP_DIR}|g" "$APP_DIR/deploy/spotihome.service" > /etc/systemd/system/spotihome.service
cp "$APP_DIR/deploy/spotihome-ytdlp-update.service" "$APP_DIR/deploy/spotihome-ytdlp-update.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now spotihome-ytdlp-update.timer >/dev/null
systemctl enable spotihome >/dev/null
systemctl restart spotihome
sleep 2
systemctl --no-pager --lines=5 status spotihome || true

PUBLIC_URL="$(grep -E '^PUBLIC_URL=' "$APP_DIR/.env" | cut -d= -f2-)"
cat <<EOF

Spotihome tourne : ${PUBLIC_URL}
  (certificat auto-signé : accepte l'avertissement du navigateur la première fois)

Pour Spotify : crée une appli sur https://developer.spotify.com/dashboard,
ajoute l'URI de redirection ${PUBLIC_URL}/api/spotify/callback,
puis renseigne SPOTIFY_CLIENT_ID et SPOTIFY_CLIENT_SECRET dans ${APP_DIR}/.env
et lance : systemctl restart spotihome
EOF
