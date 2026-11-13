#!/bin/sh
# Lance Capsule Studio (macOS / Linux) et ouvre le navigateur. Ctrl+C arrête le serveur.
cd "$(dirname "$0")" || exit 1

# Node.js 22.12 ou plus récent requis
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js est introuvable. Installez Node 22 ou plus récent : https://nodejs.org"
  exit 1
fi

# Port lu dans .env (8746 par défaut)
PORT=8746
if [ -f .env ]; then
  P=$(grep -E '^PORT=' .env | head -n 1 | cut -d= -f2 | tr -d '\r')
  [ -n "$P" ] && PORT=$P
fi
URL="http://127.0.0.1:$PORT"

# Ouverture du navigateur deux secondes après le démarrage
( sleep 2; if command -v open >/dev/null 2>&1; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"; fi ) >/dev/null 2>&1 &
exec node server.js
