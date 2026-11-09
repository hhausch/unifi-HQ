#!/usr/bin/env bash
# Lagezentrum – Update eines mit create-lxc.sh angelegten Containers
#
# Auf dem Proxmox-Host als root:
#   cd /root/unifi-HQ && git pull
#   ./proxmox/update-lxc.sh <CTID>        (ohne CTID: sucht den CT mit Hostname "lagezentrum")
#
# Kopiert den aktuellen Stand nach /opt/lagezentrum im Container und baut/startet neu.
# Deine Einstellungen bleiben unangetastet: .env (inkl. Login-Passwort), config/hosts.csv, GeoIP-Daten, Historie.
set -euo pipefail

ok() { printf '\033[32m✔\033[0m %s\n' "$*"; }
die() { printf '\033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Bitte als root auf dem Proxmox-Host ausführen"
command -v pct >/dev/null || die "pct fehlt – das hier ist kein Proxmox-Host"

CTID="${1:-${CTID:-}}"
if [ -z "$CTID" ]; then
  CTID=$(pct list | awk 'NR>1 && $NF=="lagezentrum" {print $1; exit}')
  [ -n "$CTID" ] || die "Kein CT mit Hostname 'lagezentrum' gefunden – CTID angeben: $0 <CTID>"
fi
pct status "$CTID" | grep -q running || die "CT $CTID läuft nicht (pct start $CTID)"
pct exec "$CTID" -- test -f /opt/lagezentrum/docker-compose.yml || die "In CT $CTID gibt es kein /opt/lagezentrum"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$here/docker-compose.yml" ] || die "Skript muss aus dem Repo heraus laufen"
if [ -d "$here/.git" ]; then
  echo "Stand: $(git -C "$here" log -1 --format='%h %s' 2>/dev/null)"
fi

tmp=$(mktemp --suffix=.tar.gz)
trap 'rm -f "$tmp"' EXIT
tar -C "$here" --exclude=.git --exclude=./.env --exclude=./config/hosts.csv \
  --exclude='./geoip/*.mmdb' --exclude='./caddy/auth/*.caddy' -czf "$tmp" .
pct push "$CTID" "$tmp" /root/lagezentrum-update.tar.gz
pct exec "$CTID" -- tar -xzf /root/lagezentrum-update.tar.gz -C /opt/lagezentrum
pct exec "$CTID" -- rm -f /root/lagezentrum-update.tar.gz
ok "Dateien in CT $CTID aktualisiert"

echo "Baue und starte neu …"
pct exec "$CTID" -- bash -c 'cd /opt/lagezentrum && ./lagezentrum.sh ensure-tls-domain'
pct exec "$CTID" -- bash -c 'cd /opt/lagezentrum && chmod +x lagezentrum.sh install.sh scripts/*.sh && docker compose up -d --build --remove-orphans 2>&1 | grep -vE "^ *(=>|#)" | tail -5 && docker compose restart collector caddy >/dev/null'
pct exec "$CTID" -- bash -c 'cd /opt/lagezentrum && ./lagezentrum.sh test' || true
if ! pct exec "$CTID" -- grep -qE '^AUTH_PASSWORD_HASH=.+' /opt/lagezentrum/.env; then
  if pct exec "$CTID" -- grep -qE '^AUTH_REQUIRED=false$' /opt/lagezentrum/.env; then
    printf '\033[33m!\033[0m %s\n' "Login ist explizit deaktiviert."
  else
    printf '\033[33m!\033[0m %s\n' "Dashboard bleibt ohne Login-Passwort gesperrt. Setzen: pct enter $CTID, dann /opt/lagezentrum/lagezentrum.sh password"
  fi
fi
ok "Fertig. Im Browser einmal neu laden (Strg+F5)."
