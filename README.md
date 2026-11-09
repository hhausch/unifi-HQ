# Lagezentrum

Live world map for your home network. Every connection through your UniFi gateway is drawn as an
arc over a 3D globe, next to a live ticker, 24 h stats and a searchable history.

![Globe view](docs/globe.png)

- **Default view:** allowed outbound (cyan) and inbound (green) connections
- **Optional:** blocked scans from the internet (red) and inter-VLAN traffic (purple)
- **LAN only, password login** (the browser stays signed in), one LXC, about 200–250 MB RAM

## Contents

1. [Architecture](#architecture)
2. [Proxmox storage](#1-proxmox-storage)
3. [Install](#2-install)
4. [UniFi setup](#3-unifi-setup)
5. [Test](#4-test)
6. [Usage](#usage)
7. [What UniFi exports](#what-unifi-exports)
8. [Operation](#operation)
9. [Security](#security)
10. [Resources](#resources)
11. [Troubleshooting](#troubleshooting)
12. [Files](#files)

## Architecture

```
UCG Max ──IPFIX  UDP 2055──▶ GoFlow2 ─┐  (child process of Vector, no Docker socket)
UCG Max ──Syslog UDP 5514──▶ Vector ◀─┘
                               │  direction · request/response pairing · GeoIP/ASN · device names
                               ├──▶ VictoriaLogs   127.0.0.1:9428   history (90 days / 20 GiB)
                               └──▶ WebSocket      127.0.0.1:8090   live stream
Browser ──HTTP 8080──▶ Caddy ──▶ dashboard · /ws (live) · /select (queries) · /api (names)   LAN only
                         │  session valid? (forward_auth)                        │
                         ▼                                                       │
                API 127.0.0.1:8092 ◀─────────────────────────────────────────────┘
                login · config/hosts.csv ──SIGHUP──▶ Vector reloads names
```

| Container | Job | RAM limit |
|---|---|---|
| `collector` | Vector 0.58 with built-in GoFlow2 2.2.7 | 384 MB |
| `victorialogs` | history, heavily compressed | 512 MB |
| `caddy` | web server, access control | 64 MB |
| `api` | login, saves device names from the dashboard (Go, ~5 MB) | 32 MB |
| `geoip` | one-shot job, downloads DB-IP Lite when needed | 128 MB |

All containers run with a read-only filesystem, no Linux capabilities (Caddy: only `NET_BIND_SERVICE`)
and `no-new-privileges`. Vector and GoFlow2 run as `nobody`.

**How direction is detected:** NetFlow reports each connection twice, request and response. The
pipeline pairs them (`leg=req` / `leg=resp`). The live view and counters only show the request; the
response still counts towards traffic volume (otherwise downloads would be missing). Across the WAN
boundary the local side is the client, unless its port is in `LOCAL_SERVER_PORTS` (e.g. WireGuard
51820) or is a classic server port below 1024, and the remote side isn't itself using a service port
(below 1024 or STUN/TURN). Otherwise a client that happens to pick 51820 as source port would show up
as inbound.

## 1. Proxmox storage

One-time, so logs never land on the system SSD:

1. Node → Disks: the disk must be listed as unused (otherwise *Wipe Disk*, which erases it).
2. Node → Disks → LVM-Thin → *Create: Thinpool*, pick the disk, name `ssd-logs`, keep *Add Storage* checked.

## 2. Install

### Option A: automatic (recommended)

On the **Proxmox host** as root. Set `VLAN` to the real ID (e.g. `VLAN=10`). That VLAN needs:

- reachable from the gateway VLAN
- internet access
- reachable from your client/trusted VLAN

```bash
apt -y install git
git clone https://github.com/hhausch/unifi-HQ.git /root/unifi-HQ
VLAN=xx /root/unifi-HQ/proxmox/create-lxc.sh
```

The script fetches the current Debian template, creates an unprivileged LXC on `ssd-logs` (2 cores,
1536 MB RAM max, 32 GB disk, `nesting` + `keyctl`, start on boot), copies the project in and runs
`install.sh`. It prints the IP and all URLs at the end. It doesn't touch any disks.

Values can also be passed as environment variables, e.g. static IP and gateway:

```bash
IP=10.37.10.50/24 GW=10.37.10.1 VLAN=10 ALLOWED_SENDERS=10.37.10.1 HOME_LABEL=Frankfurt \
  /root/unifi-HQ/proxmox/create-lxc.sh
```

More options: `CTID`, `STORAGE`, `DISK`, `CORES`, `RAM`, `SWAP`, `BRIDGE`, `CT_HOSTNAME` (see the script header).

### Option B: create the LXC yourself

1. *Create CT*: Debian 13, *Unprivileged* on, disk on `ssd-logs` (32 GB), 2 cores, 1536 MB RAM, 512 MB swap.
2. Container → Options → Features → enable `nesting` and `keyctl`, start it.
3. In the container console:

   ```bash
   apt update && apt -y install git
   git clone https://github.com/hhausch/unifi-HQ.git /opt/lagezentrum
   /opt/lagezentrum/install.sh
   ```

`install.sh` installs packages and Docker, sets everything up, asks for a few values (Enter accepts
the suggestion) and runs a self-test. The dashboard supports direct HTTPS with a Caddy-managed local
CA and HTTP for trusted networks or a TLS-terminating reverse proxy. The setup picks the LXC IP as its
certificate name. Without cloning:
`curl -fsSL https://raw.githubusercontent.com/hhausch/unifi-HQ/main/install.sh | bash`.

### Setup values

| Value | Meaning |
|---|---|
| `WAN_IP` | public IPv4, detected automatically |
| `TLS_DOMAIN` | dashboard IP or DNS name; setup defaults to the LXC IP |
| `HTTPS_PORT` | dashboard HTTPS port, default `8443` |
| `HTTP_PORT` | dashboard HTTP port, default `8080`; can be used as a TLS reverse-proxy upstream |
| `AUTH_COOKIE_SECURE` | set to `true` when a reverse proxy terminates TLS before forwarding HTTP to the dashboard |
| `ALLOWED_SENDERS` | IP of the gateway sending NetFlow/syslog (default: the LXC's default gateway) |
| `GATEWAY_NAME`, `HOME_LABEL`, `HOME_LAT`, `HOME_LON` | name and location on the globe |
| `LOCAL_EXTRA_NETS` | your IPv6 prefix, e.g. `2003:ab:cd00::/56`, otherwise your own IPv6 devices show up as foreign |
| `LOCAL_SERVER_PORTS` | ports reachable from outside (port forwards, VPN server), default `51820` |
| Login password | asked at the end of `setup` (min. 10 characters), stored only as a hash in `.env`; without one the dashboard stays locked |

Everything lives in `.env` and can be changed there (then `docker compose up -d`). Direct HTTPS is at
`https://<TLS_DOMAIN>:8443`, and HTTP is also available at `http://<TLS_DOMAIN>:8080`. Use HTTP only
on a trusted network or as the upstream of a reverse proxy that provides public HTTPS; do not expose
the HTTP port to untrusted networks. When a reverse proxy terminates TLS and forwards HTTP, set
`AUTH_COOKIE_SECURE=true` in `.env` so session cookies remain `Secure`, and ensure the proxy's source
address is allowed by `ALLOWED_CLIENTS`.

For direct HTTPS, Caddy uses a private local CA, so browsers must trust its root certificate. After
opening the HTTPS URL once, export the public root certificate from the LXC:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./lagezentrum-ca.crt
```

Install `lagezentrum-ca.crt` as a trusted root certificate on each device that uses the dashboard.
Keep the certificate private key inside Caddy's persistent Docker volume; never export that key.
If that volume is lost, Caddy creates a new CA and clients must trust its new root certificate.
If the LXC IP changes, update `TLS_DOMAIN` to the new IP and restart Caddy.

### Reverse proxy with TLS termination

To let another reverse proxy manage the public certificate, point it to the Lagezentrum HTTP
listener on port `8080`. For example, with Caddy on the proxy host:

```caddyfile
dashboard.example.com {
    reverse_proxy 10.37.10.50:8080
}
```

Replace the hostname and backend IP with yours. The proxy must terminate HTTPS, preserve the
original `Host` header (needed for login-origin checks), forward `X-Forwarded-Proto: https`, and
support WebSocket upgrades for `/ws` (Caddy's `reverse_proxy` does this automatically). Proxy the
whole site at its root; do not strip or rewrite paths such as `/api`, `/auth`, `/select` or `/ws`.

On the Lagezentrum host, configure `.env` to trust the proxy connection and keep cookies secure:

```dotenv
ALLOWED_CLIENTS=10.37.10.2
AUTH_COOKIE_SECURE=true
```

Use the reverse proxy's actual source IP for `ALLOWED_CLIENTS` (or its subnet if it can change).
Restart the API to apply the cookie setting:

```bash
docker compose up -d api
```

Keep port `8080` reachable only from the reverse proxy and other explicitly trusted clients; do
not expose it directly to the internet. This Caddyfile rejects requests containing
`Cf-Connecting-Ip`, so Cloudflare proxy/tunnel setups are not supported by this configuration.

Device names go
into `config/hosts.csv`, one per line: `10.37.10.3,homelable` (then `docker compose restart collector`).
`setup` also adds a monthly GeoIP update cron job. Re-running `./lagezentrum.sh setup` is safe.

## 3. UniFi setup

### A. NetFlow (all allowed connections)

Settings → CyberSecure → *Traffic Logging*:

- **NetFlow (IPFIX)** on, collector `<LXC-IP>`, port `2055`, version 10 (IPFIX)
- Select **all networks**, otherwise VLANs are missing
- Flow logging: *All traffic*
- Engine ID: automatic
- Timeout rate: 1 min
- Refresh rate: 20
- **Sampling mode: off** (sampling rate must be greyed out)

Ignore the performance warning. It only matters with 1000+ devices.

### B. Syslog for blocked traffic (optional)

Same page, *Activity Logging / SIEM Server*:

- Address `<LXC-IP>`, port `5514`
- Include at least the security detections

### C. Rule for scanners (optional)

Without it, scanners silently hit the built-in default rule and the red filter stays empty. The rule
doesn't change firewall behavior, it blocks what is blocked anyway and logs it.
Policy Engine → Zone-Based Firewall → *Create Policy*:

| Field | Value |
|---|---|
| Name | `Log scanners` |
| Source Zone | External |
| Destination Zone | Gateway |
| Action | Block |
| Protocol | TCP |
| Connection State | *New* only |
| Syslog Logging | on |

You can add the same rule with Destination Zone *Internal*. DHCP, IPv6 and WireGuard use UDP/ICMP and
replies to your own connections are *Established*, so the rule can't break anything. Undo with *Disable*.

Only enable syslog logging on **block** rules. Allow rules are recognized by name (`-A-`, "allow",
"accept") and dropped, but it's cleaner not to send them.

**Region blocking (CN/RU):** whether UniFi logs region-block hits depends on the firmware. If it
doesn't, the block happens before your rule and CN/RU won't appear as red arcs. Everything else still works.

## 4. Test

From the host:

```bash
pct enter <LXC ID>
./lagezentrum.sh test
```

Sends a test flow and a test syslog line through the whole chain and checks they arrive in the
history (incl. GeoIP). Then:

1. `https://<LXC-IP>:8443/?demo` shows the login page, then the globe with sample data, no UniFi needed (trust Caddy's certificate as described above)
2. `https://<LXC-IP>:8443` should show **Live** with a green dot in the top left
3. Real flows take about a minute after enabling them in UniFi (IPFIX templates)

## Usage

![Flat map](docs/flat-map.png)

| | |
|---|---|
| **⚙ Settings** | *Smooth playback* (default on): the gateway sends flows in batches every few seconds; the dashboard buffers them and replays them in real time with a few seconds of measured delay. **Interface:** color scheme (night blue, graphite, black/OLED), direction colors (standard or colorblind-friendly), font size, panel opacity, hide stats or ticker. **Map:** globe or flat map, auto-rotation and speed, night lights or plain surface, relief, stars, atmosphere, borders, country shading, hotspots, home label, arc style, arcs per second, arc height. *Reset view* and *Reset all*. Stored in the browser. At the bottom: *Log out* (this browser only). |
| **System** | API, live stream and history availability; last stored NetFlow/IPFIX and firewall event; GeoIP city and ASN database age. Refreshes while open. |
| **Filter chips** | Out / In (on), Blocked / Internal (off), DNS (off). Stored in the browser. |
| **Ticker** | Upload ↑, download ↓ and duration per connection. On hover: ✎ rename, dossier for device, country, company or IP. Click zooms to the location, double-click opens the history for that IP. Header shows connections and volume per minute. |
| **Left panel** | 24 h counters with volume, number of destinations/companies/countries/devices, hourly chart (click the title to switch between connections and volume), top destinations, countries, services, largest and longest connections, devices. Countries, companies and devices open their dossier, the rest opens the history. |
| **Globe / map** | Countries are shaded by traffic in the last 24 h. Click a country or hotspot to open its dossier. The flat map (⚙ → Map → View) pans by dragging and zooms with the wheel. Both load finer borders (1:50m) and sharper texture tiles when zoomed in, only for the visible area. |
| **Dossier** | For a country, device, company or IP: key numbers (connections, volume, IPs, devices, first/last seen, blocked), timeline, top lists and all **source → destination** pairs with service, count and volume. Range 1 h to 30 days. Click a pair for the individual connections. |
| **Countries** | All countries as a sortable table. Click opens the dossier. |
| **Devices** | All addresses with traffic. Add or remove names (✎), also for external IPs (*+ Name for IP*, e.g. your VPS). Names apply immediately in the dashboard and to new history entries, and searching a name also finds older entries for that IP. |
| **First contact** | Notification when a device contacts a country or company for the first time in 30 days (can be turned off; starts once there's a day of history). |
| **History** (key `/`) | Full-text search over IP, device, country, city, provider, or plain LogsQL. |

![History](docs/history.png)

Search examples:

```
MacBook                              word search
r_country:CN                         one field
dir:blocked dport:22                 several fields
r_org:"Google LLC" local_name:iPhone
dport:443 | stats by (local_name) sum(bytes) bytes     custom query with pipes
```

Fields: `dir` (out/in/blocked/internal), `leg`, `proto`, `local_ip`, `local_name`, `remote_ip`,
`remote_name`, `sport`, `dport`, `bytes`, `packets`, `duration_ms`, `rule`, `r_country`, `r_country_name`,
`r_city`, `r_org`, `r_asn`, `in_if`, `out_if`. The full VictoriaLogs UI is at `https://<LXC-IP>:8443/select/vmui/`.

URL options: `?demo` (sample data), `?lite` (for weak devices like a Pi kiosk: no relief, stars or
country fills, fewer arcs).

![Settings](docs/settings.png)

## What UniFi exports

Ubiquiti doesn't document exactly which connections go out via NetFlow/IPFIX. What we've seen so far:

- **Inbound stays empty, and that's correct.** Inbound only exists if something is reachable from
  outside (port forward). A Cloudflare tunnel connects from inside, so it shows as outbound to
  Cloudflare (port 7844).
- **Traffic to the gateway itself** (DNS to `10.37.x.1`, the UCG's WireGuard server) isn't exported.
  So incoming VPN connections are missing too.
- **VPN clients** live in a separate network that can't be selected for NetFlow, so their traffic isn't exported.
- **Between VLANs:** still unclear. To test, ping a device in another VLAN and enable the Internal filter.
  The pipeline stores interface numbers for this: `_time:24h kind:flow | stats by (in_if, out_if, dir) count()`
  in the history shows which paths the gateway exports at all.
- Some firmware versions had export bugs (reports for Network 9.3.45 and 9.4.17 in the Ubiquiti
  community). If data suddenly drops, check the firmware version.

## Operation

**Updating** (option A install), on the Proxmox host:

```bash
cd /root/unifi-HQ && git pull
./proxmox/update-lxc.sh            # finds the CT named "lagezentrum", otherwise: ./proxmox/update-lxc.sh <CTID>
```

Copies the new version into the container, rebuilds and runs the self-test. `.env`, `hosts.csv`,
GeoIP data, password and history are kept. Option B (git inside the container):
`cd /opt/lagezentrum && git pull && ./lagezentrum.sh update`.

**First update to the version with required login:** if no password is configured, the dashboard
stays locked until one is set. Set it inside the container:

```bash
pct enter <LXC ID>
cd /opt/lagezentrum && ./lagezentrum.sh password
```

This also removes an old basic auth setup from earlier versions.

### Login

The dashboard asks for the password once and keeps the session in a cookie for 400 days (the browser
maximum), renewed on every use. A kiosk that opens the dashboard regularly stays signed in.

```bash
./lagezentrum.sh password          # set or change password (signs out all browsers)
./lagezentrum.sh password logout   # sign out all browsers, keep password
./lagezentrum.sh password off      # explicitly disable login; any allowed LAN client can access it
```

Everything is protected: dashboard, live stream (`/ws`), history (`/select`, including the VictoriaLogs UI),
names API and `config.json`. Without a session, pages redirect to `/login.html` and everything else
returns `401`. If no password is configured, access remains locked until `./lagezentrum.sh password`
sets one. Only the login page and `/vendor/` (globe.gl, textures, fonts, no data) are public.
Internal services still listen on `127.0.0.1` only; the self-test and collector talk to them directly.

HTTPS on port 8443 uses Caddy's internal CA, persisted in the `caddy-data` Docker volume. Trust the
exported `lagezentrum-ca.crt` on each client to avoid browser certificate warnings. HTTP on port 8080
is also available for trusted networks or a TLS-terminating reverse proxy. For that setup, set
`AUTH_COOKIE_SECURE=true` in `.env` and keep the HTTP upstream private to the proxy.

```bash
./lagezentrum.sh status      # containers, RAM, disk, events in the last hour
./lagezentrum.sh update      # pull new images and restart
./lagezentrum.sh geoip       # update GeoIP now (otherwise on the 3rd of each month)
./lagezentrum.sh logs        # follow logs
```

- **Retention:** `RETENTION` and `MAX_DISK` in `.env`, whichever is hit first.
- **WAN IP changed:** update `.env`, `docker compose up -d`. Until then, flows without a recognizable
  local side still count as outbound.
- **Versions** are pinned (Vector 0.58.0, GoFlow2 v2.2.7, VictoriaLogs v1.53.0, Caddy 2.11). To bump,
  edit `docker-compose.yml` or `collector/Dockerfile`, then `update`. Note: `netsampler/goflow2:latest`
  points to the old 1.x with a different JSON format.
- **Backup:** configs are in git. `.env` and `config/hosts.csv` are excluded on purpose, back those up.
  The history is expendable.

## Security

- **LAN only:** Caddy only answers clients in `ALLOWED_CLIENTS` (default: 10/8, 172.16/12, 192.168/16,
  fd00::/8, loopback). Everyone else gets the connection dropped.
- **No tunnel:** requests with a `Cf-Connecting-Ip` header (Cloudflare Tunnel) are rejected, even if
  `cloudflared` runs on the LAN. Don't put the dashboard behind a tunnel: `/select` would expose all
  your connection data.
- **Sender check:** NetFlow and syslog are only accepted from private addresses, and with
  `ALLOWED_SENDERS` only from the gateway.
- **Internal services** (VictoriaLogs, live stream, GoFlow2 metrics) listen on `127.0.0.1` only. Caddy
  only exposes the read-only `/select` part of VictoriaLogs.
- **No Docker socket, no external CDNs:** globe.gl, textures and fonts are in `web/vendor/`. The browser
  loads nothing from third parties (strict Content Security Policy).
- **Names API:** anyone allowed to open the dashboard can set names via `/api/names`, i.e. only signed-in
  LAN clients. The API validates IP and name, only accepts same-origin JSON and only writes
  `config/hosts.csv`. Its only privilege is sending the reload signal to Vector.
- **Login:** required by default; without a configured password the dashboard stays locked. Use
  `./lagezentrum.sh password` to set one or explicitly opt out with `password off`. Caddy checks every
  request with the API (`forward_auth`). The password is stored only as a PBKDF2 hash (600,000 rounds,
  SHA-256) in `.env`; the session cookie is signed with `AUTH_SECRET` (HMAC-SHA256), `HttpOnly`,
  `Secure` and `SameSite=Lax`. A new password or `password logout` invalidates all cookies. Brute force:
  each failed attempt costs one second, after 5 failures the address is locked for 1 minute, doubling
  each time (max 15 minutes).
- **HTTPS:** Caddy serves the dashboard over TLS using its own internal CA; import the root certificate
  on each client as described above. The CA key stays in the persistent `caddy-data` Docker volume.
  HTTP is also available for trusted networks and TLS-terminating reverse proxies; never expose that
  upstream to untrusted networks, and set `AUTH_COOKIE_SECURE=true` when the proxy terminates TLS.

## Resources

Measured with synthetic IPFIX:

| Load | CPU (share of one core) | Total RAM |
|---|---|---|
| Idle | < 0.1 % | ~180 MB |
| 100 flows/s (busy household) | ~3 % Vector + ~2 % GoFlow2 | ~230 MB |
| 500 flows/s | ~15 % Vector + ~9 % GoFlow2 | ~230 MB |

No flows were lost. If VictoriaLogs goes down briefly, Vector buffers and catches up. Disk writes come
only from VictoriaLogs (compressed, flushed every 30 s) and rotated Docker logs (max 10 MB per container).
GeoIP takes ~140 MB RAM in the collector because the database is kept in memory. The globe renders in
the browser, not on the server, and pauses in background tabs.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Status *Disconnected* | collector not running | `docker compose ps`, `docker compose logs collector`; if GeoIP is missing: `./lagezentrum.sh geoip` |
| *Live · no data for 2 min* | NetFlow not arriving | check collector IP/port in UniFi; `apt -y install tcpdump && tcpdump -ni eth0 udp port 2055` |
| NetFlow arrives but nothing shows | sender not allowed | `ALLOWED_SENDERS` must be the IP the gateway sends from (see tcpdump) |
| No red arcs | Blocked filter off, no syslog, or rule without logging | enable the chip; `./lagezentrum.sh test`; check rule 3C |
| CN/RU missing from red arcs | region blocking hits before the rule | see note in 3C |
| Lots of inbound from your own IP | `WAN_IP` outdated | update `.env`, `docker compose up -d` |
| Own devices shown as foreign | IPv6 prefix missing | set `LOCAL_EXTRA_NETS` |
| Stats show *history unavailable* | VictoriaLogs down | `docker compose logs victorialogs` |
| Dashboard unreachable from LAN | client not in `ALLOWED_CLIENTS` | add e.g. Tailscale (100.64/10) or public IPv6 |
| Globe stutters on a Pi kiosk | weak GPU | append `?lite` to the URL |
| Forgot password | | `./lagezentrum.sh password` sets a new one |
| Login says *Too many failed attempts* | locked after 5 failures | wait (max 15 min) or `docker compose restart api` |
| *502* everywhere | API not running, Caddy lets no one through without it | `docker compose ps`, `docker compose logs api` |
| Browser warns about the HTTPS certificate | Caddy's local CA is not trusted on this device | export `root.crt` as described above and install it as a trusted root certificate |
| Login works, then back to login page | browser blocks cookies for the LXC IP | allow cookies for `https://<TLS_DOMAIN>:8443` |

Allow rules are recognized by name (`-A-`, "allow", "accept"). If your logs use a different pattern,
it's one line in the `blocked` transform in `collector/vector.yaml`.

## Files

```
docker-compose.yml        containers, hardening, RAM limits, log rotation
.env.example              template for .env (copied by setup)
install.sh                install inside the LXC: packages, Docker, project, setup, self-test
proxmox/create-lxc.sh     on the Proxmox host: create LXC and run install.sh in it
proxmox/update-lxc.sh     on the Proxmox host: copy new version into the LXC and restart
lagezentrum.sh            setup · test · status · geoip · password · update · logs
collector/Dockerfile      Vector + GoFlow2 in one image
collector/vector.yaml     pipeline: classification, syslog parser, GeoIP, sinks
config/hosts.example.csv  template for device names
caddy/Caddyfile           web server, LAN restriction, security headers
caddy/auth/               only for old basic auth from earlier versions
scripts/geoip-update.sh   GeoIP download (runs in the geoip container)
api/                      login + names API (Go, standard library only)
web/                      dashboard, login page, vendor/ (globe.gl, textures, fonts)
docs/                     screenshots
geoip/                    downloaded databases (not in git)
```

IP geolocation: [DB-IP.com](https://db-ip.com) Lite, CC BY 4.0. globe.gl: MIT. IBM Plex: SIL OFL 1.1.
Flags: Twemoji Country Flags (code MIT, graphics [Twemoji](https://github.com/twitter/twemoji) CC BY 4.0),
so flags also show on Windows. Borders: [Natural Earth](https://www.naturalearthdata.com) 1:110m and 1:50m,
public domain. Night texture: [NASA Earth Observatory, Black Marble 2016](https://earthobservatory.nasa.gov/features/NightLights)
(Suomi NPP VIIRS), public domain.
