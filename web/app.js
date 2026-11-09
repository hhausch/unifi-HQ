/* Lagezentrum – Dashboard
 * Live-Stream:  /ws          (Vector websocket_server, ein JSON-Objekt pro Nachricht)
 * Historie:     /select/...  (VictoriaLogs, LogsQL)
 * Einstellungen: /config.json (aus der .env, über Caddy)
 * Login:        /auth/session (Sitzung prüfen und verlängern), /auth/logout
 * Demo ohne Backend: ?demo
 */
(() => {
  'use strict';

  // ---------- Einstellungen ----------
  const CONFIG = {
    home: { lat: 50.11, lng: 8.68, label: 'Home' },
    gateway: '',
    wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
    vlUrl: 'select/logsql/query',
    arcsPerSecond: 10,        // mehr landet in Ticker und Zählern, aber nicht als Bogen
    flightMs: 1700,
    tickerMax: 80,
    statsEveryMs: 60000,
    spotsMax: 400,
    historyLimit: 500,
    textures: 'vendor/'
  };
  // Richtungsfarben; „cb“ nach Okabe-Ito, auch bei Rot-Grün-Schwäche unterscheidbar
  const PALETTES = {
    default: { out: '#7fd4ff', in: '#5fe0a0', blocked: '#ff4d5e', internal: '#b39cff' },
    cb: { out: '#56b4e9', in: '#f0e442', blocked: '#e8743b', internal: '#cc79a7' }
  };
  const COLORS = Object.assign({}, PALETTES.default);
  const VERB = { out: 'out', in: 'in', blocked: 'blocked', internal: 'internal' };
  const PORTS = { 20:'FTP data', 21:'FTP', 22:'SSH', 23:'Telnet', 25:'SMTP', 53:'DNS', 67:'DHCP', 69:'TFTP', 80:'HTTP', 81:'HTTP-Alt',
    88:'Kerberos', 110:'POP3', 111:'RPC', 119:'NNTP', 123:'NTP', 135:'MS-RPC', 137:'NetBIOS', 138:'NetBIOS', 139:'NetBIOS', 143:'IMAP',
    161:'SNMP', 179:'BGP', 389:'LDAP', 443:'HTTPS', 445:'SMB', 465:'SMTPS', 500:'IKE', 502:'Modbus', 514:'Syslog', 515:'LPD',
    554:'RTSP', 587:'SMTP', 623:'IPMI', 631:'IPP', 636:'LDAPS', 853:'DNS over TLS', 873:'rsync', 993:'IMAPS', 995:'POP3S',
    1080:'SOCKS', 1194:'OpenVPN', 1433:'MSSQL', 1521:'Oracle', 1723:'PPTP', 1883:'MQTT', 1900:'UPnP', 2049:'NFS', 2222:'SSH-Alt',
    2323:'Telnet', 2375:'Docker', 2376:'Docker', 3000:'Grafana', 3128:'Proxy', 3306:'MySQL', 3389:'RDP', 3478:'STUN', 4500:'IPsec',
    5000:'UPnP/Synology', 5060:'SIP', 5222:'XMPP', 5353:'mDNS', 5432:'PostgreSQL', 5555:'ADB', 5683:'CoAP', 5900:'VNC', 5985:'WinRM',
    6379:'Redis', 6443:'Kubernetes', 7547:'TR-069', 7844:'Cloudflare Tunnel', 8000:'HTTP-Alt', 8006:'Proxmox', 8080:'HTTP-Alt',
    8081:'HTTP-Alt', 8088:'HTTP-Alt', 8123:'Home Assistant', 8291:'MikroTik', 8443:'HTTPS-Alt', 8883:'MQTT/TLS', 8888:'HTTP-Alt',
    9000:'HTTP-Alt', 9090:'Prometheus', 9100:'Printer', 9200:'Elasticsearch', 10000:'Webmin', 11211:'Memcached', 25565:'Minecraft',
    27017:'MongoDB', 37777:'Dahua', 49152:'UPnP', 51820:'WireGuard' };

  const params = new URLSearchParams(location.search);
  // ?lite: für schwache Anzeigegeräte (Pi-Kiosk) – ohne Relief, Sterne und mit weniger Bögen
  const lite = params.has('lite');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LOCALE = 'en-GB';   // English labels, 24-hour clock and day-first dates
  const nf = new Intl.NumberFormat(LOCALE);
  const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  const flag = cc => (typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc)) ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '·';
  const country = (cc, fallback) => { if (cc && regionNames) { try { return regionNames.of(String(cc).toUpperCase()); } catch {} } return fallback || cc || ''; };
  const portName = p => { p = +p || 0; return p === 0 ? '–' : PORTS[p] ? `${PORTS[p]} (${p})` : `Port ${p}`; };
  const fmtBytes = b => { b = +b || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; while (b >= 1024 && i < 5) { b /= 1024; i++; } return (i ? b.toFixed(b < 10 ? 1 : 0) : b) + ' ' + u[i]; };
  const fmtNum = n => { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : nf.format(n); };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('lz.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('lz.' + k, JSON.stringify(v)); } catch {} }
  };
  // Sitzung abgelaufen o. ä.: zur Login-Seite und danach wieder hierher
  const toLogin = () => location.replace('login.html?next=' + encodeURIComponent(location.pathname + location.search));
  const lq = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';   // LogsQL-Zeichenkette
  const fmtDur = ms => { ms = +ms || 0; if (!ms) return ''; if (ms < 1000) return '<1 s'; const s = Math.round(ms / 1000);
    if (s < 60) return s + ' s'; const m = Math.floor(s / 60); if (m < 60) return m + ' min ' + (s % 60 ? (s % 60) + ' s' : '');
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };

  // Benutzer-Einstellungen (Zahnrad oben rechts), pro Browser gespeichert
  const DEFAULT_SETTINGS = { smooth: true, arcStyle: 'strong', arcRate: 10, choropleth: true, alerts: true,
    browserNotifications: false,
    // Oberfläche
    theme: 'navy', palette: 'default', uiScale: 1, panelAlpha: 0.76, showLeft: true, showRight: true,
    // Globus
    view: 'globe', autoRotate: !reduceMotion, rotateSpeed: 0.3, globeStyle: 'night', relief: true, stars: true, atmosphere: true,
    borders: true, points: true, homeLabel: true, arcHeight: 0.38 };
  const settings = Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));
  if (lite) settings.arcRate = Math.min(settings.arcRate, 4);

  // Farbschema, Richtungsfarben, Schriftgröße, Leisten – alles über CSS-Variablen und Klassen
  function applyUiSettings() {
    const root = document.documentElement;
    if (settings.theme === 'navy') delete root.dataset.theme; else root.dataset.theme = settings.theme;
    Object.assign(COLORS, PALETTES[settings.palette] || PALETTES.default);
    for (const [k, v] of Object.entries(COLORS)) root.style.setProperty('--' + k, v);
    root.style.setProperty('--live', COLORS.in);
    root.style.setProperty('--ui-zoom', String(settings.uiScale));
    root.style.setProperty('--panel-a', String(settings.panelAlpha));
    $('left').hidden = !settings.showLeft; $('right').hidden = !settings.showRight;
    document.body.classList.toggle('no-left', !settings.showLeft);
    document.body.classList.toggle('no-right', !settings.showRight);
  }
  applyUiSettings();

  // ---------- Filter ----------
  const DEFAULT_FILTERS = { out: true, in: true, blocked: false, internal: false, dns: false };
  const isDemo = params.has('demo') || location.protocol === 'file:';
  const filters = Object.assign({}, DEFAULT_FILTERS, isDemo ? { blocked: true, internal: true } : store.get('filters', {}));
  for (const k of Object.keys(filters)) if (!(k in DEFAULT_FILTERS)) delete filters[k];

  function applyFilters() {
    document.querySelectorAll('.chip').forEach(b => b.setAttribute('aria-pressed', String(!!filters[b.dataset.f])));
    document.querySelectorAll('[data-needs]').forEach(s => { s.hidden = !filters[s.dataset.needs]; });
    document.querySelectorAll('.total').forEach(t => { t.hidden = (t.dataset.k === 'blocked' || t.dataset.k === 'internal') && !filters[t.dataset.k]; });
    renderSpark();
    refreshPoints();
  }
  document.querySelectorAll('.chip').forEach(btn => btn.addEventListener('click', () => {
    const f = btn.dataset.f; filters[f] = !filters[f];
    if (!isDemo) store.set('filters', filters);
    applyFilters();
  }));
  const isDns = e => e.dport === 53 || e.dport === 853 || e.dport === 5353;
  const visible = e => filters[e.dir] === true && (filters.dns || !isDns(e));

  // ---------- Globus ----------
  const globeEl = $('globe');
  let world = null;
  const arcs = [], rings = [];
  const spots = new Map();
  let dirty = true;

  function initGlobe() {
    if (typeof Globe !== 'function') {
      showHint('Could not load the 3D library (vendor/globe.gl.min.js).');
      return;
    }
    try {
      world = new Globe(globeEl, { animateIn: !reduceMotion, rendererConfig: { antialias: !lite, powerPreference: 'low-power' } });
    } catch {
      world = Globe({ animateIn: !reduceMotion })(globeEl);
    }
    const H = CONFIG.home;
    world
      .atmosphereAltitude(0.16)
      .arcStartLat(d => d.sLat).arcStartLng(d => d.sLng).arcEndLat(d => d.eLat).arcEndLng(d => d.eLng)
      .arcColor(d => d.color).arcStroke(d => d.stroke * Math.max(0.25, globeNear.scale))
      .arcDashLength(d => d.dash).arcDashGap(d => d.gap).arcDashInitialGap(1).arcDashAnimateTime(CONFIG.flightMs)
      .arcsTransitionDuration(0)
      .ringColor(d => t => rgba(d.color, Math.max(0, 1 - t)))
      .ringMaxRadius(d => d.max * globeNear.scale).ringPropagationSpeed(d => d.speed * globeNear.scale).ringRepeatPeriod(d => d.period)
      .pointLat(d => d.lat).pointLng(d => d.lng).pointColor(d => rgba(COLORS[d.dir], 0.85))
      .pointAltitude(0.004).pointRadius(d => pointRadius(d) * globeNear.scale)
      .pointsTransitionDuration(0)
      .pointLabel(pointLabel)
      .onPointClick(d => d.cc ? openDossier('country', d.cc) : null)
      .labelLat(d => d.lat).labelLng(d => d.lng).labelText(d => d.label)
      .labelColor(() => cssVar('--text') || '#dbe6f3')
      .labelSize(0.55).labelDotRadius(0.28).labelAltitude(0.006)
      .pointOfView(homeView(), 0)
      .tileLat(d => d.lat).tileLng(d => d.lng).tileWidth(d => d.w).tileHeight(d => d.h)
      .tileAltitude(0.002).tileMaterial(globeTileMat).tilesTransitionDuration(0);

    try { world.renderer().setPixelRatio(lite ? 1 : Math.min(devicePixelRatio || 1, 2)); } catch {}
    rings.push(homeRing = { lat: H.lat, lng: H.lng, color: COLORS.out, max: 2.5, speed: 1, period: 2600 });

    const controls = world.controls();
    controls.addEventListener('start', () => pauseRotation());
    applyGlobeSettings();

    addEventListener('resize', resizeGlobe); resizeGlobe();

    // Unsichtbarer Tab oder flache Karte: nichts rendern
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) world.pauseAnimation(); else if (settings.view !== 'flat') world.resumeAnimation();
    });
  }
  // versteckt (flache Karte) wäre die Größe 0 – dann beim Umschalten nachholen
  function resizeGlobe() { if (world && !globeEl.hidden) world.width(globeEl.clientWidth).height(globeEl.clientHeight); }
  const pointRadius = d => 0.12 + Math.min(0.55, Math.log10(d.count + 1) * 0.22);   // in Grad
  function pointLabel(d) {
    const box = el('div');
    box.textContent = `${flag(d.cc)} ${d.place} · ${nf.format(d.count)}× ${VERB[d.dir]}` + (d.org ? ` · ${d.org}` : '');
    return box.outerHTML;   // globe.gl erwartet HTML – Inhalt ist hier bereits escaped
  }

  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const homeView = () => ({ lat: Math.max(-60, Math.min(60, CONFIG.home.lat - 12)), lng: CONFIG.home.lng + 4, altitude: 2.3 });
  let homeRing = null, nightMap = null;

  // Globus-Einstellungen (⚙ → Globus); auch nach Farbschema- oder Farbwechsel aufrufen
  function applyGlobeSettings() {
    flatDirty = true; applyView();
    if (!world) return;
    // globe.gl baut bei jedem Setzen neu auf (Texturen laden, Atmosphäre) – nur Änderungen setzen
    const put = (prop, v) => { if (world[prop]() !== v) world[prop](v); };
    put('backgroundColor', cssVar('--ink') || '#071224');
    put('showAtmosphere', settings.atmosphere); put('atmosphereColor', cssVar('--atmo') || '#3d7bd9');
    put('arcAltitudeAutoScale', settings.arcHeight);
    put('backgroundImageUrl', !lite && settings.stars ? CONFIG.textures + 'night-sky.png' : null);
    put('bumpImageUrl', !lite && settings.relief ? CONFIG.textures + 'earth-topology.png' : null);
    if (world.labelsData().length !== (settings.homeLabel ? 1 : 0)) world.labelsData(settings.homeLabel ? [CONFIG.home] : []);
    // Textur selbst tauschen: globe.gl entfernt eine geladene Textur nicht, und nach einem
    // Neuladen bleibt der Globus schwarz. Die Textur wird daher einmal geladen und aufgehoben.
    const m = world.globeMaterial();
    if (m.map) nightMap = m.map;
    if (settings.globeStyle === 'plain') {
      m.map = null; m.color = (m.color || m.emissive.clone()).set(cssVar('--globe') || '#0d2242'); m.needsUpdate = true;
    } else if (nightMap) {
      m.map = nightMap; m.color = (m.color || m.emissive.clone()).set('#ffffff'); m.needsUpdate = true;
    } else {
      world.globeImageUrl(CONFIG.textures + 'black-marble.jpg');
    }
    const c = world.controls();
    c.autoRotateSpeed = settings.rotateSpeed;
    if (!settings.autoRotate) { clearTimeout(resumeTimer); resumeTimer = null; c.autoRotate = false; }
    else if (!resumeTimer) c.autoRotate = true;
    if (homeRing) { homeRing.color = COLORS.out; dirty = true; }
    refreshPoints(); refreshPolys();
  }

  let resumeTimer = null;
  function pauseRotation(ms = 15000) {
    if (!world) return;
    const c = world.controls(); c.autoRotate = false; clearTimeout(resumeTimer); resumeTimer = null;
    if (settings.autoRotate) resumeTimer = setTimeout(() => { resumeTimer = null; c.autoRotate = settings.autoRotate; }, ms);
  }
  function focusOn(lat, lng) {
    if (lat == null || lng == null) return;
    if (settings.view === 'flat') { flatFocus(+lat, +lng); return; }
    if (!world) return;
    pauseRotation(30000);
    world.pointOfView({ lat: +lat, lng: +lng, altitude: 1.5 }, 1200);
  }

  // Bögen begrenzen: Token-Bucket + gleiche Gegenstelle höchstens alle 3 s
  let tokens = settings.arcRate;
  setInterval(() => { tokens = Math.min(settings.arcRate, tokens + settings.arcRate / 10); }, 100);
  const recentArc = new Map();

  function emitArc(e) {
    if (!world || document.hidden || e.r_lat == null || e.r_lon == null || tokens < 1) return;
    const key = e.dir + '|' + e.remote_ip, now = Date.now();
    if (now - (recentArc.get(key) || 0) < 3000) return;
    recentArc.set(key, now);
    if (recentArc.size > 2000) recentArc.clear();
    tokens -= 1;
    const H = CONFIG.home;
    const towardHome = e.dir === 'in' || (e.dir === 'blocked' && e.bdir !== 'out');
    const remote = { lat: +e.r_lat, lng: +e.r_lon };
    const s = towardHome ? remote : H, t = towardHome ? H : remote;
    const color = COLORS[e.dir];
    const strong = settings.arcStyle === 'strong';
    // Dicke nach Datenmenge: 1 KB dünn, 100 MB dick
    const vol = (e.bytes || 0) + (e.down || 0);
    const size = Math.min(1, Math.max(0, (Math.log10(vol + 1) - 3) / 5));
    const stroke = strong ? (e.dir === 'blocked' ? 0.9 : 0.5 + size * 1.3) : (e.dir === 'blocked' ? 0.55 : 0.38);
    const arc = { t0: Date.now(), sLat: s.lat, sLng: s.lng, eLat: t.lat, eLng: t.lng, stroke,
      color: strong ? [rgba(color, 0.35), color] : [rgba(color, 0.05), color],
      dash: strong ? 0.6 : 0.4, gap: strong ? 1.4 : 2 };
    arcs.push(arc); dirty = true;
    setTimeout(() => {
      const ring = { t0: Date.now(), lat: t.lat, lng: t.lng, color, max: (e.dir === 'blocked' ? 3.2 : 1.8) * (strong ? 1.4 + size : 1), speed: 2.4, period: 99999 };
      rings.push(ring); dirty = true;
      setTimeout(() => { const i = rings.indexOf(ring); if (i >= 0) rings.splice(i, 1); dirty = true; }, 1400);
    }, CONFIG.flightMs);
    setTimeout(() => { const i = arcs.indexOf(arc); if (i >= 0) arcs.splice(i, 1); dirty = true; }, CONFIG.flightMs * 2);
  }

  function addSpot(e) {
    if (e.r_lat == null || e.r_lon == null) return;
    const key = `${(+e.r_lat).toFixed(1)},${(+e.r_lon).toFixed(1)}|${e.dir}`;
    let s = spots.get(key);
    if (!s) {
      s = { lat: +e.r_lat, lng: +e.r_lon, dir: e.dir, count: 0, cc: e.r_country, org: e.r_org,
            place: e.r_city || country(e.r_country, e.r_country_name) || '?' };
      spots.set(key, s);
    }
    s.count++; s.last = Date.now();
  }
  let pointList = [];
  function refreshPoints() {
    if (!world && settings.view !== 'flat') return;
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [k, s] of spots) if (s.last < cutoff) spots.delete(k);
    const list = [...spots.values()].filter(s => filters[s.dir]).sort((a, b) => b.count - a.count).slice(0, CONFIG.spotsMax);
    pointList = settings.points ? list : [];
    if (world) world.pointsData(pointList);
  }

  setInterval(() => {
    if (!dirty || !world || settings.view === 'flat') return; dirty = false;
    world.arcsData(arcs.slice()); world.ringsData(rings.slice());
  }, 120);
  setInterval(refreshPoints, 2000);

  // ---------- Ticker ----------
  const queue = [];
  const stamps = [];
  const internalSeen = new Map();
  const ticker = $('ticker');
  let lastEventAt = 0;

  function makeItem(e) {
    const li = el('li', 'fresh'); li.dataset.dir = e.dir; li.tabIndex = 0;
    const time = el('time', null, new Date(e.ts).toLocaleTimeString(LOCALE));
    const body = el('div');
    const where = el('div', 'where');
    const what = el('div', 'what');
    const verb = el('span', 'verb', VERB[e.dir] + ' ');
    if (e.isNew) where.append(el('span', 'badge', 'NEW'));
    const local = e.local_name || e.local_ip;
    if (e.dir === 'internal') {
      where.append(verb, `${local} → ${e.remote_name || e.remote_ip}`);
      what.textContent = [portName(e.dport), e.proto].filter(Boolean).join(' · ');
    } else {
      const place = [e.r_city, country(e.r_country, e.r_country_name)].filter(Boolean).join(', ') || 'unknown location';
      where.append(verb, `${flag(e.r_country)} ${place}`);
      const parts = [e.remote_ip, portName(e.dport), e.r_org];
      if (e.dir !== 'blocked') parts.push(local);
      what.textContent = parts.filter(Boolean).join(' · ');
    }
    li.title = e.rule ? `Rule: ${e.rule}` : 'Click: zoom in · Double-click: history for this IP';
    // Aktionen beim Überfahren: Name vergeben, Dossiers
    const acts = el('div', 'acts');
    const act = (txt, title, fn) => { const b = el('button', null, txt); b.type = 'button'; b.title = title; b.addEventListener('click', ev => { ev.stopPropagation(); fn(); }); acts.append(b); };
    if (e.dir !== 'blocked') act('✎', `Name ${e.local_ip}`, () => editName(e.local_ip));
    if (e.dir !== 'blocked' && e.dir !== 'internal') act('Device', 'Dossier for this device', () => openDossier('device', e.local_ip));
    if (e.r_country) act('Country', 'Dossier for this country', () => openDossier('country', e.r_country));
    if (e.r_org) act('Company', 'Dossier for this company', () => openDossier('org', e.r_org));
    act('IP', 'Dossier for this remote host', () => openDossier('ip', e.remote_ip));
    li.append(acts);
    const meta = el('div', 'meta');
    e.metaEl = meta; renderMeta(e);
    body.append(where, what, meta);
    li.append(time, body);
    const go = () => { if (e.dir === 'internal') openHistory(`local_ip:${lq(e.local_ip)} remote_ip:${lq(e.remote_ip)}`, 'internal'); else focusOn(e.r_lat, e.r_lon); };
    li.addEventListener('click', go);
    li.addEventListener('dblclick', () => openHistory(`remote_ip:${lq(e.remote_ip)}`, ''));
    li.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
    return li;
  }

  function renderMeta(e) {
    if (!e.metaEl) return;
    const parts = [];
    if (e.dir !== 'blocked') {
      parts.push(`↑ ${fmtBytes(e.bytes)}`);
      if (e.down) parts.push(`↓ ${fmtBytes(e.down)}`);
    }
    if (e.duration_ms) parts.push(fmtDur(e.duration_ms));
    if (e.proto) parts.push(e.proto);
    e.metaEl.textContent = parts.join(' · ');
  }

  setInterval(() => {
    if (!queue.length || document.hidden) { if (queue.length > 200) queue.splice(0, queue.length - 20); return; }
    const batch = queue.splice(0, queue.length).slice(-12);
    for (const e of batch) ticker.prepend(makeItem(e));
    while (ticker.children.length > CONFIG.tickerMax) ticker.lastChild.remove();
  }, 250);

  setInterval(() => {
    const cutoff = Date.now() - 60000;
    while (stamps.length && stamps[0] < cutoff) stamps.shift();
    while (byteStamps.length && byteStamps[0][0] < cutoff) byteStamps.shift();
    const perMin = byteStamps.reduce((a, b) => a + b[1], 0);
    $('rate').textContent = `· ${nf.format(stamps.length)} per minute · ${fmtBytes(perMin)}/min`;
    $('clock').textContent = new Date().toLocaleTimeString(LOCALE);
    if (ws && ws.readyState === 1) {
      const quiet = Date.now() - lastEventAt > 120000;
      setStatus(quiet ? 'idle' : 'live', quiet ? 'Live · no data for 2 min' : 'Live');
    }
  }, 1000);

  function renderInternal() {
    if (!filters.internal) return;
    const ul = $('internal');
    const rows = [...internalSeen.values()].sort((a, b) => b.last - a.last).slice(0, 8);
    if (!rows.length) { ul.replaceChildren(el('li', 'empty', 'Nothing seen yet')); return; }
    ul.replaceChildren(...rows.map(r => {
      const li = el('li');
      li.append(el('span', null, `${r.from} → ${r.to} · ${portName(r.port)}`), el('span', null, `${nf.format(r.count)}×`));
      return li;
    }));
  }
  setInterval(renderInternal, 2000);

  // Eingang: Antwort-Bytes der passenden Anfrage zuordnen, dann (geglättet) abspielen
  const byteStamps = [];
  const conns = new Map();                       // Schlüssel -> Anfrage (letzte ~2 min)
  const connKey = e => `${e.local_ip}|${e.remote_ip}|${e.sport}|${e.dport}|${e.proto}`;
  const pending = [];                            // Puffer für gleichmäßiges Abspielen
  let pendingSorted = true;
  const lags = [];
  let playDelay = 10000;                         // Startwert, passt sich nach den ersten Paketen an

  function ingest(e) {
    if (!e || !COLORS[e.dir]) return;
    e.ts = e.timestamp ? Date.parse(e.timestamp) : Date.now();
    if (!isFinite(e.ts)) e.ts = Date.now();
    e.dport = +e.dport || 0; e.sport = +e.sport || 0;
    e.bytes = +e.bytes || 0; e.duration_ms = +e.duration_ms || 0;
    if (names.has(e.local_ip)) e.local_name = names.get(e.local_ip);
    if (names.has(e.remote_ip)) e.remote_name = names.get(e.remote_ip);
    const now = Date.now();
    lastEventAt = now;
    byteStamps.push([now, e.bytes]);
    const key = connKey(e);
    if (e.leg === 'resp') {
      const r = conns.get(key);
      if (r) { r.down = (r.down || 0) + e.bytes; r.duration_ms = Math.max(r.duration_ms, e.duration_ms); renderMeta(r); }
      return;
    }
    e.seen = now;
    conns.set(key, e);
    if (conns.size > 4000) for (const [k, v] of conns) { if (now - v.seen > 120000 || conns.size > 3000) conns.delete(k); else break; }
    if (!settings.smooth) { play(e); return; }
    lags.push(now - e.ts); if (lags.length > 300) lags.shift();
    pending.push(e); pendingSorted = false;
    if (pending.length > 5000) pending.splice(0, pending.length - 5000).forEach(play);
  }

  // Versatz = 90 % der beobachteten Verzögerung + Reserve; so landet jedes Ereignis
  // zu seinem echten Zeitpunkt (Ende der Verbindung) + konstantem Versatz auf dem Globus.
  setInterval(() => {
    if (!lags.length) return;
    const sorted = lags.slice().sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    playDelay = Math.max(1000, Math.min(60000, p90 + 800));
    const info = $('delayInfo'); if (info) info.textContent = settings.smooth ? `Current delay ${Math.round(playDelay / 1000)} s` : '';
  }, 2000);

  setInterval(() => {
    if (!pending.length) return;
    if (!pendingSorted) { pending.sort((a, b) => a.ts - b.ts); pendingSorted = true; }
    const now = Date.now();
    while (pending.length && pending[0].ts + playDelay <= now) play(pending.shift());
  }, 50);

  function flushPending() { if (!pendingSorted) pending.sort((a, b) => a.ts - b.ts); pending.splice(0).forEach(play); pendingSorted = true; }

  function play(e) {
    if (e.dir === 'internal') {
      const k = `${e.local_ip}>${e.remote_ip}:${e.dport}`;
      const r = internalSeen.get(k) || { from: e.local_name || e.local_ip, to: e.remote_name || e.remote_ip, port: e.dport, count: 0 };
      r.count++; r.last = Date.now(); internalSeen.set(k, r);
      if (internalSeen.size > 500) { const oldest = [...internalSeen.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, 250); oldest.forEach(([k2]) => internalSeen.delete(k2)); }
    } else {
      addSpot(e);
    }
    checkFirstContact(e);
    if (!visible(e)) return;
    stamps.push(Date.now());
    queue.push(e);
    if (e.dir !== 'internal') emitArc(e);
  }
  const handle = ingest;

  // ---------- Statistiken aus VictoriaLogs ----------
  async function vl(q, limit) {
    const body = new URLSearchParams({ query: q });
    if (limit) body.set('limit', String(limit));
    const r = await fetch(CONFIG.vlUrl, { method: 'POST', body, cache: 'no-store' });
    if (r.status === 401) toLogin();
    if (!r.ok) {
      const text = (await r.text()).trim().split('\n').slice(-1)[0] || '';
      throw new Error(`VictoriaLogs ${r.status}${text ? ': ' + text.slice(0, 300) : ''}`);
    }
    return (await r.text()).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  function renderBars(ul, rows, label, value, fmt, query, emptyText = 'No data yet', open) {
    fmt = fmt || (v => nf.format(v));
    if (!rows.length) { ul.replaceChildren(el('li', 'empty', emptyText)); return; }
    const max = Math.max(...rows.map(r => +r[value] || 0)) || 1;
    ul.replaceChildren(...rows.map(r => {
      const li = el('li');
      const name = el('span', null, label(r)); name.title = name.textContent;
      const fill = el('i'); fill.style.width = ((+r[value] || 0) / max * 100) + '%';
      const bar = el('span', 'bar'); bar.append(fill);
      li.append(name, el('em', null, fmt(+r[value] || 0)), bar);
      if (query) { const q = query(r); if (q) { li.dataset.q = q[0]; li.dataset.dir = q[1] || ''; li.tabIndex = 0; } }
      if (open) { const o = open(r); if (o && o[1]) { li.dataset.dtype = o[0]; li.dataset.dval = o[1]; li.tabIndex = 0; } }
      return li;
    }));
  }
  document.addEventListener('click', ev => {
    const li = ev.target.closest('.bars li[data-q], .total[data-q]');
    if (!li) return;
    if (li.classList.contains('total')) openHistory('', li.dataset.k);
    else openHistory(li.dataset.q, li.dataset.dir);
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('.bars li[data-q]')) ev.target.click();
  });

  let hours = { out: [], in: [], blocked: [], internal: [] };
  let hoursBytes = { out: [], in: [], blocked: [], internal: [] };
  let sparkMode = store.get('sparkMode', 'hits');
  function renderSpark() {
    const src = sparkMode === 'bytes' ? hoursBytes : hours;
    const fmt = sparkMode === 'bytes' ? fmtBytes : (v => nf.format(v));
    $('sparkTitle').textContent = sparkMode === 'bytes' ? 'Volume per hour' : 'Connections per hour';
    const dirs = ['out', 'in', 'blocked', 'internal'].filter(d => filters[d] && !(sparkMode === 'bytes' && d === 'blocked'));
    const sums = new Array(24).fill(0);
    dirs.forEach(d => (src[d] || []).forEach((v, i) => { sums[i] += v || 0; }));
    const max = Math.max(1, ...sums);
    $('spark').replaceChildren(...sums.map((sum, i) => {
      const col = el('div', 'col');
      col.title = `${23 - i ? '−' + (23 - i) + ' h' : 'current hour'}: ` + dirs.map(d => `${VERB[d]} ${fmt((src[d] || [])[i] || 0)}`).join(', ');
      dirs.forEach(d => {
        const v = (src[d] || [])[i] || 0;
        if (!v) return;
        const seg = el('i'); seg.style.height = (v / max * 100) + '%'; seg.style.background = COLORS[d];
        col.append(seg);
      });
      return col;
    }));
  }

  function renderTotals(t) {
    for (const k of ['blocked', 'out', 'in', 'internal']) {
      $('t-' + k).textContent = fmtNum(t[k]?.hits || 0);
      const v = $('v-' + k); if (v) v.textContent = t[k]?.bytes ? '· ' + fmtBytes(t[k].bytes) : '';
    }
  }

  const statsState = $('statsState');
  async function loadStats() {
    if (document.hidden) return;
    try {
      const T = '_time:24h';
      const jobs = {
        totals: vl(`${T} | stats by (dir) count() if (leg:req) as hits, sum(bytes) as bytes`),
        hours: vl(`${T} | stats by (_time:1h, dir) count() if (leg:req) as hits, sum(bytes) as bytes`),
        uniq: vl(`${T} (dir:out or dir:"in") | stats count_uniq(remote_ip) as r, count_uniq(r_country) as c, count_uniq(local_ip) as l, count_uniq(r_org) as o`),
        services: vl(`${T} dir:out leg:req | stats by (dport, proto) count() as v | sort by (v desc) | limit 6`),
        biggest: vl(`${T} dir:out | stats by (local_ip, local_name, r_org, remote_ip) sum(bytes) as v | sort by (v desc) | limit 6`),
        longest: vl(`${T} dir:out leg:req duration_ms:>0 | stats by (local_ip, local_name, r_org, remote_ip) sum(duration_ms) as v | sort by (v desc) | limit 6`),
        orgs: vl(`${T} dir:out r_org:* | stats by (r_org) sum(bytes) as v | sort by (v desc) | limit 6`),
        cOut: vl(`${T} dir:out leg:req r_country:* | stats by (r_country, r_country_name) count() as v | sort by (v desc) | limit 6`),
        devices: vl(`${T} (dir:out or dir:"in") | stats by (local_ip, local_name) sum(bytes) as v | sort by (v desc) | limit 6`),
        inbound: vl(`${T} dir:"in" leg:req | stats by (dport, proto) count() as v | sort by (v desc) | limit 6`),
        cAll: vl(`${T} (dir:out or dir:"in") r_country:* | stats by (r_country) count() if (leg:req) as n, sum(bytes) as b`)
      };
      if (filters.blocked) {
        jobs.cBlk = vl(`${T} dir:blocked | stats by (r_country, r_country_name) count() as v | sort by (v desc) | limit 6`);
        jobs.ports = vl(`${T} dir:blocked | stats by (dport) count() as v | sort by (v desc) | limit 6`);
      }
      if (filters.internal) {
        jobs.internal = vl(`${T} dir:internal leg:req | stats by (local_ip, local_name, remote_ip, remote_name, dport) count() as v | sort by (v desc) | limit 8`);
      }
      const keys = Object.keys(jobs);
      const res = Object.fromEntries((await Promise.all(Object.values(jobs))).map((v, i) => [keys[i], v]));

      const t = {}; res.totals.forEach(r => { t[r.dir] = { hits: +r.hits, bytes: +r.bytes }; }); renderTotals(t);
      const hourStart = Math.floor(Date.now() / 3600000) * 3600000;
      hours = { out: new Array(24).fill(0), in: new Array(24).fill(0), blocked: new Array(24).fill(0), internal: new Array(24).fill(0) };
      hoursBytes = { out: new Array(24).fill(0), in: new Array(24).fill(0), blocked: new Array(24).fill(0), internal: new Array(24).fill(0) };
      res.hours.forEach(r => { const idx = 23 - Math.round((hourStart - Date.parse(r._time)) / 3600000);
        if (hours[r.dir] && idx >= 0 && idx < 24) { hours[r.dir][idx] += +r.hits || 0; hoursBytes[r.dir][idx] += +r.bytes || 0; } });
      const u = res.uniq[0] || {};
      $('uniq').textContent = `${fmtNum(u.r)} destinations · ${fmtNum(u.o)} companies · ${fmtNum(u.c)} countries · ${fmtNum(u.l)} devices`;
      renderSpark();

      countryStats.clear(); res.cAll.forEach(r => countryStats.set(r.r_country, { n: +r.n || 0, b: +r.b || 0 })); refreshPolys();
      renderBars($('topOrgs'), res.orgs, r => r.r_org, 'v', fmtBytes, null, undefined, r => ['org', r.r_org]);
      renderBars($('topCountriesOut'), res.cOut, r => `${flag(r.r_country)} ${country(r.r_country, r.r_country_name) || 'unknown'}`, 'v', null, null, undefined, r => ['country', r.r_country]);
      renderBars($('topDevices'), res.devices, r => nameOf(r.local_ip, r.local_name), 'v', fmtBytes, null, undefined, r => ['device', r.local_ip]);
      renderBars($('topServices'), res.services, r => `${portName(+r.dport)} ${r.proto || ''}`, 'v', null, r => [`dport:${+r.dport || 0}`, 'out']);
      const pair = r => `${nameOf(r.local_ip, r.local_name)} → ${nameOf(r.remote_ip, r.r_org)}`;
      renderBars($('topBiggest'), res.biggest, pair, 'v', fmtBytes, r => [`local_ip:${lq(r.local_ip)} remote_ip:${lq(r.remote_ip)}`, 'out']);
      renderBars($('topLongest'), res.longest, pair, 'v', fmtDur, r => [`local_ip:${lq(r.local_ip)} remote_ip:${lq(r.remote_ip)}`, 'out']);
      renderBars($('topIn'), res.inbound, r => `${portName(+r.dport)} ${r.proto || ''}`, 'v', null, r => [`dport:${+r.dport || 0}`, 'in'], 'None, as it should be');
      if (res.cBlk) renderBars($('topCountries'), res.cBlk, r => `${flag(r.r_country)} ${country(r.r_country, r.r_country_name) || 'unknown'}`, 'v', null, null, undefined, r => ['country', r.r_country]);
      if (res.ports) renderBars($('topPorts'), res.ports, r => portName(+r.dport), 'v', null, r => [`dport:${+r.dport || 0}`, 'blocked']);
      if (res.internal) renderBars($('topInternal'), res.internal, r => `${nameOf(r.local_ip, r.local_name)} → ${nameOf(r.remote_ip, r.remote_name)} · ${portName(+r.dport)}`, 'v', null,
        r => [`local_ip:${lq(r.local_ip)} remote_ip:${lq(r.remote_ip)} dport:${+r.dport || 0}`, 'internal']);
      statsState.textContent = '';
    } catch (err) {
      console.warn('Stats not loaded:', err);
      statsState.textContent = '· history unavailable';
    }
  }

  // ---------- Verlauf ----------
  const drawer = $('history'), qInput = $('q'), rangeSel = $('range'), dirSel = $('dirSel'), info = $('resultInfo');
  const tbody = document.querySelector('#results tbody');
  let lastFocus = null;

  function openHistory(query, dir, range) {
    lastFocus = document.activeElement;
    if (drawer.hidden) showOverlay(drawer);
    if (query != null) qInput.value = query;
    if (dir != null) dirSel.value = dir;
    if (range && [...rangeSel.options].some(o => o.value === range)) rangeSel.value = range;
    qInput.focus();
    if (query != null || dir != null) runSearch();
  }
  function closeHistory() { hideOverlay(drawer); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  $('openHistory').addEventListener('click', () => openHistory());
  $('closeHistory').addEventListener('click', closeHistory);
  drawer.addEventListener('click', ev => { if (ev.target === drawer) closeHistory(); });
  document.addEventListener('keydown', ev => {
    if (ev.key === '/' && drawer.hidden && !/input|select|textarea/i.test(ev.target.tagName)) { ev.preventDefault(); openHistory(); }
  });
  $('searchForm').addEventListener('submit', ev => { ev.preventDefault(); runSearch(); });

  // ---------- Datenquellenstatus ----------
  const systemStatus = $('systemStatus');
  const statusItems = $('systemStatusItems');
  let statusRefreshTimer = null;
  const statusNames = {
    api: 'Dashboard API', live: 'Live stream', history: 'History',
    netflow: 'NetFlow / IPFIX', firewall: 'Firewall events',
    geoipCity: 'GeoIP city database', geoipAsn: 'GeoIP ASN database'
  };
  const statusLabels = { healthy: 'Online', warning: 'Needs update', idle: 'Idle', waiting: 'Waiting for data', down: 'Unavailable' };
  const timeAgo = value => {
    if (!value) return '';
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };
  async function loadSystemStatus() {
    statusItems.replaceChildren(el('p', 'result-info', 'Loading status …'));
    try {
      const r = await fetch('api/status', { cache: 'no-store' });
      if (r.status === 401) return toLogin();
      if (!r.ok) throw new Error(`Status request failed (HTTP ${r.status})`);
      const data = await r.json();
      statusItems.replaceChildren(...Object.entries(statusNames).map(([key, name]) => {
        const item = el('article', 'status-item');
        const value = data[key] || { state: 'down', detail: 'No status received' };
        item.dataset.state = value.state;
        const title = el('h3', null, name);
        const state = el('div', 'status-state', statusLabels[value.state] || 'Unknown');
        const detail = value.lastSeen ? `${value.detail} · ${timeAgo(value.lastSeen)}` : value.detail;
        item.append(title, state, el('p', null, detail));
        return item;
      }));
      $('systemStatusChecked').textContent = `Checked ${new Date(data.checkedAt).toLocaleTimeString(LOCALE)}`;
    } catch (err) {
      statusItems.replaceChildren(el('p', 'result-info err', String(err.message || err)));
      $('systemStatusChecked').textContent = '';
    }
  }
  function closeSystemStatus() {
    hideOverlay(systemStatus);
    clearInterval(statusRefreshTimer);
    statusRefreshTimer = null;
  }
  $('openSystemStatus').hidden = isDemo;
  $('openSystemStatus').addEventListener('click', () => {
    if (isDemo) return;
    showOverlay(systemStatus);
    loadSystemStatus();
    clearInterval(statusRefreshTimer);
    statusRefreshTimer = setInterval(loadSystemStatus, 30000);
  });
  $('refreshSystemStatus').addEventListener('click', loadSystemStatus);
  $('closeSystemStatus').addEventListener('click', closeSystemStatus);
  systemStatus.addEventListener('click', ev => { if (ev.target === systemStatus) closeSystemStatus(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !systemStatus.hidden) closeSystemStatus(); });

  const FIELDS = ['_msg', '_time', '_stream', 'kind', 'dir', 'bdir', 'leg', 'proto', 'local_ip', 'local_name', 'remote_ip', 'remote_name',
    'sport', 'dport', 'bytes', 'packets', 'rule', 'r_country', 'r_country_name', 'r_city', 'r_org', 'r_asn', 'r_lat', 'r_lon'];
  const FIELD_RE = new RegExp(`(^|[\\s(!-])(${FIELDS.join('|')}):`);

  function buildQuery() {
    const text = qInput.value.trim();
    const parts = [`_time:${rangeSel.value}`];
    if (dirSel.value) parts.push(`dir:${lq(dirSel.value)}`);
    parts.push('-leg:resp');
    let advanced = false;
    if (text) {
      // LogsQL direkt, wenn es danach aussieht (feld:wert, Pipes, Klammern); sonst Wortsuche
      advanced = FIELD_RE.test(text) || /[|()]|\b(AND|OR|NOT)\b/.test(text);
      if (advanced) parts.push(`(${text.replace(/\|.*$/s, '').trim() || '*'})`);
      else {
        const byName = t => [...names].filter(([, n]) => n.toLowerCase() === t.toLowerCase()).map(([ip]) => ip);
        const term = t => { const ips = byName(t); return ips.length ? `(${[lq(t), ...ips.flatMap(ip => [`local_ip:${lq(ip)}`, `remote_ip:${lq(ip)}`])].join(' OR ')})` : lq(t); };
        if (byName(text).length) parts.push(term(text));
        else for (const w of text.split(/\s+/)) parts.push(term(w));
      }
    }
    const pipe = advanced && text.includes('|') ? ' | ' + text.slice(text.indexOf('|') + 1).trim() : '';
    return parts.join(' ') + (pipe || ` | sort by (_time desc) | limit ${CONFIG.historyLimit}`);
  }

  let searchSeq = 0;
  async function runSearch() {
    const q = buildQuery();
    const seq = ++searchSeq;
    info.classList.remove('err');
    info.textContent = 'Searching …';
    try {
      const rows = isDemo ? demoSearch() : await vl(q, CONFIG.historyLimit);
      if (seq !== searchSeq) return;
      renderResults(rows);
      info.replaceChildren(
        `${nf.format(rows.length)} results` + (rows.length >= CONFIG.historyLimit ? ` (newest ${CONFIG.historyLimit})` : '') + ' · Query: ',
        el('code', null, q)
      );
      $('vmuiLink').href = 'select/vmui/#/?query=' + encodeURIComponent(q);
    } catch (err) {
      if (seq !== searchSeq) return;
      info.classList.add('err');
      info.textContent = String(err.message || err);
      tbody.replaceChildren();
    }
  }

  function renderResults(rows) {
    tbody.replaceChildren(...rows.map(r => {
      const tr = el('tr');
      const ts = r._time ? new Date(r._time) : null;
      const tdTime = el('td', 'mono', ts ? ts.toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
      const tdDir = el('td', null, VERB[r.dir] || r.dir || ''); tdDir.dataset.dir = r.dir || '';
      const tdLocal = el('td'); const ln = nameOf(r.local_ip, r.local_name); tdLocal.append(ln);
      if (ln !== r.local_ip) tdLocal.append(' ', el('small', null, r.local_ip));
      if (r.local_ip) tdLocal.append(nameBtn(r.local_ip));
      const tdRemote = el('td'); tdRemote.append(nameOf(r.remote_ip, r.remote_name));
      if (r.r_org) tdRemote.append(' ', el('small', null, r.r_org));
      if (r.remote_ip) tdRemote.append(nameBtn(r.remote_ip));
      const place = r.dir === 'internal' ? '' : `${flag(r.r_country)} ${[r.r_city, country(r.r_country, r.r_country_name)].filter(Boolean).join(', ')}`;
      const tdPlace = el('td', null, place);
      const tdSvc = el('td', 'mono', `${portName(r.dport)}${r.proto ? ' ' + r.proto : ''}`);
      if (r.rule) tdSvc.title = `Rule: ${r.rule}`;
      const tdBytes = el('td', 'num', r.dir === 'blocked' ? '' : fmtBytes(r.bytes));
      const tdDur = el('td', 'num', fmtDur(r.duration_ms));
      tr.append(tdTime, tdDir, tdLocal, tdRemote, tdPlace, tdSvc, tdBytes, tdDur);
      tr.addEventListener('click', () => { if (r.r_lat != null) { closeHistory(); focusOn(r.r_lat, r.r_lon); } });
      return tr;
    }));
  }

  // ---------- Live-Verbindung ----------
  const statusEl = $('status'), statusText = $('statusText'), hint = $('hint');
  const setStatus = (state, text) => { if (statusEl.dataset.state !== state || statusText.textContent !== text) { statusEl.dataset.state = state; statusText.textContent = text; } };
  function showHint(text, withDemo) {
    hint.hidden = false; hint.replaceChildren(text);
    if (withDemo) { const b = el('button', null, 'Start demo'); b.addEventListener('click', startDemo); hint.append(b); }
  }
  let ws = null, fails = 0, demoTimer = null, reconnectTimer = null;

  function connect() {
    clearTimeout(reconnectTimer);
    setStatus('connecting', 'Connecting …');
    try { ws = new WebSocket(CONFIG.wsUrl); } catch { return scheduleReconnect(); }
    ws.onopen = () => { fails = 0; hint.hidden = true; lastEventAt = Date.now(); setStatus('live', 'Live'); };
    ws.onmessage = m => { try { handle(JSON.parse(m.data)); } catch {} };
    ws.onclose = () => { ws = null; if (!demoTimer) scheduleReconnect(); };
    ws.onerror = () => { try { ws && ws.close(); } catch {} };
  }
  function scheduleReconnect() {
    fails++;
    const wait = Math.min(30, 2 ** Math.min(fails, 5));
    setStatus('down', `Disconnected · retrying in ${wait} s`);
    if (fails >= 2) checkSession();   // WebSocket meldet 401 nicht – Sitzung gezielt prüfen
    if (fails >= 3) showHint('No live stream at /ws. Is the collector running? (docker compose ps)', true);
    reconnectTimer = setTimeout(() => { if (!demoTimer) connect(); }, wait * 1000);
  }

  // ---------- Demo-Modus ----------
  const SRC_BLOCK = [
    ['CN','Beijing',39.9,116.4,'China Telecom',9], ['CN','Shanghai',31.2,121.5,'China Unicom',7],
    ['CN','Guangzhou',23.1,113.3,'Tencent Cloud',5], ['RU','Moscow',55.75,37.6,'Selectel',6],
    ['RU','Saint Petersburg',59.9,30.3,'Rostelecom',3], ['US','Ashburn',39.0,-77.5,'Amazon AWS',6],
    ['US','San Jose',37.3,-121.9,'Censys',4], ['US','Chicago',41.9,-87.6,'Shodan',3],
    ['NL','Amsterdam',52.37,4.9,'DigitalOcean',5], ['BG','Sofia',42.7,23.3,'Neterra',3],
    ['BR','São Paulo',-23.5,-46.6,'Vivo',3], ['IN','Mumbai',19.1,72.9,'Reliance Jio',3],
    ['VN','Hanoi',21.0,105.8,'VNPT',2], ['KR','Seoul',37.6,127.0,'KT Corp',2],
    ['IR','Tehran',35.7,51.4,'TCI',2], ['SG','Singapore',1.35,103.8,'Alibaba Cloud',2],
    ['DE','Falkenstein',50.5,12.4,'Hetzner',3], ['PR','San Juan',18.47,-66.1,'Liberty',1]
  ];
  const DST_OUT = [
    ['US','Mountain View',37.4,-122.1,'Google LLC',8,443], ['NL','Amsterdam',52.37,4.9,'Netflix',4,443],
    ['US','Cupertino',37.3,-122.0,'Apple Inc.',5,443], ['IE','Dublin',53.35,-6.26,'Microsoft',4,443],
    ['SE','Stockholm',59.33,18.07,'Spotify',3,443], ['US','San Francisco',37.77,-122.42,'GitHub',3,443],
    ['US','Ashburn',39.0,-77.5,'Ubiquiti Cloud',2,443], ['US','Boardman',45.8,-119.7,'Nabu Casa',2,443],
    ['DE','Falkenstein',50.5,12.4,'Hetzner',2,443], ['DE','Frankfurt',50.11,8.68,'Cloudflare',5,7844],
    ['JP','Tokyo',35.68,139.7,'Nintendo',1,443], ['US','Mountain View',37.4,-122.1,'Google LLC',3,53]
  ];
  const LOCALS = ['homelable', 'Homeassistant-PI', 'MacBook', 'iPhone', 'QuantumGateway (WAN)'];
  const SCAN_PORTS = [[22,10],[23,5],[3389,6],[80,4],[443,3],[445,4],[8080,3],[5900,2],[1433,2],[7547,2],[6379,1],[8291,1],[2323,2]];
  const INTERNAL = [['Homeassistant-PI','homelable',8006],['MacBook','homelable',8006],['iPhone','Homeassistant-PI',8123],['Homeassistant-PI','homelable',1883]];
  const pickW = (list, wi) => { const sum = list.reduce((s, x) => s + x[wi], 0); let r = Math.random() * sum;
    for (const x of list) { r -= x[wi]; if (r <= 0) return x; } return list[0]; };
  const rndIp = () => [1 + Math.random() * 222, Math.random() * 255, Math.random() * 255, 1 + Math.random() * 253].map(Math.floor).join('.');
  const jitter = v => v + (Math.random() - .5) * 1.5;
  const demo = { totals: { blocked: { hits: 18342 }, out: { hits: 96210, bytes: 48e9 }, in: { hits: 12, bytes: 3e6 }, internal: { hits: 40118, bytes: 9e9 } },
    cBlk: new Map(), ports: new Map(), orgs: new Map(), cOut: new Map(), devices: new Map(), services: new Map(),
    biggest: new Map(), longest: new Map(), log: [] };

  function demoEvent() {
    const roll = Math.random();
    const add = (m, k, field, v, base) => { const r = m.get(k) || Object.assign({ v: 0 }, base); r.v += v; m.set(k, r); };
    const remember = e => { demo.log.unshift(Object.assign({ _time: new Date().toISOString() }, e)); if (demo.log.length > 300) demo.log.pop(); };
    if (roll < 0.30) {
      const s = pickW(SRC_BLOCK, 5), p = pickW(SCAN_PORTS, 1)[0];
      const n = Math.random() < 0.06 ? 8 : 1;               // ab und zu ein Port-Scan in Serie
      const ip = rndIp();
      for (let i = 0; i < n; i++) setTimeout(() => {
        const port = n > 1 ? pickW(SCAN_PORTS, 1)[0] : p;
        const e = { kind: 'blocked', dir: 'blocked', bdir: 'in', leg: 'req', proto: 'TCP', dport: port, remote_ip: ip,
          local_ip: '217.230.40.237', local_name: 'QuantumGateway (WAN)', r_country: s[0], r_city: s[1],
          r_lat: jitter(s[2]), r_lon: jitter(s[3]), r_org: s[4], rule: 'Log scanners' };
        handle(e); remember(e);
        demo.totals.blocked.hits++; add(demo.cBlk, s[0], 'v', 1, { r_country: s[0] }); add(demo.ports, port, 'v', 1, { dport: port });
        hours.blocked[23]++;
      }, i * 90);
    } else if (roll < 0.86) {
      const d = pickW(DST_OUT, 5), bytes = Math.floor(Math.random() * 2e6), dev = LOCALS[Math.floor(Math.random() * LOCALS.length)];
      const e = { kind: 'flow', dir: 'out', leg: 'req', proto: d[6] === 53 ? 'UDP' : 'TCP', dport: d[6], remote_ip: rndIp(),
        local_ip: '10.37.10.' + (2 + LOCALS.indexOf(dev)), local_name: dev, sport: 40000 + Math.floor(Math.random() * 20000),
        r_country: d[0], r_city: d[1], r_lat: d[2], r_lon: d[3], r_org: d[4], bytes: Math.floor(bytes / 20),
        duration_ms: Math.floor(Math.random() ** 3 * 600000) };
      e.down = Math.random() < 0.15 ? bytes * 60 : bytes;
      handle(e); remember(e);
      demo.totals.out.hits++; demo.totals.out.bytes += bytes * 6; hours.out[23]++; hoursBytes.out[23] += bytes * 6;
      add(demo.services, d[6], 'v', 1, { dport: d[6], proto: e.proto });
      add(demo.biggest, dev + d[4], 'v', e.down + e.bytes, { local_name: dev, r_org: d[4] });
      add(demo.longest, dev + d[4], 'v', e.duration_ms, { local_name: dev, r_org: d[4] });
      add(demo.orgs, d[4], 'v', bytes * 6, { r_org: d[4] }); add(demo.cOut, d[0], 'v', 1, { r_country: d[0] });
      add(demo.devices, dev, 'v', bytes * 6, { local_name: dev, local_ip: e.local_ip });
    } else if (roll < 0.995) {
      const [a, b, port] = INTERNAL[Math.floor(Math.random() * INTERNAL.length)];
      const e = { kind: 'flow', dir: 'internal', leg: 'req', proto: 'TCP', dport: port, local_ip: '10.37.20.' + (a.length % 9 + 2), local_name: a, remote_ip: '10.37.10.' + (b.length % 9 + 2), remote_name: b, bytes: 40000 };
      handle(e); remember(e);
      demo.totals.internal.hits++; hours.internal[23]++;
    } else {
      const e = { kind: 'flow', dir: 'in', leg: 'req', proto: 'UDP', dport: 51820, remote_ip: rndIp(), local_ip: '217.230.40.237',
        local_name: 'QuantumGateway (WAN)', r_country: 'IT', r_city: 'Milan', r_lat: 45.46, r_lon: 9.19, r_org: 'Vodafone Italia', bytes: 90000 };
      handle(e); remember(e);
      demo.totals.in.hits++; hours.in[23]++;
    }
  }
  function demoStats() {
    renderTotals(demo.totals);
    const top = m => [...m.values()].sort((a, b) => b.v - a.v).slice(0, 6);
    renderBars($('topCountries'), top(demo.cBlk), r => `${flag(r.r_country)} ${country(r.r_country)}`, 'v', null, r => [`r_country:${r.r_country}`, 'blocked']);
    renderBars($('topPorts'), top(demo.ports), r => portName(+r.dport), 'v', null, r => [`dport:${r.dport}`, 'blocked']);
    renderBars($('topOrgs'), top(demo.orgs), r => r.r_org, 'v', fmtBytes, r => [`r_org:${lq(r.r_org)}`, 'out']);
    renderBars($('topCountriesOut'), top(demo.cOut), r => `${flag(r.r_country)} ${country(r.r_country)}`, 'v', null, r => [`r_country:${r.r_country}`, 'out']);
    renderBars($('topDevices'), top(demo.devices), r => r.local_name, 'v', fmtBytes, r => [`local_ip:${lq(r.local_ip)}`, '']);
    renderBars($('topServices'), top(demo.services), r => `${portName(r.dport)} ${r.proto}`, 'v');
    renderBars($('topBiggest'), top(demo.biggest), r => `${r.local_name} → ${r.r_org}`, 'v', fmtBytes);
    renderBars($('topLongest'), top(demo.longest), r => `${r.local_name} → ${r.r_org}`, 'v', fmtDur);
    $('uniq').textContent = `${nf.format(demo.orgs.size * 37)} destinations · ${demo.orgs.size} companies · ${demo.cOut.size} countries · ${LOCALS.length} devices`;
    renderBars($('topIn'), [{ dport: 51820, proto: 'UDP', v: demo.totals.in.hits }], r => `${portName(r.dport)} ${r.proto}`, 'v', null, () => ['dport:51820', 'in']);
    renderBars($('topInternal'), INTERNAL.map(([a, b, p], i) => ({ a, b, p, v: 4000 - i * 700 })), r => `${r.a} → ${r.b} · ${portName(r.p)}`, 'v');
    renderSpark();
  }
  function demoSearch() {
    // Einfache Nachbildung der Suche über die zuletzt erzeugten Demo-Ereignisse
    const words = qInput.value.toLowerCase().split(/\s+/).filter(Boolean).map(w => w.replace(/^[a-z_]+:/, '').replace(/"/g, ''));
    return demo.log.filter(e => (!dirSel.value || e.dir === dirSel.value) &&
      words.every(w => JSON.stringify(e).toLowerCase().includes(w)));
  }
  function startDemo() {
    if (demoTimer) return;
    clearTimeout(reconnectTimer);
    try { ws && ws.close(); } catch {}
    hint.hidden = true; setStatus('demo', 'Demo with sample data');
    for (const d of Object.keys(hours)) {
      hours[d] = Array.from({ length: 24 }, () => Math.floor((d === 'out' ? 900 : d === 'blocked' ? 500 : d === 'internal' ? 600 : 1) * (0.5 + Math.random())));
      hoursBytes[d] = hours[d].map(v => d === 'blocked' ? 0 : v * (2e5 + Math.random() * 3e6));
    }
    const tick = () => { demoEvent(); demoTimer = setTimeout(tick, 120 + Math.random() * 380); };
    tick(); setInterval(demoStats, 2000); demoStats();
  }

  // ---------- Namen (im Dashboard vergeben, gespeichert über /api/names) ----------
  const names = new Map();
  const devicePrefs = new Map();
  let alertRecords = [];
  const nameOf = (ip, fallback) => (ip && names.get(ip)) || fallback || ip || '';
  async function dashboardApi(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (options.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, Object.assign({ cache: 'no-store' }, options, { headers }));
    if (r.status === 401) toLogin();
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }
  const devicePref = ip => devicePrefs.get(ip) || { group: '', note: '', volumeThresholdGiB: 0, volumePeriod: '24h', volumeDirection: 'both' };
  async function loadDashboardData() {
    if (isDemo) {
      alertRecords = [];
      renderAlerts();
      syncBrowserNotificationSetting();
      return;
    }
    const state = await dashboardApi('api/dashboard');
    devicePrefs.clear();
    Object.entries(state.devices || {}).forEach(([ip, pref]) => devicePrefs.set(ip, pref));
    alertRecords = Array.isArray(state.alerts) ? state.alerts : [];
    const legacy = settings.volumeThresholds || {};
    for (const [ip, threshold] of Object.entries(legacy)) {
      if (!devicePrefs.get(ip)?.volumeThresholdGiB && +threshold > 0) {
        await saveDevicePref(ip, Object.assign(devicePref(ip), { volumeThresholdGiB: +threshold }));
      }
    }
    if ('volumeThresholds' in settings || 'volumeAlerted' in settings) {
      delete settings.volumeThresholds;
      delete settings.volumeAlerted;
      saveSettings();
    }
    renderAlerts();
    syncBrowserNotificationSetting();
  }
  async function saveDevicePref(ip, pref) {
    const body = {
      ip, group: pref.group || '', note: pref.note || '',
      volumeThresholdGiB: +pref.volumeThresholdGiB || 0,
      volumePeriod: pref.volumePeriod || '24h',
      volumeDirection: pref.volumeDirection || 'both'
    };
    if (isDemo) {
      devicePrefs.set(ip, body);
      return body;
    }
    const saved = await dashboardApi('api/dashboard/device', { method: 'PUT', body: JSON.stringify(body) });
    devicePrefs.set(ip, saved.device);
    return saved.device;
  }
  async function loadNames() {
    if (isDemo) return;
    try {
      const r = await fetch('api/names', { cache: 'no-store' });
      if (r.status === 401) return toLogin();
      if (r.ok) { names.clear(); (await r.json()).forEach(e => names.set(e.ip, e.name)); }
    } catch {}
  }
  async function saveName(ip, name) {
    if (isDemo) { if (name) names.set(ip, name); else names.delete(ip); return; }
    const r = await fetch('api/names', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, name }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) toLogin();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    if (j.name) names.set(j.ip, j.name); else names.delete(j.ip);
  }

  const nd = $('nameDlg');
  let ndIp = null;
  function editName(ip, suggestion) {
    if (!ip) return;
    ndIp = ip;
    $('ndIp').textContent = ip;
    $('ndInput').value = names.get(ip) || suggestion || '';
    $('ndErr').textContent = '';
    $('ndDelete').hidden = !names.has(ip);
    nd.hidden = false;
    $('ndInput').focus(); $('ndInput').select();
  }
  const closeName = () => { nd.hidden = true; ndIp = null; };
  async function submitName(name) {
    try {
      await saveName(ndIp, name);
      closeName();
      afterNamesChanged();
    } catch (err) { $('ndErr').textContent = String(err.message || err); }
  }
  $('ndForm').addEventListener('submit', ev => { ev.preventDefault(); submitName($('ndInput').value.trim()); });
  $('ndDelete').addEventListener('click', () => submitName(''));
  $('ndCancel').addEventListener('click', closeName);
  nd.addEventListener('click', ev => { if (ev.target === nd) closeName(); });
  function afterNamesChanged() {
    for (const e of conns.values()) {
      if (names.has(e.local_ip)) e.local_name = names.get(e.local_ip);
      if (names.has(e.remote_ip)) e.remote_name = names.get(e.remote_ip);
    }
    loadStats();
    if (!dossier.hidden && dsState) renderDossier();
    if (!devBox.hidden) loadDevices();
  }
  // kleine Schaltfläche „✎“ neben einer IP
  function nameBtn(ip, suggestion) {
    const b = el('button', 'pen', '✎'); b.type = 'button'; b.title = `Name ${ip}`;
    b.addEventListener('click', ev => { ev.stopPropagation(); editName(ip, suggestion); });
    return b;
  }

  // ---------- Fenster-Verwaltung (Escape schließt das oberste) ----------
  const overlays = [];
  function showOverlay(box) { box.hidden = false; overlays.push(box); }
  function hideOverlay(box) { box.hidden = true; const i = overlays.indexOf(box); if (i >= 0) overlays.splice(i, 1); }
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    if (!nd.hidden) { closeName(); return; }
    const top = overlays.pop(); if (top) top.hidden = true;
  }, true);

  // ---------- Dossier: Land, Gerät, Firma oder Gegenstelle ----------
  const dossier = $('dossier');
  let dsState = null, dsSeq = 0;
  const DS_KIND = { country: 'Country', device: 'Device', org: 'Company', ip: 'Remote host' };
  const BUCKET = { '1h': [300000, '5m'], '24h': [3600000, '1h'], '7d': [21600000, '6h'], '30d': [86400000, '1d'] };
  const dsFilter = s => s.type === 'country' ? `r_country:${lq(s.value)}` : s.type === 'device' ? `local_ip:${lq(s.value)}`
    : s.type === 'org' ? `r_org:${lq(s.value)}` : `remote_ip:${lq(s.value)}`;
  const LIST = {
    country: { title: 'Countries', by: 'r_country', label: r => `${flag(r.r_country)} ${country(r.r_country) || 'unknown'}`, open: r => r.r_country && ['country', r.r_country] },
    org: { title: 'Companies', by: 'r_org', label: r => r.r_org || 'unknown', open: r => r.r_org && ['org', r.r_org] },
    device: { title: 'Devices', by: 'local_ip, local_name', label: r => nameOf(r.local_ip, r.local_name), open: r => ['device', r.local_ip] },
    remote: { title: 'Remote hosts', by: 'remote_ip, remote_name, r_org', label: r => `${nameOf(r.remote_ip, r.remote_name)}${r.r_org ? ' · ' + r.r_org : ''}`, open: r => ['ip', r.remote_ip] },
    port: { title: 'Services', by: 'dport, proto', label: r => `${portName(+r.dport)} ${r.proto || ''}`, open: null }
  };
  const DS_LISTS = { country: ['org', 'device', 'port'], device: ['country', 'org', 'remote'], org: ['country', 'device', 'remote'], ip: ['device', 'port'] };

  function dsTitle(s) {
    if (s.type === 'country') return `${flag(s.value)} ${country(s.value) || s.value}`;
    if (s.type === 'device' || s.type === 'ip') return names.get(s.value) || s.value;
    return s.value;
  }
  function openDossier(type, value) {
    if (!value) return;
    if (isDemo) { toast('Dossiers need real data and are not available in demo mode.'); return; }
    dsState = { type, value };
    if (dossier.hidden) showOverlay(dossier);
    if (type === 'country') focusCountry(value);
    renderDossier();
  }
  $('dsClose').addEventListener('click', () => hideOverlay(dossier));
  dossier.addEventListener('click', ev => { if (ev.target === dossier) hideOverlay(dossier); });
  $('dsRange').addEventListener('change', () => renderDossier());
  $('dsHistory').addEventListener('click', () => openHistory(dsFilter(dsState), '', $('dsRange').value));
  $('dsRename').addEventListener('click', () => editName(dsState.value));

  async function renderDossier() {
    const s = dsState, seq = ++dsSeq, range = $('dsRange').value, F = dsFilter(s), T = `_time:${range}`;
    $('dsKicker').textContent = `Dossier · ${DS_KIND[s.type]}`;
    $('dsTitle').textContent = dsTitle(s);
    $('dsSub').textContent = (s.type === 'device' || s.type === 'ip') && names.has(s.value) ? s.value : '';
    $('dsRename').hidden = !(s.type === 'device' || s.type === 'ip');
    $('dsBody').classList.add('loading');
    const [step, bucket] = BUCKET[range];
    const lists = DS_LISTS[s.type];
    try {
      const jobs = [
        vl(`${T} ${F} -dir:blocked | stats count() if (leg:req) as conns, sum(bytes) as bytes, count_uniq(remote_ip) as rips, count_uniq(local_ip) as lips, count_uniq(r_country) as cc, min(_time) as first, max(_time) as last`),
        vl(`${T} ${F} dir:blocked | stats count() as n`),
        vl(`${T} ${F} -dir:blocked | stats by (_time:${bucket}) count() if (leg:req) as hits, sum(bytes) as bytes`),
        vl(`${T} ${F} -dir:blocked | stats by (local_ip, local_name, remote_ip, remote_name, r_org, r_country, dport, proto, dir) count() if (leg:req) as n, sum(bytes) as b, sum(duration_ms) as d, max(_time) as last | sort by (b desc) | limit 80`),
        ...lists.map(k => vl(`${T} ${F} -dir:blocked | stats by (${LIST[k].by}) count() if (leg:req) as n, sum(bytes) as b | sort by (b desc) | limit 6`))
      ];
      const [kpi, blk, tl, pairs, ...lres] = await Promise.all(jobs);
      if (seq !== dsSeq) return;
      const k = kpi[0] || {};
      const kpis = [
        ['Connections', fmtNum(k.conns)], ['Volume', fmtBytes(k.bytes)],
        [s.type === 'device' ? 'Remote hosts' : 'IP addresses', fmtNum(s.type === 'ip' ? k.lips : k.rips)],
        s.type === 'device' ? ['Countries', fmtNum(k.cc)] : ['Devices', fmtNum(k.lips)],
        ['First seen', k.first ? fmtWhen(k.first) : '–'], ['Last seen', k.last ? fmtWhen(k.last) : '–'],
        ['Blocked', fmtNum((blk[0] || {}).n)]
      ];
      $('dsKpis').replaceChildren(...kpis.map(([l, v]) => { const d = el('div', 'kpi'); d.append(el('b', null, v), el('span', null, l)); return d; }));
      renderTimeline($('dsTimeline'), tl, step, range);
      $('dsLists').replaceChildren(...lists.map((key, i) => {
        const sec = el('section'); const ul = el('ul', 'bars'); ul.dataset.c = 'out';
        sec.append(el('h3', null, LIST[key].title), ul);
        renderBars(ul, lres[i], LIST[key].label, 'b', fmtBytes, null, 'None');
        [...ul.children].forEach((li, j) => { const o = LIST[key].open && lres[i][j] && LIST[key].open(lres[i][j]); if (o && o[1]) { li.dataset.dtype = o[0]; li.dataset.dval = o[1]; li.tabIndex = 0; } });
        return sec;
      }));
      renderPairs(pairs);
      $('dsInfo').textContent = pairs.length >= 80 ? 'The 80 largest connection pairs · see all individual connections via “In history”' : '';
    } catch (err) {
      if (seq !== dsSeq) return;
      $('dsInfo').textContent = String(err.message || err);
    } finally {
      if (seq === dsSeq) $('dsBody').classList.remove('loading');
    }
  }
  const fmtWhen = t => { const d = new Date(t); const today = new Date().toDateString() === d.toDateString();
    return d.toLocaleString(LOCALE, today ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };

  function renderTimeline(box, rows, step, range) {
    const span = { '1h': 3600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[range];
    const end = Math.floor(Date.now() / step) * step, n = Math.round(span / step);
    const hits = new Array(n).fill(0), bytes = new Array(n).fill(0);
    rows.forEach(r => { const i = n - 1 - Math.round((end - Date.parse(r._time)) / step); if (i >= 0 && i < n) { hits[i] += +r.hits || 0; bytes[i] += +r.bytes || 0; } });
    const max = Math.max(1, ...bytes);
    box.replaceChildren(...bytes.map((b, i) => {
      const col = el('i'); col.style.height = Math.max(b ? 4 : 0, b / max * 100) + '%';
      const t = new Date(end - (n - 1 - i) * step);
      col.title = `${t.toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}: ${nf.format(hits[i])} connections · ${fmtBytes(b)}`;
      return col;
    }));
  }

  function renderPairs(rows) {
    const tb = document.querySelector('#dsPairs tbody');
    if (!rows.length) { tb.replaceChildren(); const tr = el('tr'); const td = el('td', 'empty', 'No connections in this time range'); td.colSpan = 8; tr.append(td); tb.append(tr); return; }
    tb.replaceChildren(...rows.map(r => {
      const tr = el('tr');
      const src = el('td'); src.append(nameOf(r.local_ip, r.local_name)); if (nameOf(r.local_ip, r.local_name) !== r.local_ip) src.append(' ', el('small', null, r.local_ip)); src.append(nameBtn(r.local_ip));
      const dst = el('td'); dst.append(nameOf(r.remote_ip, r.remote_name)); if (r.r_org) dst.append(' ', el('small', null, r.r_org)); dst.append(nameBtn(r.remote_ip));
      const dir = el('td', null, VERB[r.dir] || r.dir); dir.dataset.dir = r.dir;
      tr.append(src, dir, dst,
        el('td', null, r.r_country ? `${flag(r.r_country)} ${country(r.r_country)}` : ''),
        el('td', 'mono', `${portName(+r.dport)} ${r.proto || ''}`),
        el('td', 'num', nf.format(+r.n || 0)), el('td', 'num', fmtBytes(r.b)), el('td', 'mono', fmtWhen(r.last)));
      tr.title = `Total duration ${fmtDur(r.d) || '–'} · Click: individual connections in history`;
      tr.addEventListener('click', () => openHistory(`local_ip:${lq(r.local_ip)} remote_ip:${lq(r.remote_ip)} dport:${+r.dport || 0}`, '', $('dsRange').value));
      return tr;
    }));
  }

  // Listen-Einträge mit Dossier-Ziel (linke Spalte, Dossier, Übersichten)
  document.addEventListener('click', ev => {
    const li = ev.target.closest('[data-dtype]');
    if (!li || ev.target.closest('.pen')) return;
    ev.stopImmediatePropagation();
    openDossier(li.dataset.dtype, li.dataset.dval);
  }, true);
  document.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('[data-dtype]')) openDossier(ev.target.dataset.dtype, ev.target.dataset.dval); });

  // ---------- Übersicht: Länder ----------
  const ctyBox = $('countries');
  let ctySort = store.get('ctySort', 'n'), ctyRows = [];
  $('openCountries').addEventListener('click', () => { showOverlay(ctyBox); loadCountries(); });
  $('ctyClose').addEventListener('click', () => hideOverlay(ctyBox));
  ctyBox.addEventListener('click', ev => { if (ev.target === ctyBox) hideOverlay(ctyBox); });
  $('ctyRange').addEventListener('change', loadCountries);
  document.querySelectorAll('#ctyTable th[data-sort]').forEach(th => th.addEventListener('click', () => { ctySort = th.dataset.sort; store.set('ctySort', ctySort); renderCountries(); }));
  async function loadCountries() {
    if (isDemo) { ctyRows = [...demo.cOut.values()].map(r => ({ r_country: r.r_country, n: r.v, b: 0, d: 0, blk: demo.cBlk.get(r.r_country)?.v || 0 })); renderCountries(); return; }
    const T = `_time:${$('ctyRange').value}`;
    $('ctyInfo').textContent = 'Loading …';
    try {
      const [rows, blk] = await Promise.all([
        vl(`${T} (dir:out or dir:"in") r_country:* | stats by (r_country) count() if (leg:req) as n, sum(bytes) as b, count_uniq(local_ip) as d, count_uniq(remote_ip) as ips, max(_time) as last`),
        vl(`${T} dir:blocked r_country:* | stats by (r_country) count() as blk`)
      ]);
      const m = new Map(rows.map(r => [r.r_country, r]));
      blk.forEach(r => { const x = m.get(r.r_country) || { r_country: r.r_country, n: 0, b: 0, d: 0, ips: 0 }; x.blk = r.blk; m.set(r.r_country, x); });
      ctyRows = [...m.values()];
      $('ctyInfo').textContent = `${ctyRows.length} countries`;
      renderCountries();
    } catch (err) { $('ctyInfo').textContent = String(err.message || err); }
  }
  function renderCountries() {
    const key = ctySort;
    const val = r => key === 'name' ? country(r.r_country) : +r[key] || 0;
    const rows = ctyRows.slice().sort((a, b) => key === 'name' ? String(val(a)).localeCompare(val(b), 'en') : val(b) - val(a));
    document.querySelectorAll('#ctyTable th[data-sort]').forEach(th => th.classList.toggle('sorted', th.dataset.sort === key));
    const max = Math.max(1, ...rows.map(r => +r.b || 0));
    document.querySelector('#ctyTable tbody').replaceChildren(...rows.map(r => {
      const tr = el('tr'); tr.dataset.dtype = 'country'; tr.dataset.dval = r.r_country;
      const vol = el('td', 'num'); const bar = el('span', 'mini'); const fill = el('i'); fill.style.width = (+r.b || 0) / max * 100 + '%'; bar.append(fill);
      vol.append(fmtBytes(r.b), bar);
      tr.append(el('td', null, `${flag(r.r_country)} ${country(r.r_country) || r.r_country}`), el('td', 'num', nf.format(+r.n || 0)), vol,
        el('td', 'num', nf.format(+r.d || 0)), el('td', 'num', nf.format(+r.ips || 0)), el('td', 'num blk', r.blk ? nf.format(+r.blk) : ''),
        el('td', 'mono', r.last ? fmtWhen(r.last) : ''));
      return tr;
    }));
  }

  // ---------- Übersicht: Geräte (Namen vergeben) ----------
  const devBox = $('devices');
  $('openDevices').addEventListener('click', () => { showOverlay(devBox); loadDevices(); });
  $('devClose').addEventListener('click', () => hideOverlay(devBox));
  devBox.addEventListener('click', ev => { if (ev.target === devBox) hideOverlay(devBox); });
  $('devFilter').addEventListener('input', () => renderDevices());
  $('devRange').addEventListener('change', loadDevices);
  $('devAdd').addEventListener('click', () => { const ip = prompt('IP address (local or external):'); if (ip) editName(ip.trim()); });
  let devRows = [];
  async function loadDevices() {
    try { await Promise.all([loadNames(), loadDashboardData()]); }
    catch (err) {
      $('devInfo').textContent = `Could not load shared device settings: ${err.message || err}`;
      return;
    }
    let seen = isDemo ? [...demo.devices.values()].map(r => ({ local_ip: r.local_ip, n: 1, b: r.v })) : [];
    if (!isDemo) {
      try {
        $('devInfo').textContent = 'Loading …';
        seen = await vl(`_time:${$('devRange').value} -dir:blocked | stats by (local_ip) count() if (leg:req) as n, sum(bytes) as b, count_uniq(r_country) as cc, count_uniq(remote_ip) as rips, min(_time) as first, max(_time) as last | sort by (b desc) | limit 500`);
      } catch (err) { $('devInfo').textContent = String(err.message || err); }
    }
    const m = new Map(seen.map(r => [r.local_ip, r]));
    for (const ip of names.keys()) if (!m.has(ip)) m.set(ip, { local_ip: ip, n: 0, b: 0, external: !isPrivate(ip) });
    for (const ip of devicePrefs.keys()) if (!m.has(ip)) m.set(ip, { local_ip: ip, n: 0, b: 0, external: !isPrivate(ip) });
    devRows = [...m.values()];
    renderDevices();
  }
  const isPrivate = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|f[cd]|fe80)/i.test(ip);
  function renderDevices() {
    const f = $('devFilter').value.trim().toLowerCase();
    const rows = devRows.filter(r => {
      const pref = devicePref(r.local_ip);
      return !f || r.local_ip.toLowerCase().includes(f) || (names.get(r.local_ip) || '').toLowerCase().includes(f) ||
        pref.group.toLowerCase().includes(f) || pref.note.toLowerCase().includes(f);
    });
    const unnamed = devRows.filter(r => !names.has(r.local_ip) && +r.n > 0).length;
    $('devInfo').textContent = `${devRows.length} addresses · ${names.size} named · ${unnamed} active without a name`;
    document.querySelector('#devTable tbody').replaceChildren(...rows.map(r => {
      const tr = el('tr'); tr.dataset.dtype = r.external ? 'ip' : 'device'; tr.dataset.dval = r.local_ip;
      const nm = el('td'); const n = names.get(r.local_ip);
      if (n) nm.append(el('b', null, n)); else nm.append(el('span', 'unnamed', 'unnamed'));
      nm.append(nameBtn(r.local_ip));
      const pref = devicePref(r.local_ip);
      const group = el('input', 'device-setting');
      group.type = 'text'; group.maxLength = 64; group.placeholder = 'e.g. Servers'; group.value = pref.group || '';
      group.setAttribute('aria-label', `Group for ${nameOf(r.local_ip)}`);
      const note = el('input', 'device-setting device-note');
      note.type = 'text'; note.maxLength = 240; note.placeholder = 'Add a note'; note.value = pref.note || '';
      note.setAttribute('aria-label', `Notes for ${nameOf(r.local_ip)}`);
      const period = el('select', 'device-setting');
      [['1h', '1 h'], ['24h', '24 h'], ['7d', '7 days']].forEach(([value, label]) => {
        const option = el('option', null, label); option.value = value; period.append(option);
      });
      period.value = pref.volumePeriod || '24h';
      period.setAttribute('aria-label', `Volume alert period for ${nameOf(r.local_ip)}`);
      const direction = el('select', 'device-setting');
      [['both', 'Up + down'], ['out', 'Upload'], ['in', 'Download']].forEach(([value, label]) => {
        const option = el('option', null, label); option.value = value; direction.append(option);
      });
      direction.value = pref.volumeDirection || 'both';
      direction.setAttribute('aria-label', `Volume alert direction for ${nameOf(r.local_ip)}`);
      const threshold = el('td', 'num');
      const thresholdInput = el('input', 'volume-threshold');
      thresholdInput.type = 'number'; thresholdInput.min = '0'; thresholdInput.step = '0.1';
      thresholdInput.placeholder = 'Off'; thresholdInput.value = +pref.volumeThresholdGiB || '';
      thresholdInput.setAttribute('aria-label', `Volume alert threshold in GiB for ${nameOf(r.local_ip)}`);
      thresholdInput.title = 'GiB in the selected rolling period; enter 0 or leave empty to disable';
      const controls = [group, note, period, direction, thresholdInput];
      controls.forEach(control => {
        control.addEventListener('click', ev => ev.stopPropagation());
        control.addEventListener('keydown', ev => ev.stopPropagation());
        control.addEventListener('change', async () => {
          const value = thresholdInput.value.trim();
          const thresholdGiB = value === '' ? 0 : Number(value);
          if (!Number.isFinite(thresholdGiB) || thresholdGiB < 0 || thresholdGiB > 1_000_000) {
            thresholdInput.value = +devicePref(r.local_ip).volumeThresholdGiB || '';
            return;
          }
          try {
            await saveDevicePref(r.local_ip, {
              group: group.value, note: note.value, volumePeriod: period.value,
              volumeDirection: direction.value, volumeThresholdGiB: thresholdGiB
            });
          } catch (err) {
            toast(`Could not save device settings: ${err.message || err}`, null, 'info');
            loadDevices();
          }
        });
      });
      const groupCell = el('td'); groupCell.append(group);
      const noteCell = el('td'); noteCell.append(note);
      const periodCell = el('td'); periodCell.append(period);
      const directionCell = el('td'); directionCell.append(direction);
      threshold.append(thresholdInput);
      tr.append(nm, el('td', 'mono', r.local_ip + (r.external ? ' (external)' : '')), groupCell, noteCell, el('td', 'num', nf.format(+r.n || 0)), el('td', 'num', fmtBytes(r.b)),
        el('td', 'num', nf.format(+r.rips || 0)), el('td', 'num', nf.format(+r.cc || 0)),
        el('td', 'mono', r.first ? fmtWhen(r.first) : '–'), el('td', 'mono', r.last ? fmtWhen(r.last) : '–'),
        periodCell, directionCell, threshold);
      return tr;
    }));
  }

  // ---------- Länderflächen auf dem Globus ----------
  const countryStats = new Map();             // ISO -> { n, b } der letzten 24 h
  const featureByIso = new Map();
  let polyHover = null, polySelected = null;
  let countryFeatures = [];
  // Grenzen 1:50m für Nahansichten (Karte und Globus), erst bei Bedarf geladen
  let detailGeo = null;
  const loadDetailGeo = () => detailGeo || (detailGeo = fetch(CONFIG.textures + 'countries-50m.geojson')
    .then(r => r.json()).then(g => g.features)
    .catch(err => { console.warn('Detailed borders not loaded:', err); return null; }));
  async function initCountries() {
    if (lite) return;
    try {
      const geo = await (await fetch(CONFIG.textures + 'countries.geojson')).json();
      geo.features.forEach(f => { if (f.properties.iso) featureByIso.set(f.properties.iso, f); });
      countryFeatures = geo.features; flatDirty = true;
      if (!world) return;
      world
        .polygonsData(geo.features)
        .polygonAltitude(d => sameCountry(d, polyHover) || sameCountry(d, polySelected) ? 0.012 : 0.004)
        .polygonCapColor(polyColor)
        .polygonSideMaterial(noSideMaterial)
        .polygonStrokeColor(polyStroke)
        .polygonsTransitionDuration(250)
        .polygonLabel(polyLabel)
        .onPolygonHover(d => { polyHover = d; globeEl.style.cursor = d ? 'pointer' : ''; refreshPolys(); })
        .onPolygonClick(d => { if (d.properties.iso) openDossier('country', d.properties.iso); });
    } catch (err) { console.warn('Country shapes not loaded:', err); }
  }
  let sideMat = null;
  const noSideMaterial = () => sideMat || (sideMat = new (world.globeMaterial().constructor)({ visible: false }));
  function polyLabel(d) {
    const iso = d.properties.iso, s = countryStats.get(iso);
    const box = el('div');
    box.append(el('b', null, `${flag(iso)} ${country(iso, d.properties.name)}`), el('br'),
      s ? `${nf.format(s.n)} connections · ${fmtBytes(s.b)} (24 h)` : 'no connections (24 h)');
    return box.outerHTML;
  }
  // Globus (1:110m) und flache Karte (1:50m) haben eigene Objekte – daher über den ISO-Code vergleichen
  const sameCountry = (a, b) => !!a && !!b && (a === b || (!!a.properties.iso && a.properties.iso === b.properties.iso));
  function polyColor(d) {
    if (sameCountry(d, polySelected)) return 'rgba(242,193,78,0.35)';
    const s = settings.choropleth ? countryStats.get(d.properties.iso) : null;
    const hover = sameCountry(d, polyHover) ? 0.12 : 0;
    if (!s || !s.n) return rgba(COLORS.out, hover);
    const max = Math.max(...[...countryStats.values()].map(x => x.n), 1);
    const a = 0.08 + 0.42 * Math.log10(s.n + 1) / Math.log10(max + 1);
    return rgba(COLORS.out, (a + hover).toFixed(3));
  }
  function polyStroke(d) {
    if (sameCountry(d, polySelected)) return 'rgba(242,193,78,0.9)';
    if (!settings.borders) return 'rgba(0,0,0,0)';
    return rgba(COLORS.out, settings.globeStyle === 'plain' ? 0.32 : 0.14);
  }
  function refreshPolys() {
    flatDirty = true;
    if (world && featureByIso.size) world.polygonCapColor(polyColor).polygonStrokeColor(polyStroke).polygonAltitude(world.polygonAltitude());
  }
  function focusCountry(iso) {
    const f = featureByIso.get(iso);
    polySelected = f || null; refreshPolys();
    if (!f) return;
    // Mittelpunkt grob über die Bounding-Box des größten Teilstücks
    let ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates.map(p => p[0]).sort((a, b) => b.length - a.length)[0];
    const lngs = ring.map(c => c[0]), lats = ring.map(c => c[1]);
    focusOn((Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lngs) + Math.max(...lngs)) / 2);
  }
  // Auswahl aufheben, wenn das Dossier zugeht
  new MutationObserver(() => { if (dossier.hidden && polySelected) { polySelected = null; refreshPolys(); } }).observe(dossier, { attributes: true, attributeFilter: ['hidden'] });

  // ---------- Flache Karte (Plattkarte, Canvas 2D) ----------
  // Zeigt dieselben Bögen, Ringe, Hotspots und Länder wie der Globus. Ziehen verschiebt,
  // Mausrad zoomt, Klick auf Land oder Punkt öffnet das Dossier. Ost-West läuft endlos weiter.
  const flatEl = $('flat'), flatTip = $('flatTip');
  const flat = { ctx: flatEl.getContext('2d'), bg: document.createElement('canvas'), w: 0, h: 0, dpr: 1,
    lng: CONFIG.home.lng, lat: 20, zoom: 1, img: null, paths: null, raf: 0, anim: null, drag: null, hoverQueued: false };
  let flatDirty = true;
  const FLAT_MAX_ZOOM = 12;
  // Nachttextur (NASA Black Marble) in Stufen: 0 = Basisbild 4096 × 2048, darüber 512-px-Kacheln
  // unter vendor/night/<stufe>/<zeile>-<spalte>.jpg. Geladen wird nur, was im Ausschnitt liegt.
  const NIGHT = [{ ppd: 4096 / 360 }, { ppd: 8192 / 360, cols: 16, rows: 8 }, { ppd: 13312 / 360, cols: 26, rows: 13 }];
  const tileCache = new Map();   // zuletzt benutzte Kacheln hinten; begrenzt auf 300
  // Grenzen 1:50m für die Nahansicht, erst beim ersten Hineinzoomen geladen
  const detail = { paths: null, loading: false };

  function applyView() {
    const isFlat = settings.view === 'flat';
    globeEl.hidden = isFlat; flatEl.hidden = !isFlat;
    if (!isFlat) flatTip.hidden = true;
    if (world) { if (isFlat) world.pauseAnimation(); else if (!document.hidden) { world.resumeAnimation(); resizeGlobe(); dirty = true; } }
    if (isFlat && !flat.raf) { flatResize(); flat.raf = requestAnimationFrame(flatFrame); }
    if (!isFlat && flat.raf) { cancelAnimationFrame(flat.raf); flat.raf = 0; }
  }

  const flatScale = () => Math.max(flat.w / 360, flat.h / 180) * flat.zoom;   // Pixel pro Grad
  const wrapLng = l => ((l + 180) % 360 + 360) % 360 - 180;
  function flatClamp() {
    const half = flat.h / 2 / flatScale();
    flat.lat = half >= 90 ? 0 : Math.max(-90 + half, Math.min(90 - half, flat.lat));
    flat.lng = wrapLng(flat.lng);
  }
  // Längengrad -> x für eine der Kopien (k = -1, 0, 1) der Welt
  const fx = (lng, k = 0) => flat.w / 2 + (lng - flat.lng + k * 360) * flatScale();
  const fy = lat => flat.h / 2 - (lat - flat.lat) * flatScale();
  // Kopie, in der ein Punkt der Bildmitte am nächsten liegt
  const nearK = lng => Math.round((flat.lng - lng) / 360);

  function flatResize() {
    if (flatEl.hidden) return;
    flat.dpr = lite ? 1 : Math.min(devicePixelRatio || 1, 2);
    flat.w = flatEl.clientWidth; flat.h = flatEl.clientHeight;
    for (const c of [flatEl, flat.bg]) { c.width = Math.round(flat.w * flat.dpr); c.height = Math.round(flat.h * flat.dpr); }
    flatClamp(); flatDirty = true;
  }
  addEventListener('resize', flatResize);

  // Länderpfade in Grad (x = Länge, y = Breite) mit Begrenzungsrahmen fürs Aussortieren
  function buildPaths(features) {
    return features.map(f => {
      const path = new Path2D(), box = [180, 90, -180, -90];
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      for (const poly of polys) for (const ring of poly) {
        ring.forEach(([x, y], i) => {
          if (i) path.lineTo(x, y); else path.moveTo(x, y);
          if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
        });
        path.closePath();
      }
      return { f, path, box };
    });
  }
  function flatPaths() {
    if (flat.zoom >= 2 && !lite) {
      if (detail.paths) return detail.paths;
      if (!detail.loading) {
        detail.loading = true;
        loadDetailGeo().then(fs => { if (fs) { detail.paths = buildPaths(fs); flatDirty = true; } });
      }
    }
    if (!flat.paths && countryFeatures.length) flat.paths = buildPaths(countryFeatures);
    return flat.paths;
  }
  // Sichtbarer Ausschnitt der Kopie k in Grad
  function flatView(k) {
    const sc = flatScale(), lng = flat.lng - k * 360;
    return { w: lng - flat.w / 2 / sc, e: lng + flat.w / 2 / sc, n: flat.lat + flat.h / 2 / sc, s: flat.lat - flat.h / 2 / sc };
  }
  const inView = (b, v) => b[2] >= v.w && b[0] <= v.e && b[3] >= v.s && b[1] <= v.n;

  function nightTile(z, y, x, load) {
    const key = z + '/' + y + '-' + x;
    let img = tileCache.get(key);
    if (img) { tileCache.delete(key); tileCache.set(key, img); return img; }
    if (!load) return null;
    img = new Image(); img.onload = () => { flatDirty = true; };
    img.src = CONFIG.textures + 'night/' + key + '.jpg';
    tileCache.set(key, img);
    if (tileCache.size > 300) tileCache.delete(tileCache.keys().next().value);
    return img;
  }
  // Kacheln einer Stufe im Ausschnitt, in Geräte-Pixeln und gerundet (sonst feine Fugen zwischen Kacheln)
  function drawTiles(c, z, k, v, load) {
    const L = NIGHT[z], tw = 360 / L.cols, th = 180 / L.rows, d = flat.dpr;
    const x0 = Math.max(0, Math.floor((v.w + 180) / tw)), x1 = Math.min(L.cols - 1, Math.floor((v.e + 180) / tw));
    const y0 = Math.max(0, Math.floor((90 - v.n) / th)), y1 = Math.min(L.rows - 1, Math.floor((90 - v.s) / th));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const img = nightTile(z, y, x, load);
      if (!img || !img.complete || !img.naturalWidth) continue;
      const l = Math.round(fx(-180 + x * tw, k) * d), r = Math.round(fx(-180 + (x + 1) * tw, k) * d);
      const t = Math.round(fy(90 - y * th) * d), b = Math.round(fy(90 - (y + 1) * th) * d);
      c.drawImage(img, l, t, r - l, b - t);
    }
  }

  // Hintergrund: Textur bzw. Fläche plus Länder; nur neu zeichnen, wenn sich etwas ändert
  function drawFlatStatic() {
    flatDirty = false;
    const c = flat.bg.getContext('2d'), sc = flatScale(), d = flat.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.imageSmoothingQuality = 'high';
    c.fillStyle = cssVar('--ink') || '#071224'; c.fillRect(0, 0, flat.bg.width, flat.bg.height);
    const night = settings.globeStyle !== 'plain';
    if (night && !flat.img) { flat.img = new Image(); flat.img.onload = () => { flatDirty = true; }; flat.img.src = CONFIG.textures + 'black-marble.jpg'; }
    // feinste Stufe, die mindestens so scharf ist wie die Anzeige
    let z = 0; while (z < NIGHT.length - 1 && NIGHT[z].ppd < sc * d * 0.9) z++;
    if (lite) z = 0;
    const paths = flatPaths();
    // Einfärbung beim Hineinzoomen etwas zurücknehmen, damit die Lichter durchscheinen
    const fillAlpha = Math.max(0.45, 1 - (flat.zoom - 1) * 0.08);
    for (const k of [-1, 0, 1]) {
      const l = Math.round(fx(-180, k) * d), r = Math.round(fx(180, k) * d), t = Math.round(fy(90) * d), b = Math.round(fy(-90) * d);
      if (l > flat.bg.width || r < 0) continue;
      const v = flatView(k);
      c.setTransform(1, 0, 0, 1, 0, 0);
      if (night && flat.img && flat.img.complete && flat.img.naturalWidth) {
        c.drawImage(flat.img, l, t, r - l, b - t);
        // gröbere Stufen nur aus dem Speicher als Unterlage, die benötigte Stufe wird geladen
        for (let lz = 1; lz <= z; lz++) drawTiles(c, lz, k, v, lz === z);
      } else { c.fillStyle = cssVar('--globe') || '#0d2242'; c.fillRect(l, t, r - l, b - t); }
      if (!paths) continue;
      c.setTransform(sc * d, 0, 0, -sc * d, fx(0, k) * d, fy(0) * d);
      c.lineWidth = 0.8 / sc; c.lineJoin = 'round';
      for (const { f, path, box } of paths) {
        if (!inView(box, v)) continue;
        c.globalAlpha = fillAlpha; c.fillStyle = polyColor(f); c.fill(path);
        c.globalAlpha = 1; c.strokeStyle = polyStroke(f); c.stroke(path);
      }
    }
  }
  // Hotspot-Größe in Pixeln: nach Anzahl, wächst beim Zoomen nur leicht mit
  const flatPointR = p => (2 + Math.min(4.5, Math.log10(p.count + 1) * 2.2)) * flat.zoom ** 0.25;

  // Quadratische Kurve, nach oben gewölbt; Höhe wie „Bogenhöhe“
  function arcGeom(a) {
    const k = nearK(a.sLng);
    const eLng = a.sLng + wrapLng(a.eLng - a.sLng);   // kürzerer Weg, auch über die Datumsgrenze
    const x0 = fx(a.sLng, k), y0 = fy(a.sLat), x2 = fx(eLng, k), y2 = fy(a.eLat);
    const dx = x2 - x0, dy = y2 - y0, len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len, ny = dx / len; if (ny > 0) { nx = -nx; ny = -ny; }
    const lift = len * settings.arcHeight * 0.9;
    return { x0, y0, x1: (x0 + x2) / 2 + nx * lift, y1: (y0 + y2) / 2 + ny * lift, x2, y2 };
  }
  const bez = (g, t) => { const u = 1 - t; return [u * u * g.x0 + 2 * u * t * g.x1 + t * t * g.x2, u * u * g.y0 + 2 * u * t * g.y1 + t * t * g.y2]; };

  function flatFrame() {
    flat.raf = requestAnimationFrame(flatFrame);
    if (document.hidden || !flat.w) return;
    const now = Date.now();
    if (flat.anim) {
      const A = flat.anim, t = Math.min(1, (now - A.t0) / A.ms), e = t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      flat.lng = A.from.lng + (A.to.lng - A.from.lng) * e; flat.lat = A.from.lat + (A.to.lat - A.from.lat) * e;
      flat.zoom = A.from.zoom + (A.to.zoom - A.from.zoom) * e;
      flatClamp(); flatDirty = true;
      if (t >= 1) flat.anim = null;
    }
    if (flatDirty) drawFlatStatic();
    const c = flat.ctx, sc = flatScale();
    c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(flat.bg, 0, 0);
    c.setTransform(flat.dpr, 0, 0, flat.dpr, 0, 0);
    // Hotspots
    for (const p of pointList) {
      const r = flatPointR(p);
      c.fillStyle = rgba(COLORS[p.dir], 0.85);
      c.beginPath(); c.arc(fx(p.lng, nearK(p.lng)), fy(p.lat), r, 0, 7); c.fill();
    }
    // Bögen: Leuchtstrich wandert in flightMs von Start zu Ziel
    c.lineCap = 'round';
    for (const a of arcs) {
      const f = (now - a.t0) / CONFIG.flightMs, t1 = Math.min(1, f), t0 = Math.max(0, f - a.dash);
      if (t1 <= t0) continue;
      const g = arcGeom(a), steps = 24, tail = bez(g, t0), head = bez(g, t1);
      const grad = c.createLinearGradient(tail[0], tail[1], head[0], head[1]);
      grad.addColorStop(0, a.color[0]); grad.addColorStop(1, a.color[1]);
      c.strokeStyle = grad; c.lineWidth = Math.max(1, a.stroke * 1.8 * flat.zoom ** 0.15);
      c.beginPath(); c.moveTo(tail[0], tail[1]);
      for (let i = 1; i <= steps; i++) { const q = bez(g, t0 + (t1 - t0) * i / steps); c.lineTo(q[0], q[1]); }
      c.stroke();
    }
    // Ringe am Ziel (einmalig) und um Zuhause (wiederkehrend)
    c.lineWidth = 1.5;
    for (const r of rings) {
      const age = r.period < 99999 ? now % r.period : now - (r.t0 || now);
      const deg = age / 1000 * r.speed;
      if (deg <= 0 || deg > r.max) continue;
      c.strokeStyle = rgba(r.color, Math.max(0, 1 - deg / r.max));
      c.beginPath(); c.arc(fx(r.lng, nearK(r.lng)), fy(r.lat), 2 + deg * Math.min(sc, 10) * 1.5, 0, 7); c.stroke();
    }
    if (settings.homeLabel) {
      const H = CONFIG.home, x = fx(H.lng, nearK(H.lng)), y = fy(H.lat);
      c.fillStyle = cssVar('--text') || '#dbe6f3';
      c.beginPath(); c.arc(x, y, 2.5, 0, 7); c.fill();
      c.font = '500 12px ' + (cssVar('--sans') || 'sans-serif'); c.textBaseline = 'middle';
      c.fillText(H.label, x + 6, y);
    }
  }

  // Was liegt unter dem Mauszeiger? Erst Hotspots, dann Länder
  function flatHit(mx, my) {
    const sc = flatScale();
    for (const p of pointList) {
      if (Math.hypot(fx(p.lng, nearK(p.lng)) - mx, fy(p.lat) - my) <= flatPointR(p) + 3) return { point: p };
    }
    const paths = flatPaths();
    if (!paths) return null;
    const c = flat.bg.getContext('2d'), d = flat.dpr;
    for (const k of [-1, 0, 1]) {
      // nur Länder, deren Rahmen den Mauspunkt enthält
      const lng = flat.lng - k * 360 + (mx - flat.w / 2) / sc, lat = flat.lat - (my - flat.h / 2) / sc;
      if (lng < -180 || lng > 180) continue;
      c.setTransform(sc * d, 0, 0, -sc * d, fx(0, k) * d, fy(0) * d);
      for (const { f, path, box } of paths) {
        if (lng < box[0] || lng > box[2] || lat < box[1] || lat > box[3]) continue;
        if (c.isPointInPath(path, mx * d, my * d)) return { poly: f };
      }
    }
    return null;
  }
  function flatHover(ev) {
    const r = flatEl.getBoundingClientRect(), hit = flatHit(ev.clientX - r.left, ev.clientY - r.top);
    const poly = hit && hit.poly || null;
    if (!sameCountry(poly, polyHover) && poly !== polyHover) { polyHover = poly; flatDirty = true; }
    flatEl.style.cursor = hit ? 'pointer' : '';
    if (!hit) { flatTip.hidden = true; return; }
    flatTip.innerHTML = hit.point ? pointLabel(hit.point) : polyLabel(hit.poly);   // Inhalt ist escaped
    flatTip.hidden = false;
    flatTip.style.left = Math.min(ev.clientX + 14, innerWidth - flatTip.offsetWidth - 8) + 'px';
    flatTip.style.top = (ev.clientY + 14) + 'px';
  }

  flatEl.addEventListener('pointerdown', ev => {
    flatEl.setPointerCapture(ev.pointerId);
    flat.drag = { x: ev.clientX, y: ev.clientY, lng: flat.lng, lat: flat.lat, moved: false };
    flat.anim = null;
  });
  flatEl.addEventListener('pointermove', ev => {
    const D = flat.drag;
    if (D) {
      const dx = ev.clientX - D.x, dy = ev.clientY - D.y;
      if (Math.hypot(dx, dy) > 4) D.moved = true;
      if (!D.moved) return;
      const sc = flatScale();
      flat.lng = D.lng - dx / sc; flat.lat = D.lat + dy / sc; flatClamp(); flatDirty = true;
      flatEl.style.cursor = 'grabbing'; flatTip.hidden = true;
      return;
    }
    if (flat.hoverQueued) return;
    flat.hoverQueued = true;
    requestAnimationFrame(() => { flat.hoverQueued = false; flatHover(ev); });
  });
  flatEl.addEventListener('pointerup', ev => {
    const D = flat.drag; flat.drag = null; flatEl.style.cursor = '';
    if (!D || D.moved) return;
    const r = flatEl.getBoundingClientRect(), hit = flatHit(ev.clientX - r.left, ev.clientY - r.top);
    if (hit && hit.point && hit.point.cc) openDossier('country', hit.point.cc);
    else if (hit && hit.poly && hit.poly.properties.iso) openDossier('country', hit.poly.properties.iso);
  });
  flatEl.addEventListener('pointerleave', () => { flatTip.hidden = true; if (polyHover) { polyHover = null; flatDirty = true; } });
  flatEl.addEventListener('wheel', ev => {
    ev.preventDefault();
    const r = flatEl.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const sc0 = flatScale(), lng = flat.lng + (mx - flat.w / 2) / sc0, lat = flat.lat - (my - flat.h / 2) / sc0;
    flat.zoom = Math.max(1, Math.min(FLAT_MAX_ZOOM, flat.zoom * Math.exp(-ev.deltaY * 0.0015)));
    const sc = flatScale();   // Punkt unter dem Mauszeiger bleibt stehen
    flat.lng = lng - (mx - flat.w / 2) / sc; flat.lat = lat + (my - flat.h / 2) / sc;
    flat.anim = null; flatClamp(); flatDirty = true; flatTip.hidden = true;
  }, { passive: false });

  function flatFocus(lat, lng, zoom = Math.max(flat.zoom, 3), ms = 1000) {
    const to = { lng: flat.lng + wrapLng(lng - flat.lng), lat, zoom: Math.min(FLAT_MAX_ZOOM, zoom) };
    flat.anim = { t0: Date.now(), ms: reduceMotion ? 1 : ms, from: { lng: flat.lng, lat: flat.lat, zoom: flat.zoom }, to };
    flatTip.hidden = true; if (polyHover) { polyHover = null; flatDirty = true; }
  }

  // ---------- Globus: Nahansicht ----------
  // Nah am Globus wären Punkte, Bögen und Beschriftung (in Grad bemessen) riesig und die Textur
  // unscharf. Daher: Größen mit der Kamerahöhe skalieren, Grenzen auf 1:50m wechseln und über den
  // sichtbaren Ausschnitt die Kacheln der flachen Karte (vendor/night/) legen.
  const globeNear = { scale: 1, alt: -1, lat: 0, lng: 0, fine: false, region: null, tileKey: '', mats: new Map() };

  function updateGlobeNear(force) {
    if (!world || globeEl.hidden || document.hidden) return;
    const pov = world.pointOfView(), N = globeNear;
    const moved = force || Math.abs(pov.altitude - N.alt) > 0.01 || Math.abs(pov.lat - N.lat) > 0.5 || Math.abs(wrapLng(pov.lng - N.lng)) > 0.5;
    if (moved) {
      N.alt = pov.altitude; N.lat = pov.lat; N.lng = pov.lng;
      // bei der Starthöhe 2,3 wie bisher, nah heran bis auf ein Achtel
      const scale = Math.max(0.12, Math.min(1, pov.altitude / 1.8));
      if (force || Math.abs(scale - N.scale) / N.scale > 0.1) {
        N.scale = scale;
        world.labelSize(0.55 * scale ** 0.75).labelDotRadius(0.28 * scale);
        refreshPoints();
      }
      // Grenzen: unterhalb Höhe 0,9 fein, zurück erst über 1,1 (sonst Flackern an der Schwelle).
      // Fein nur die Länder im großzügigen Blickfeld – jede Teilfläche kostet einen Draw-Call,
      // alle 1:50m-Länder zusammen drücken die Bildrate auf wenige fps.
      if (!lite && countryFeatures.length) {
        const fine = pov.altitude < (N.fine ? 1.1 : 0.9), r = N.region;
        if (fine && (!N.fine || !r || pov.altitude > r.alt * 1.3 || pov.altitude < r.alt / 1.3 ||
            Math.abs(pov.lat - r.lat) > r.lat0 / 3 || Math.abs(wrapLng(pov.lng - r.lng)) > r.lng0 / 3)) {
          const span = viewSpan(pov, 1.6), reg = N.region = { alt: pov.altitude, lat: pov.lat, lng: pov.lng, lat0: span.lat, lng0: span.lng };
          loadDetailGeo().then(fs => { if (fs && N.region === reg) world.polygonsData(fs.filter(f => inRegion(featureBox(f), reg))); });
        } else if (!fine && N.fine) { N.region = null; world.polygonsData(countryFeatures); }
        N.fine = fine;
      }
    }
    updateGlobeTiles(pov);
  }
  setInterval(() => updateGlobeNear(false), 250);

  // grob sichtbarer Ausschnitt um den Blickpunkt (halbe Breite/Höhe in Grad), geschätzt nach Kamerahöhe
  function viewSpan(pov, f = 1) {
    const lat = Math.min(90, (8 + pov.altitude * 30) * f);
    return { lat, lng: Math.min(180, (8 + pov.altitude * 50) * f / Math.max(0.2, Math.cos(pov.lat * Math.PI / 180))) };
  }
  const boxes = new WeakMap();
  function featureBox(f) {
    let b = boxes.get(f);
    if (b) return b;
    b = [180, 90, -180, -90];
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const [x, y] of poly[0]) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
    boxes.set(f, b);
    return b;
  }
  const inRegion = (b, r) => b[3] >= r.lat - r.lat0 && b[1] <= r.lat + r.lat0 &&
    [-360, 0, 360].some(k => b[2] + k >= r.lng - r.lng0 && b[0] + k <= r.lng + r.lng0);

  // Kacheln rund um den Blickpunkt; der Ausschnitt ist grob nach Kamerahöhe und Breite geschätzt
  function updateGlobeTiles(pov) {
    if (!nightMap) { const m = world.globeMaterial(); if (m.map) nightMap = m.map; }
    const want = new Map();
    if (settings.globeStyle !== 'plain' && !lite && nightMap && pov.altitude < 0.9) {
      const z = pov.altitude < 0.45 ? 2 : 1, L = NIGHT[z], tw = 360 / L.cols, th = 180 / L.rows;
      const { lat: spanLat, lng: spanLng } = viewSpan(pov);
      const y0 = Math.max(0, Math.floor((90 - (pov.lat + spanLat)) / th)), y1 = Math.min(L.rows - 1, Math.floor((90 - (pov.lat - spanLat)) / th));
      const xa = Math.floor((pov.lng - spanLng + 180) / tw), xb = Math.floor((pov.lng + spanLng + 180) / tw);
      for (let y = y0; y <= y1; y++) for (let xi = xa; xi <= xb; xi++) {
        const x = ((xi % L.cols) + L.cols) % L.cols, key = z + '/' + y + '-' + x;
        want.set(key, { key, lat: 90 - (y + 0.5) * th, lng: -180 + (x + 0.5) * tw, w: tw, h: th });
      }
    }
    const key = [...want.keys()].join(',');
    if (key === globeNear.tileKey) return;
    globeNear.tileKey = key;
    world.tilesData([...want.values()]);
  }
  // Material je Kachel: Kopie der Globus-Textur mit eigenem Bild, unsichtbar bis es geladen ist
  function globeTileMat(t) {
    const mats = globeNear.mats;
    let m = mats.get(t.key);
    if (m) { mats.delete(t.key); mats.set(t.key, m); return m; }
    // eigene Textur pro Kachel: clone() würde die Bildquelle mit der Globus-Textur teilen
    m = new (world.globeMaterial().constructor)({ transparent: true, opacity: 0 });
    const img = new Image();
    img.onload = () => {
      const tex = new nightMap.constructor(img);
      tex.colorSpace = nightMap.colorSpace; tex.anisotropy = nightMap.anisotropy; tex.needsUpdate = true;
      m.map = tex; m.transparent = false; m.opacity = 1; m.needsUpdate = true;
    };
    img.src = CONFIG.textures + 'night/' + t.key + '.jpg';
    mats.set(t.key, m);
    if (mats.size > 160) { const [k0, old] = mats.entries().next().value; mats.delete(k0); if (old.map) old.map.dispose(); old.dispose(); }
    return m;
  }

  // ---------- Erstkontakt: Land oder Firma zum ersten Mal seit 30 Tagen ----------
  const known = { countries: new Set(), orgs: new Set(), devices: new Set(), devicesReady: false, ready: false };
  async function loadKnown() {
    if (isDemo) return;
    try {
      const [c, o, d, age] = await Promise.all([
        vl('_time:30d (dir:out or dir:"in") r_country:* | stats by (r_country) count() as n'),
        vl('_time:30d (dir:out or dir:"in") r_org:* | stats by (r_org) count() as n'),
        vl('_time:30d (dir:out or dir:"in") | stats by (local_ip) count() as n'),
        vl('_time:30d kind:flow | stats min(_time) as first')
      ]);
      c.forEach(r => known.countries.add(r.r_country)); o.forEach(r => known.orgs.add(r.r_org)); d.forEach(r => known.devices.add(r.local_ip));
      known.devicesReady = true;
      // Erst melden, wenn es mindestens einen Tag Historie gibt – sonst wäre am Anfang alles „neu“
      const first = age[0] && Date.parse(age[0].first);
      known.ready = !!first && Date.now() - first > 86400000;
    } catch {}
  }
  function checkFirstContact(e) {
    if (e.dir !== 'out' && e.dir !== 'in') return;
    if (known.devicesReady && e.local_ip && !known.devices.has(e.local_ip)) {
      known.devices.add(e.local_ip); e.isNew = true;
    }
    if (!known.ready) return;
    if (e.r_country && !known.countries.has(e.r_country)) {
      known.countries.add(e.r_country); e.isNew = true;
    } else if (e.r_org && !known.orgs.has(e.r_org)) {
      known.orgs.add(e.r_org); e.isNew = true;
    }
  }

  // ---------- Meldungen ----------
  function toast(text, onClick, kind) {
    const box = $('toasts');
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''));
    t.append(el('span', 'kick', kind === 'new' ? 'NEW' : kind === 'limit' ? 'LIMIT' : 'INFO'), el('span', null, text));
    if (onClick) { t.classList.add('click'); t.addEventListener('click', () => { onClick(); t.remove(); }); }
    box.prepend(t);
    while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => t.classList.add('out'), 9000);
    setTimeout(() => t.remove(), 9600);
  }

  const alertDrawer = $('alerts');
  const alertTypeLabel = type => type === 'device' ? 'Device' : type === 'volume' ? 'Volume limit' : type === 'source' ? 'Data source' : 'First contact';
  function updateAlertCount() {
    const unread = alertRecords.filter(a => !a.read).length;
    const badge = $('alertCount');
    badge.hidden = !unread;
    badge.textContent = unread ? String(unread) : '';
  }
  function renderAlerts() {
    const filter = $('alertFilter').value;
    const rows = alertRecords.filter(a => filter === 'all' || (filter === 'unread' ? !a.read : a.type === filter));
    $('alertInfo').textContent = `${alertRecords.length} archived · ${alertRecords.filter(a => !a.read).length} unread · retained for 90 days`;
    const list = $('alertList');
    if (!rows.length) list.replaceChildren(el('li', 'empty', 'No notifications match this filter.'));
    else list.replaceChildren(...rows.map(alert => {
      const item = el('li', alert.read ? '' : 'unread');
      const time = el('time', null, fmtWhen(alert.createdAt));
      const type = el('span', 'alert-type', alertTypeLabel(alert.type));
      const content = el('div');
      content.append(el('div', 'alert-title', alert.title), el('div', 'alert-detail', alert.detail));
      const actions = el('div', 'alert-actions');
      if (alert.targetType && alert.targetValue) {
        const open = el('button', null, 'Open');
        open.addEventListener('click', async () => {
          await markAlertsRead([alert.id]);
          openDossier(alert.targetType, alert.targetValue);
        });
        actions.append(open);
      }
      if (!alert.read) {
        const read = el('button', null, 'Read');
        read.addEventListener('click', () => markAlertsRead([alert.id]));
        actions.append(read);
      }
      item.append(time, type, content, actions);
      return item;
    }));
    updateAlertCount();
  }
  async function refreshAlerts(notifyNew = false) {
    const previous = new Set(alertRecords.map(alert => alert.id));
    alertRecords = await dashboardApi('api/dashboard/alerts');
    renderAlerts();
    if (notifyNew) {
      for (const alert of alertRecords) if (!previous.has(alert.id)) showAlert(alert);
    }
  }
  async function refreshDevicePreferences() {
    const devices = await dashboardApi('api/dashboard/devices');
    devicePrefs.clear();
    Object.entries(devices || {}).forEach(([ip, pref]) => devicePrefs.set(ip, pref));
  }
  async function markAlertsRead(ids, all = false) {
    try {
      await dashboardApi('api/dashboard/alerts', { method: 'PATCH', body: JSON.stringify({ ids, all }) });
      alertRecords.forEach(alert => { if (all || ids.includes(alert.id)) alert.read = true; });
      renderAlerts();
    } catch (err) {
      console.warn('Could not update alert archive:', err);
      toast(`Could not update alert archive: ${err.message || err}`, null, 'info');
    }
  }
  async function showAlert(alert) {
    if (!alertRecords.some(item => item.id === alert.id)) alertRecords.unshift(alert);
    renderAlerts();
    const open = alert.targetType && alert.targetValue
      ? () => { markAlertsRead([alert.id]); openDossier(alert.targetType, alert.targetValue); }
      : null;
    if (settings.alerts) toast(`${alert.title}: ${alert.detail}`, open, alert.type === 'volume' ? 'limit' : 'new');
    if (settings.browserNotifications && 'Notification' in window && Notification.permission === 'granted') {
      const notification = new Notification(alert.title, { body: alert.detail, tag: alert.key });
      notification.onclick = () => {
        window.focus();
        if (open) open();
        notification.close();
      };
    }
  }
  $('openAlerts').addEventListener('click', async () => {
    showOverlay(alertDrawer);
    try { await refreshAlerts(); } catch (err) { $('alertInfo').textContent = `Could not load archive: ${err.message || err}`; }
  });
  $('alertsClose').addEventListener('click', () => hideOverlay(alertDrawer));
  alertDrawer.addEventListener('click', ev => { if (ev.target === alertDrawer) hideOverlay(alertDrawer); });
  $('alertFilter').addEventListener('change', renderAlerts);
  $('alertsRead').addEventListener('click', () => markAlertsRead([], true));
  $('alertsClear').addEventListener('click', async () => {
    if (!confirm('Clear the notification archive for all dashboard browsers?')) return;
    try {
      await dashboardApi('api/dashboard/alerts', { method: 'DELETE' });
      alertRecords = [];
      renderAlerts();
    } catch (err) {
      toast(`Could not clear alert archive: ${err.message || err}`, null, 'info');
    }
  });

  function syncBrowserNotificationSetting() {
    const input = $('optBrowserNotifications');
    const supported = 'Notification' in window && window.isSecureContext;
    input.checked = !!settings.browserNotifications && supported && Notification.permission === 'granted';
    input.disabled = !supported || Notification.permission === 'denied';
    $('browserNotificationState').textContent = !supported
      ? 'Requires a secure HTTPS dashboard and browser notification support.'
      : Notification.permission === 'denied'
        ? 'Notifications are blocked in browser settings.'
        : 'Show alerts while this dashboard is open in another tab.';
  }
  $('optBrowserNotifications').addEventListener('change', async ev => {
    if (!ev.target.checked) {
      settings.browserNotifications = false;
      saveSettings();
      syncBrowserNotificationSetting();
      return;
    }
    if (!('Notification' in window) || !window.isSecureContext) {
      settings.browserNotifications = false;
      toast('Browser notifications require a supported browser and HTTPS.', null, 'info');
    } else {
      try {
        const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        settings.browserNotifications = permission === 'granted';
        if (!settings.browserNotifications) toast('Allow notifications in browser settings to enable them.', null, 'info');
      } catch (err) {
        settings.browserNotifications = false;
        toast(`Could not enable browser notifications: ${err.message || err}`, null, 'info');
      }
    }
    saveSettings();
    syncBrowserNotificationSetting();
  });

  // ---------- Einstellungen ----------
  const setBox = $('settings');
  const fmtDec = (v, d = 1) => (+v).toFixed(d);
  // Bedienelement -> Einstellung; „ui“ = Oberfläche neu anwenden, „globe“ = Globus neu anwenden
  const OPTS = [
    { id: 'optSmooth', key: 'smooth', type: 'check', after: () => { if (!settings.smooth) flushPending(); } },
    { id: 'optAlerts', key: 'alerts', type: 'check' },
    { id: 'optTheme', key: 'theme', type: 'select', ui: true, globe: true },
    { id: 'optPalette', key: 'palette', type: 'select', ui: true, globe: true, after: () => renderSpark() },
    { id: 'optScale', key: 'uiScale', type: 'select', num: true, ui: true },
    { id: 'optPanel', key: 'panelAlpha', type: 'range', scale: 100, ui: true, label: 'optPanelVal', fmt: v => Math.round(v * 100) + ' %' },
    { id: 'optLeft', key: 'showLeft', type: 'check', ui: true },
    { id: 'optRight', key: 'showRight', type: 'check', ui: true },
    { id: 'optView', key: 'view', type: 'select', globe: true },
    { id: 'optRotate', key: 'autoRotate', type: 'check', globe: true, globeOnly: true },
    { id: 'optRotateSpeed', key: 'rotateSpeed', type: 'range', scale: 10, globe: true, globeOnly: true, label: 'optRotateVal', fmt: v => fmtDec(v) + '×' },
    { id: 'optGlobe', key: 'globeStyle', type: 'select', globe: true },
    { id: 'optRelief', key: 'relief', type: 'check', globe: true, liteOff: true, globeOnly: true },
    { id: 'optStars', key: 'stars', type: 'check', globe: true, liteOff: true, globeOnly: true },
    { id: 'optAtmo', key: 'atmosphere', type: 'check', globe: true, globeOnly: true },
    { id: 'optBorders', key: 'borders', type: 'check', globe: true, liteOff: true },
    { id: 'optChoro', key: 'choropleth', type: 'check', globe: true, liteOff: true },
    { id: 'optPoints', key: 'points', type: 'check', globe: true },
    { id: 'optHome', key: 'homeLabel', type: 'check', globe: true },
    { id: 'optStyle', key: 'arcStyle', type: 'select' },
    { id: 'optRate', key: 'arcRate', type: 'range', scale: 1, label: 'optRateVal', fmt: v => String(v) },
    { id: 'optArcH', key: 'arcHeight', type: 'range', scale: 100, globe: true, label: 'optArcHVal', fmt: v => fmtDec(v, 2) }
  ];
  function syncSettingsUi() {
    for (const o of OPTS) {
      const input = $(o.id), v = settings[o.key];
      if (o.type === 'check') input.checked = !!v;
      else if (o.type === 'range') input.value = Math.round(v * o.scale);
      else input.value = String(v);
      if (o.label) $(o.label).textContent = o.fmt(v);
      // im Lite-Modus bzw. auf der flachen Karte ohne Wirkung
      const off = (o.liteOff && lite) || (o.globeOnly && settings.view === 'flat');
      input.disabled = off;
      input.closest('.opt').classList.toggle('disabled', off || (o.key === 'rotateSpeed' && !settings.autoRotate));
    }
    $('liteInfo').hidden = !lite;
  }
  for (const o of OPTS) {
    $(o.id).addEventListener(o.type === 'range' ? 'input' : 'change', ev => {
      const t = ev.target;
      settings[o.key] = o.type === 'check' ? t.checked : o.type === 'range' ? +t.value / o.scale : o.num ? +t.value : t.value;
      if (o.ui) applyUiSettings();
      if (o.globe) applyGlobeSettings();
      if (o.after) o.after();
      syncSettingsUi(); saveSettings();
    });
  }
  $('openSettings').addEventListener('click', ev => { ev.stopPropagation(); setBox.hidden = !setBox.hidden; syncSettingsUi(); });
  document.addEventListener('click', ev => { if (!setBox.hidden && !setBox.contains(ev.target)) setBox.hidden = true; });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') setBox.hidden = true; });
  const saveSettings = () => store.set('settings', settings);
  $('resetView').addEventListener('click', () => {
    if (settings.view === 'flat') flatFocus(20, CONFIG.home.lng, 1);
    else if (world) { pauseRotation(); world.pointOfView(homeView(), 1200); }
  });
  $('resetSettings').addEventListener('click', () => {
    Object.assign(settings, DEFAULT_SETTINGS);
    if (lite) settings.arcRate = Math.min(settings.arcRate, 4);
    delete settings.volumeThresholds;
    delete settings.volumeAlerted;
    applyUiSettings(); applyGlobeSettings(); renderSpark(); syncSettingsUi(); syncBrowserNotificationSetting(); saveSettings();
  });
  $('sparkTitle').addEventListener('click', () => { sparkMode = sparkMode === 'bytes' ? 'hits' : 'bytes'; store.set('sparkMode', sparkMode); renderSpark(); });

  // ---------- Login ----------
  // Fragt die Sitzung ab und verlängert dabei das Cookie (gleitend, 400 Tage).
  // Ein Kiosk, der nie neu lädt, bleibt so dauerhaft angemeldet.
  async function checkSession() {
    if (isDemo) return null;
    try {
      const r = await fetch('auth/session', { cache: 'no-store' });
      if (!r.ok) return null;
      const s = await r.json();
      if (s.enabled && !s.authenticated) toLogin();
      return s;
    } catch { return null; }
  }
  $('logout').addEventListener('click', async () => {
    try { await fetch('auth/logout', { method: 'POST', cache: 'no-store' }); } catch {}
    location.replace('login.html');
  });

  // ---------- Start ----------
  async function loadConfig() {
    if (isDemo) return;
    try {
      const r = await fetch('config.json', { cache: 'no-store' });
      if (r.status === 401) return toLogin();
      if (!r.ok) return;
      const c = await r.json();
      if (c.home && isFinite(+c.home.lat) && isFinite(+c.home.lng)) CONFIG.home = { lat: +c.home.lat, lng: +c.home.lng, label: String(c.home.label || 'Home') };
      if (c.gateway) CONFIG.gateway = String(c.gateway);
    } catch {}
  }

  loadConfig().then(() => {
    if (isDemo) { CONFIG.home = { lat: 50.11, lng: 8.68, label: 'Frankfurt' }; CONFIG.gateway = 'QuantumGateway'; }
    $('gwName').textContent = CONFIG.gateway;
    document.title = 'Lagezentrum' + (CONFIG.gateway ? ' · ' + CONFIG.gateway : '');
    flat.lng = CONFIG.home.lng;
    initGlobe();
    applyView();
    initCountries();
    applyFilters();
    if (isDemo) {
      startDemo();
    } else {
      checkSession().then(s => { $('logoutRow').hidden = !(s && s.enabled); });
      setInterval(checkSession, 6 * 3600 * 1000);
      Promise.all([loadNames(), loadDashboardData().catch(err => {
        console.warn('Dashboard settings not loaded:', err);
        toast(`Shared dashboard settings unavailable: ${err.message || err}`, null, 'info');
      })]).then(() => { connect(); loadStats(); });
      loadKnown();
      setInterval(async () => {
        try {
          await refreshDevicePreferences();
          if (!document.hidden) loadStats();
          await refreshAlerts(true);
        } catch (err) {
          console.warn('Dashboard refresh failed:', err);
        }
      }, CONFIG.statsEveryMs);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStats(); });
      // Filter für Abgewehrt/Intern einschalten lädt deren Statistik sofort nach
      document.querySelectorAll('.chip[data-f="blocked"], .chip[data-f="internal"]').forEach(b => b.addEventListener('click', () => { if (filters[b.dataset.f]) loadStats(); }));
    }
  });
})();
