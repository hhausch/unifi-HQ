#!/usr/bin/env bash
# Lagezentrum – LXC auf dem Proxmox-Host anlegen und darin installieren
#
# Auf dem Proxmox-Host als root ausführen, am besten aus einem Klon des Repos:
#   git clone https://github.com/hhausch/unifi-HQ.git /root/unifi-HQ
#   /root/unifi-HQ/proxmox/create-lxc.sh
#
# Das Skript fasst keine Platten an. Den Storage für die Spare-SSD vorher einmal anlegen:
#   Node -> Disks -> LVM-Thin -> Create: Thinpool, Name "ssd-logs"
#
# Optionen (Umgebungsvariablen):
#   CTID=120            Container-ID              (Standard: nächste freie)
#   STORAGE=ssd-logs    Storage für die Root-Disk (Standard: ssd-logs)
#   DISK=32             Größe in GB
#   CORES=2 RAM=1536 SWAP=512
#   BRIDGE=vmbr0  VLAN=  (VLAN-Tag, leer = keiner)
#   IP=dhcp             oder z. B. IP=10.37.10.50/24 GW=10.37.10.1
#   CT_HOSTNAME=lagezentrum
#   TEMPLATE_STORAGE=local
#   Weitergereicht an das Setup im Container (dann wird dort nicht gefragt):
#   ALLOWED_SENDERS WAN_IP LOCAL_EXTRA_NETS HOME_LAT HOME_LON HOME_LABEL GATEWAY_NAME LOCAL_SERVER_PORTS
set -euo pipefail

ok() { printf '\033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Bitte als root auf dem Proxmox-Host ausführen"
command -v pct >/dev/null || die "pct fehlt – das hier ist kein Proxmox-Host"

STORAGE="${STORAGE:-ssd-logs}"
DISK="${DISK:-32}"
CORES="${CORES:-2}"
RAM="${RAM:-1536}"
SWAP="${SWAP:-512}"
BRIDGE="${BRIDGE:-vmbr0}"
VLAN="${VLAN:-}"
IP="${IP:-dhcp}"
GW="${GW:-}"
CT_HOSTNAME="${CT_HOSTNAME:-lagezentrum}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
CTID="${CTID:-$(pvesh get /cluster/nextid)}"

pct status "$CTID" >/dev/null 2>&1 && die "CT $CTID existiert schon (CTID=… setzen)"
pvesm status -storage "$STORAGE" >/dev/null 2>&1 \
  || die "Storage '$STORAGE' gibt es nicht. Erst anlegen (Node -> Disks -> LVM-Thin) oder STORAGE=… setzen. Vorhanden: $(pvesm status | awk 'NR>1{print $1}' | tr '\n' ' ')"

# --- Template ---------------------------------------------------------------
echo "Suche Debian-Template …"
pveam update >/dev/null 2>&1 || warn "pveam update fehlgeschlagen, nutze bekannte Liste"
# Nur Templates für die Architektur des Hosts (Proxmox listet auch arm64-Templates)
ARCH=$(dpkg --print-architecture 2>/dev/null || echo amd64)
TEMPLATE=""
for v in 13 12; do
  TEMPLATE=$(pveam available --section system 2>/dev/null \
    | awk -v v="debian-$v-standard" -v a="_${ARCH}.tar" '$2 ~ "^"v && index($2, a) {print $2}' | sort -V | tail -1)
  [ -n "$TEMPLATE" ] && break
done
[ -n "$TEMPLATE" ] || die "Kein Debian-Template für $ARCH gefunden (pveam available --section system)"
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  echo "Lade $TEMPLATE …"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null
fi
ok "Template $TEMPLATE"

# --- Container --------------------------------------------------------------
net="name=eth0,bridge=$BRIDGE,ip=$IP"
[ -n "$GW" ] && net+=",gw=$GW"
[ -n "$VLAN" ] && net+=",tag=$VLAN"
[ "$IP" = dhcp ] && net+=",ip6=auto"

echo "Lege CT $CTID ($CT_HOSTNAME) auf $STORAGE an …"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --cores "$CORES" --memory "$RAM" --swap "$SWAP" \
  --rootfs "$STORAGE:$DISK" \
  --net0 "$net" \
  --onboot 1 \
  --timezone host \
  --description "Lagezentrum – Live-Weltkarte für UniFi-Flows" >/dev/null
pct start "$CTID" || die "CT $CTID startet nicht. Aufräumen mit: pct destroy $CTID – Details: pct start $CTID --debug"
ok "CT $CTID läuft"

echo "Warte auf Netzwerk im Container …"
for _ in $(seq 1 60); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 || die "Container hat kein Internet (DNS/Gateway prüfen)"

# --- Projekt in den Container bringen ---------------------------------------
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
envs=()
for k in ALLOWED_SENDERS WAN_IP LOCAL_EXTRA_NETS HOME_LAT HOME_LON HOME_LABEL GATEWAY_NAME LOCAL_SERVER_PORTS REPO_URL REPO_BRANCH; do
  [ -n "${!k:-}" ] && envs+=("$k=${!k}")
done

if [ -f "$here/docker-compose.yml" ] && [ -f "$here/install.sh" ]; then
  # Lokalen Stand kopieren – funktioniert auch bei privatem Repo ohne Zugangsdaten im Container
  tmp=$(mktemp --suffix=.tar.gz)
  tar -C "$here" --exclude=.git --exclude=./.env --exclude=./config/hosts.csv --exclude='./geoip/*.mmdb' --exclude='./caddy/auth/*.caddy' -czf "$tmp" .
  pct exec "$CTID" -- mkdir -p /opt/lagezentrum
  pct push "$CTID" "$tmp" /root/lagezentrum.tar.gz
  rm -f "$tmp"
  pct exec "$CTID" -- tar -xzf /root/lagezentrum.tar.gz -C /opt/lagezentrum
  pct exec "$CTID" -- rm -f /root/lagezentrum.tar.gz
  ok "Projekt nach /opt/lagezentrum kopiert"
  run=(bash /opt/lagezentrum/install.sh)
else
  pct exec "$CTID" -- bash -c 'apt-get update -qq && apt-get install -y -qq curl ca-certificates git >/dev/null'
  run=(bash -c "git clone -q \"${REPO_URL:-https://github.com/hhausch/unifi-HQ.git}\" /opt/lagezentrum && bash /opt/lagezentrum/install.sh")
fi

echo "Starte Installation im Container (Docker, GeoIP, Container) – dauert ein paar Minuten …"
# Mit Terminal: interaktive Fragen im Setup. Ohne: Werte aus der Umgebung bzw. Vorlage.
if [ -t 0 ] && [ ${#envs[@]} -eq 0 ]; then
  pct exec "$CTID" -- env TERM="${TERM:-xterm}" "${run[@]}"
else
  pct exec "$CTID" -- env LZ_NONINTERACTIVE=1 "${envs[@]}" "${run[@]}"
fi

ip=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')
echo
ok "Fertig: CT $CTID ($CT_HOSTNAME), IP ${ip:-?}"
echo "  Dashboard:  http://${ip:-<IP>}:8080        Demo: http://${ip:-<IP>}:8080/?demo"
echo "  UniFi:      NetFlow/IPFIX -> ${ip:-<IP>}:2055    Syslog (SIEM) -> ${ip:-<IP>}:5514"
echo "  Feste IP:   im UniFi eine DHCP-Reservierung für $CT_HOSTNAME anlegen (oder IP=… nutzen)"
echo "  Verwalten:  pct enter $CTID   dann   cd /opt/lagezentrum && ./lagezentrum.sh status"
