#!/usr/bin/env bash
# Lagezentrum – Installation in einem frischen Debian/Ubuntu-LXC (oder einer VM)
#
#   Aus einem geklonten Repo:   ./install.sh
#   Ohne Repo (öffentliches Repo oder mit Token in REPO_URL):
#     curl -fsSL https://raw.githubusercontent.com/hhausch/unifi-HQ/main/install.sh | bash
#
# Was passiert:
#   1. Pakete (curl, git, cron, …) und Docker installieren, falls nötig
#   2. Projekt nach $LZ_DIR (Standard /opt/lagezentrum) holen bzw. aktualisieren
#   3. ./lagezentrum.sh setup: .env anlegen (fragt nach), GeoIP laden, Cron, Start
#   4. ./lagezentrum.sh test: Selbsttest
#
# Einstellungen lassen sich vorab per Umgebung setzen, dann wird nicht gefragt, z. B.:
#   ALLOWED_SENDERS=10.37.10.1 HOME_LABEL=Frankfurt LZ_NONINTERACTIVE=1 ./install.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/hhausch/unifi-HQ.git}"
REPO_BRANCH="${REPO_BRANCH:-}"
LZ_DIR="${LZ_DIR:-/opt/lagezentrum}"

ok() { printf '\033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Bitte als root ausführen (sudo ./install.sh)"
command -v apt-get >/dev/null || die "Nur für Debian/Ubuntu gedacht (apt-get fehlt)"

# --- 1. Pakete ------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
missing=()
for p in curl git cron ca-certificates iproute2; do
  dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Installiere: ${missing[*]}"
  apt-get update -qq
  apt-get install -y -qq "${missing[@]}" >/dev/null
fi
systemctl enable --now cron >/dev/null 2>&1 || true
ok "Pakete vorhanden"

if ! command -v docker >/dev/null; then
  echo "Installiere Docker (get.docker.com) …"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
docker compose version >/dev/null 2>&1 || die "docker compose (v2) fehlt nach der Installation"
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die "Docker läuft nicht. Im Proxmox-LXC müssen die Features nesting und keyctl an sein."
ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null) läuft"

# --- 2. Projekt -----------------------------------------------------------
here=""
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ]; then here="$(cd "$(dirname "$src")" && pwd)"; fi   # bei curl | bash leer
if [ -n "$here" ] && [ -f "$here/docker-compose.yml" ] && [ -f "$here/lagezentrum.sh" ]; then
  LZ_DIR="$here"
  ok "Nutze Projekt in $LZ_DIR"
elif [ -d "$LZ_DIR/.git" ]; then
  git -C "$LZ_DIR" pull --ff-only -q && ok "Projekt in $LZ_DIR aktualisiert" || warn "git pull fehlgeschlagen, nutze vorhandenen Stand"
else
  echo "Hole Projekt nach $LZ_DIR …"
  git clone -q ${REPO_BRANCH:+-b "$REPO_BRANCH"} "$REPO_URL" "$LZ_DIR" \
    || die "Clone fehlgeschlagen. Privates Repo? Dann REPO_URL=https://<token>@github.com/… setzen oder das Repo selbst klonen und ./install.sh darin starten."
  ok "Projekt geklont"
fi

# --- 3./4. Einrichten und testen -------------------------------------------
cd "$LZ_DIR"
chmod +x lagezentrum.sh scripts/*.sh 2>/dev/null || true
./lagezentrum.sh setup
echo
./lagezentrum.sh test || warn "Selbsttest nicht vollständig – siehe README, Abschnitt Fehlersuche"
