#!/usr/bin/env bash
# Lagezentrum – Verwaltung
#   ./lagezentrum.sh setup        Ersteinrichtung: Konfig anlegen, GeoIP laden, Cron, Start
#   ./lagezentrum.sh test         Selbsttest: Test-Flow + Test-Syslog schicken und prüfen
#   ./lagezentrum.sh status       Container, Datenmenge, Ereignisse der letzten Stunde
#   ./lagezentrum.sh geoip        GeoIP-Datenbanken jetzt aktualisieren (läuft monatlich per Cron)
#   ./lagezentrum.sh password     Login-Passwort setzen   (password logout = alle abmelden, password off = Login aus)
#   ./lagezentrum.sh update       Images aktualisieren und neu starten
#   ./lagezentrum.sh logs         Logs aller Container verfolgen
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
DIR=$(pwd)

c_ok() { printf '\033[32m✔\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
c_err() { printf '\033[31m✘\033[0m %s\n' "$*" >&2; }
die() { c_err "$*"; exit 1; }

need_docker() {
  command -v docker >/dev/null || die "Docker fehlt. Installation: curl -fsSL https://get.docker.com | sh"
  docker compose version >/dev/null 2>&1 || die "docker compose (v2) fehlt."
}
env_get() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }
env_set() {
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
gen_secret() { head -c 32 /dev/urandom | od -An -vtx1 | tr -d ' \n'; }
ensure_secret() {
  if [ -z "$(env_get AUTH_SECRET)" ]; then env_set AUTH_SECRET "$(gen_secret)"; c_ok "Schlüssel für Login-Sitzungen angelegt (AUTH_SECRET)"; fi
}
lxc_ip() { hostname -I 2>/dev/null | awk '{print $1}'; }
ensure_tls_domain() {
  [ -f .env ] || return 0
  [ -n "$(env_get TLS_DOMAIN)" ] && return 0
  local domain; domain=$(lxc_ip)
  [ -n "$domain" ] || die "TLS_DOMAIN konnte nicht erkannt werden. Bitte eine erreichbare IP oder einen DNS-Namen in .env setzen."
  env_set TLS_DOMAIN "$domain"
  c_ok "TLS_DOMAIN=$domain gesetzt"
}
vlq() { curl -fsS --max-time 10 http://127.0.0.1:9428/select/logsql/query --data-urlencode "query=$1"; }

# Einstellungen, die setup aus der Umgebung übernimmt (z. B. von install.sh / create-lxc.sh)
SETUP_KEYS="WAN_IP LOCAL_EXTRA_NETS ALLOWED_SENDERS LOCAL_SERVER_PORTS IGNORE_IPS HTTP_PORT HTTPS_PORT TLS_DOMAIN ALLOWED_CLIENTS HOME_LAT HOME_LON HOME_LABEL GATEWAY_NAME RETENTION MAX_DISK TZ"

GIVEN=" "
ask() {  # ask KEY "Frage" "Vorschlag"  -> setzt KEY in der .env (nur interaktiv)
  local key=$1 q=$2 def=$3 ans
  [[ "$GIVEN" == *" $key "* ]] && return 0    # per Umgebung vorgegeben
  read -rp "  $q [${def}]: " ans </dev/tty || ans=""
  ans=${ans:-$def}
  [ "$ans" = "-" ] && ans=""
  env_set "$key" "$ans"
}

cmd_setup() {
  need_docker
  local fresh=0
  if [ ! -f .env ]; then
    cp .env.example .env
    fresh=1
    c_ok ".env aus .env.example angelegt"
  fi

  # Werte aus der Umgebung übernehmen (z. B. ALLOWED_SENDERS=10.37.10.1 ./lagezentrum.sh setup)
  local k
  for k in $SETUP_KEYS; do
    if [ -n "${!k+x}" ] && [ -n "${!k}" ]; then env_set "$k" "${!k}"; GIVEN+="$k "; c_ok "$k=${!k} übernommen"; fi
  done
  ensure_tls_domain

  if [ -z "$(env_get WAN_IP)" ]; then
    wan=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
    if [[ "$wan" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      env_set WAN_IP "$wan"; c_ok "WAN_IP=$wan eingetragen (öffentliche IP dieses Anschlusses)"
    else
      c_warn "Öffentliche IP nicht ermittelbar – WAN_IP in .env bitte selbst setzen"
    fi
  fi

  # Interaktiv nachfragen, wenn die .env neu ist und ein Terminal da ist
  if [ "$fresh" = 1 ] && [ -z "${LZ_NONINTERACTIVE:-}" ] && { : </dev/tty; } 2>/dev/null; then
    local gw; gw=$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')
    echo
    echo "Ein paar Fragen (Enter = Vorschlag übernehmen, - = leer lassen):"
    ask WAN_IP "Öffentliche IPv4 des Gateways" "$(env_get WAN_IP)"
    ask ALLOWED_SENDERS "IP des Gateways, das NetFlow/Syslog schickt" "${gw:--}"
    ask GATEWAY_NAME "Name des Gateways" "$(env_get GATEWAY_NAME)"
    ask HOME_LABEL "Standort (Beschriftung auf dem Globus)" "$(env_get HOME_LABEL)"
    ask HOME_LAT "Breitengrad" "$(env_get HOME_LAT)"
    ask HOME_LON "Längengrad" "$(env_get HOME_LON)"
    ask LOCAL_EXTRA_NETS "Eigenes IPv6-Präfix, z. B. 2003:ab:cd00::/56" "$(env_get LOCAL_EXTRA_NETS | grep . || echo -)"
    ask LOCAL_SERVER_PORTS "Von außen erreichbare Ports (VPN, Freigaben)" "$(env_get LOCAL_SERVER_PORTS)"
    echo
  fi

  if [ ! -f config/hosts.csv ]; then
    cp config/hosts.example.csv config/hosts.csv
    c_ok "config/hosts.csv angelegt – trag dort deine Geräte ein (IP,Name)"
  fi
  ensure_secret
  chmod 600 .env
  chmod 644 config/hosts.csv collector/vector.yaml caddy/Caddyfile
  mkdir -p geoip caddy/auth

  # Monatliches GeoIP-Update (3. des Monats, 04:17)
  if [ -d /etc/cron.d ] && [ "$(id -u)" = 0 ]; then
    cat > /etc/cron.d/lagezentrum <<EOF
# Lagezentrum: GeoIP-Datenbanken monatlich aktualisieren
17 4 3 * * root $DIR/lagezentrum.sh geoip >/dev/null 2>&1
EOF
    c_ok "Cron für monatliches GeoIP-Update eingerichtet (/etc/cron.d/lagezentrum)"
    command -v cron >/dev/null || c_warn "cron ist nicht installiert: apt -y install cron"
  else
    c_warn "Cron nicht eingerichtet (kein root oder kein /etc/cron.d). Monatlich: ./lagezentrum.sh geoip"
  fi

  echo "Baue und starte die Container (erster Start lädt ~140 MB GeoIP-Daten) …"
  docker compose build
  if ! docker compose up -d; then
    echo; docker compose logs --no-log-prefix geoip 2>/dev/null | tail -5
    die "Start fehlgeschlagen. Steht oben „geoip: FEHLER“, hat der LXC kein Internet (DNS/Gateway prüfen), danach erneut: ./lagezentrum.sh setup"
  fi
  sleep 3
  docker compose ps
  if [ -z "$(env_get AUTH_PASSWORD_HASH)" ] && [ "$(env_get AUTH_REQUIRED || echo true)" != "false" ]; then
    local yn=n
    if [ -z "${LZ_NONINTERACTIVE:-}" ] && { : </dev/tty; } 2>/dev/null; then
      echo
      read -rp "Login-Passwort fürs Dashboard jetzt setzen? [J/n]: " yn </dev/tty || yn=n
      yn=${yn:-j}
    fi
    if [[ "$yn" =~ ^[JjYy] ]]; then
      ( cmd_password ) </dev/tty || c_warn "Passwort nicht gesetzt – später: ./lagezentrum.sh password"
    else
      c_warn "Kein Login-Passwort gesetzt – Dashboard bleibt gesperrt. Setzen: ./lagezentrum.sh password"
    fi
  elif [ -z "$(env_get AUTH_PASSWORD_HASH)" ]; then
    c_warn "Login ist explizit deaktiviert – jeder erlaubte LAN-Client kann das Dashboard öffnen."
  fi
  local ip; ip=$(lxc_ip)
  local https_port; https_port=$(env_get HTTPS_PORT); https_port=${https_port:-8443}
  echo
  c_ok "Fertig. Dashboard: https://$(env_get TLS_DOMAIN):${https_port}   HTTP: http://$(env_get TLS_DOMAIN):$(env_get HTTP_PORT)"
  c_warn "Für HTTPS direkt: Caddys internes Zertifikat auf den Geräten vertrauen. Für Reverse Proxy: HTTP-Port nur im vertrauenswürdigen Netz verwenden."
  echo "  Im UniFi eintragen:  NetFlow/IPFIX -> ${ip:-<LXC-IP>}:2055   Syslog (SIEM) -> ${ip:-<LXC-IP>}:5514"
  echo "  Danach: ./lagezentrum.sh test"
}

cmd_test() {
  need_docker
  ensure_tls_domain
  docker compose ps --status running --services | grep -qx collector || die "Collector läuft nicht (docker compose up -d)"
  local marker; marker=$(date +%s)
  # IPFIX-Paket mit aktueller Exportzeit: Template + 1 Flow 10.37.10.250:40000 -> 9.9.9.9:443 TCP (4242 Bytes)
  local hex tmp
  hex="000a0055$(printf '%08x' "$(date +%s)")0000000000001092"
  hex+="000200240100000700080004000c000400070002000b0002000400010001000800020008"
  hex+="010000210a250afa090909099c4001bb0600000000000010920000000000000007"
  tmp=$(mktemp)
  printf "$(echo "$hex" | sed 's/../\\x&/g')" > "$tmp"
  cat "$tmp" > /dev/udp/127.0.0.1/2055      # ein write() = ein Datagramm
  rm -f "$tmp"
  # Syslog im UniFi-Format: geblockter SSH-Versuch von scanme.nmap.org
  printf '<4>%s QuantumGateway kernel: [WAN_LOCAL-B-99999] DESCR="Lagezentrum Selbsttest %s" IN=eth4 OUT= SRC=45.33.32.156 DST=%s PROTO=TCP SPT=40000 DPT=22' \
    "$(LC_ALL=C date '+%b %e %H:%M:%S')" "$marker" "$(env_get WAN_IP | cut -d, -f1 | grep . || echo 203.0.113.1)" > /dev/udp/127.0.0.1/5514
  echo "Testpakete gesendet, warte auf VictoriaLogs …"
  local flow=0 blk=0
  for _ in $(seq 1 15); do
    sleep 1
    flow=$(vlq '_time:2m remote_ip:"9.9.9.9" local_ip:"10.37.10.250" | stats count() n' 2>/dev/null | grep -o '"n":"[0-9]*"' | grep -o '[0-9]*' || echo 0)
    blk=$(vlq "_time:5m dir:blocked rule:\"Selbsttest $marker\" | stats count() n" 2>/dev/null | grep -o '"n":"[0-9]*"' | grep -o '[0-9]*' || echo 0)
    [ "${flow:-0}" -gt 0 ] && [ "${blk:-0}" -gt 0 ] && break
  done
  [ "${flow:-0}" -gt 0 ] && c_ok "NetFlow-Pfad: GoFlow2 -> Vector -> VictoriaLogs funktioniert" || c_err "NetFlow-Testflow nicht angekommen (docker compose logs collector)"
  [ "${blk:-0}" -gt 0 ] && c_ok "Syslog-Pfad: Vector -> VictoriaLogs funktioniert" || c_err "Syslog-Test nicht angekommen (docker compose logs collector)"
  local geo; geo=$(vlq "_time:5m dir:blocked rule:\"Selbsttest $marker\" | fields r_country" 2>/dev/null | head -1)
  [[ "$geo" == *'"US"'* ]] && c_ok "GeoIP funktioniert (45.33.32.156 -> US)" || c_warn "GeoIP-Zuordnung fehlt ($geo)"
  local domain https_port base_url
  domain=$(env_get TLS_DOMAIN)
  https_port=$(env_get HTTPS_PORT); https_port=${https_port:-8443}
  base_url="https://${domain}:${https_port}"
  local code; code=$(curl -k -s -o /dev/null -w '%{http_code}' "$base_url/" || true)
  if [ -n "$(env_get AUTH_PASSWORD_HASH)" ] || [ "$(env_get AUTH_REQUIRED)" != "false" ]; then
    local lcode; lcode=$(curl -k -s -o /dev/null -w '%{http_code}' "$base_url/login.html" || true)
    [ "$code" = 401 ] && [ "$lcode" = 200 ] && c_ok "HTTPS antwortet, Login erforderlich (ohne Anmeldung HTTP $code)" \
      || c_err "Dashboard/Login antwortet nicht wie erwartet (/: Status $code, /login.html: Status $lcode – docker compose logs api caddy)"
    if [ -z "$(env_get AUTH_PASSWORD_HASH)" ]; then
      c_warn "Noch kein Passwort gesetzt – Dashboard bleibt gesperrt. Setzen: ./lagezentrum.sh password"
    fi
  else
    [ "$code" = 200 ] && c_ok "HTTPS antwortet ohne Login (Status $code)" || c_err "Dashboard antwortet nicht (Status $code)"
    c_warn "Kein Login-Passwort gesetzt – jeder erlaubte LAN-Client kann das Dashboard öffnen (./lagezentrum.sh password)"
  fi
  echo "Hinweis: Der Testflow taucht als „raus 10.37.10.250 -> 9.9.9.9 (Quad9)“ in der Historie auf."
}

cmd_status() {
  need_docker
  docker compose ps
  echo
  docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' $(docker compose ps -q) 2>/dev/null || true
  echo
  local vol; vol=$(docker volume inspect -f '{{.Mountpoint}}' lagezentrum_vlogs-data 2>/dev/null || true)
  [ -n "$vol" ] && echo "Historie auf Disk: $(du -sh "$vol" 2>/dev/null | cut -f1)  ($vol)"
  echo "GeoIP: $(ls -l --time-style=+%Y-%m-%d geoip/*.mmdb 2>/dev/null | awk '{print $7, $6}' | tr '\n' ' ')"
  echo
  echo "Ereignisse der letzten Stunde:"
  vlq '_time:1h | stats by (dir) count() if (leg:req) as Verbindungen, sum(bytes) as Bytes' 2>/dev/null || c_warn "VictoriaLogs nicht erreichbar"
  echo
  echo "Letztes Ereignis je Quelle:"
  vlq '_time:24h | stats by (kind) max(_time) as zuletzt' 2>/dev/null || true
}

cmd_geoip() {
  need_docker
  docker compose run --rm -e GEOIP_MAX_AGE_DAYS=0 geoip
  if docker compose ps --status running --services | grep -qx collector; then
    docker compose restart collector >/dev/null && c_ok "Collector neu gestartet (neue GeoIP-Daten aktiv)"
  fi
}

# Login-Passwort: Hash (PBKDF2) und Sitzungs-Schlüssel landen in der .env, die API prüft sie
api_image() {  # immer bauen (geht dank Cache schnell): ein altes Image kennt hash-password nicht
  docker compose build api >/dev/null || die "API-Image konnte nicht gebaut werden (docker compose build api)"
}
apply_auth() {  # API mit neuer .env starten, Caddy neu laden
  ensure_tls_domain
  docker compose up -d api >/dev/null
  docker compose restart caddy >/dev/null; sleep 1
}
remove_basic_auth() {
  if [ -f caddy/auth/basic_auth.caddy ]; then
    rm -f caddy/auth/basic_auth.caddy
    c_ok "Altes Basic Auth (Browser-Passwortfenster) entfernt"
  fi
}

cmd_password() {
  need_docker
  [ -f .env ] || die ".env fehlt – erst ./lagezentrum.sh setup"
  case "${1:-}" in
    off)
      env_set AUTH_PASSWORD_HASH ""
      env_set AUTH_REQUIRED false
      remove_basic_auth
      apply_auth
      c_warn "Login ausgeschaltet – jeder im LAN sieht das Dashboard"
      return ;;
    logout)
      env_set AUTH_SECRET "$(gen_secret)"
      apply_auth
      c_ok "Alle Browser abgemeldet (neuer Sitzungs-Schlüssel)"
      return ;;
    ""|set) ;;
    *) die "Unbekannte Option: $1 (password | password logout | password off)" ;;
  esac
  local pw pw2
  IFS= read -rsp "Neues Passwort fürs Dashboard: " pw; echo
  IFS= read -rsp "Wiederholen: " pw2; echo
  [ "$pw" = "$pw2" ] || die "Passwörter stimmen nicht überein"
  [ ${#pw} -ge 10 ] || die "Bitte mindestens 10 Zeichen"
  api_image
  local hash
  hash=$(printf '%s\n' "$pw" | timeout 120 docker run --rm -i --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true lagezentrum-api:local hash-password 2>/dev/null | tail -1)
  [[ "$hash" == pbkdf2-sha256:* ]] || die "Hash konnte nicht erzeugt werden"
  umask 077
  env_set AUTH_PASSWORD_HASH "$hash"
  env_set AUTH_REQUIRED true
  ensure_secret
  chmod 600 .env
  remove_basic_auth
  apply_auth
  c_ok "Login aktiv. Bisherige Anmeldungen sind damit abgemeldet; der Browser bleibt danach 400 Tage angemeldet."
}

cmd_update() {
  need_docker
  ensure_tls_domain
  docker compose pull --ignore-buildable
  docker compose build --pull
  docker compose up -d
  docker image prune -f >/dev/null
  c_ok "Aktualisiert"
}

case "${1:-}" in
  setup) cmd_setup ;;
  test) cmd_test ;;
  status) cmd_status ;;
  geoip) cmd_geoip ;;
  password) shift; cmd_password "$@" ;;
  update) cmd_update ;;
  logs) need_docker; docker compose logs -f --tail 50 ;;
  ensure-tls-domain) ensure_tls_domain ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
