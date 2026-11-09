// Login fürs Dashboard: ein Passwort, Sitzung als signiertes Cookie (400 Tage, gleitend).
// Caddy fragt vor jeder Anfrage (außer Login-Seite, /vendor/ und /auth/*) per forward_auth
// bei /auth/check nach. Ohne gesetztes Passwort bleibt der Zugriff gesperrt, außer
// AUTH_REQUIRED=false wurde ausdrücklich gesetzt (./lagezentrum.sh password off).
//
//	POST /auth/login    <- {"password":"…"}   setzt das Cookie
//	POST /auth/logout                        löscht das Cookie in diesem Browser
//	GET  /auth/session  -> {"enabled":true,"authenticated":true}; erneuert das Cookie
//	GET  /auth/check    -> 204 mit gültiger Sitzung, sonst 302 auf /login.html (Seitenaufrufe)
//	                       bzw. 401 (fetch, WebSocket, Abfragen)
//
// Passwort: PBKDF2-HMAC-SHA256 (Standardbibliothek), Format
// pbkdf2-sha256:<Iterationen>:<Salz>:<Schlüssel> (Base64url, ohne "$", damit es in der .env
// nicht von docker compose ersetzt wird). Erzeugt mit "lz-api hash-password" (liest stdin).
//
// Sitzung: "1.<ausgestellt>.<gültig bis>.<HMAC>". Der HMAC-Schlüssel hängt an AUTH_SECRET
// und am Passwort-Hash: Neues Passwort oder neues Secret meldet alle Browser ab.
package main

import (
	"bufio"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	cookieName    = "lz_session"
	sessionTTL    = 400 * 24 * time.Hour // Obergrenze, die Browser für Cookies erlauben
	renewAfter    = 12 * time.Hour       // so alt darf ein Cookie werden, bevor es erneuert wird
	hashScheme    = "pbkdf2-sha256"
	defaultIter   = 600_000 // OWASP-Empfehlung für PBKDF2-HMAC-SHA256
	failDelay     = time.Second
	maxConcurrent = 2 // gleichzeitige Passwortprüfungen (PBKDF2 kostet CPU)
)

var b64 = base64.RawURLEncoding

// --- Passwort-Hash --------------------------------------------------------------

type pwHash struct {
	iter      int
	salt, key []byte
}

func hashPassword(pw string, iter int) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, pw, salt, iter, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s:%d:%s:%s", hashScheme, iter, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

func parseHash(s string) (*pwHash, error) {
	p := strings.Split(strings.TrimSpace(s), ":")
	if len(p) != 4 || p[0] != hashScheme {
		return nil, errors.New("unknown format (expected " + hashScheme + ":…)")
	}
	iter, err := strconv.Atoi(p[1])
	if err != nil || iter < 10_000 || iter > 50_000_000 {
		return nil, errors.New("invalid iteration count")
	}
	salt, err1 := b64.DecodeString(p[2])
	key, err2 := b64.DecodeString(p[3])
	if err1 != nil || err2 != nil || len(salt) < 8 || len(key) < 16 {
		return nil, errors.New("invalid salt or key")
	}
	return &pwHash{iter, salt, key}, nil
}

func (h *pwHash) verify(pw string) bool {
	k, err := pbkdf2.Key(sha256.New, pw, h.salt, h.iter, len(h.key))
	return err == nil && subtle.ConstantTimeCompare(k, h.key) == 1
}

// --- Fehlversuche pro Client ------------------------------------------------------
// Die ersten 5 Fehlversuche kosten nur je 1 s, danach ist der Client gesperrt:
// 1 min, 2 min, 4 min … höchstens 15 min. Nach 1 h ohne Fehlversuch ist alles vergessen.

const (
	freeFails = 5
	maxLock   = 15 * time.Minute
	forgetAge = time.Hour
	maxTrack  = 10_000
)

type failRec struct {
	n     int
	last  time.Time
	until time.Time
}

type limiter struct {
	mu sync.Mutex
	m  map[string]*failRec
}

func newLimiter() *limiter { return &limiter{m: map[string]*failRec{}} }

// wait liefert, wie lange der Client noch gesperrt ist (0 = darf)
func (l *limiter) wait(key string, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	r := l.m[key]
	if r == nil {
		return 0
	}
	if now.Sub(r.last) > forgetAge {
		delete(l.m, key)
		return 0
	}
	if now.Before(r.until) {
		return r.until.Sub(now)
	}
	return 0
}

func (l *limiter) fail(key string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.m) >= maxTrack {
		for k, r := range l.m {
			if now.Sub(r.last) > forgetAge {
				delete(l.m, k)
			}
		}
	}
	r := l.m[key]
	if r == nil || now.Sub(r.last) > forgetAge {
		r = &failRec{}
		l.m[key] = r
	}
	r.n++
	r.last = now
	if r.n >= freeFails {
		lock := time.Minute << min(r.n-freeFails, 4) // 1, 2, 4, 8, 16 min …
		r.until = now.Add(min(lock, maxLock))
	}
}

func (l *limiter) reset(key string) {
	l.mu.Lock()
	delete(l.m, key)
	l.mu.Unlock()
}

// Client-Adresse: Die API lauscht nur auf 127.0.0.1 hinter Caddy, und Caddy setzt
// X-Forwarded-For selbst (Werte des Clients übernimmt es nicht). IPv6 zählt pro /64.
func clientKey(r *http.Request) string {
	raw := r.Header.Get("X-Forwarded-For")
	if i := strings.LastIndexByte(raw, ','); i >= 0 {
		raw = raw[i+1:]
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw, _, _ = net.SplitHostPort(r.RemoteAddr)
	}
	a, err := netip.ParseAddr(raw)
	if err != nil {
		return raw
	}
	a = a.Unmap()
	if a.Is6() {
		p, _ := a.Prefix(64)
		return p.String()
	}
	return a.String()
}

// --- Sitzungen ----------------------------------------------------------------------

type authCfg struct {
	enabled       bool  // Login erforderlich
	bad           error // Passwort fehlt oder Hash ist unlesbar: Zugriff bleibt gesperrt
	hash          *pwHash
	macKey        []byte
	secureCookies bool
	lim           *limiter
	sem           chan struct{}
	now           func() time.Time
	delay         time.Duration
}

func newAuth(hashStr, secret string, requirePassword, secureCookies bool) *authCfg {
	a := &authCfg{lim: newLimiter(), sem: make(chan struct{}, maxConcurrent), now: time.Now, delay: failDelay}
	a.secureCookies = secureCookies
	hashStr = strings.TrimSpace(hashStr)
	if hashStr == "" {
		if requirePassword {
			a.enabled = true
			a.bad = errors.New("password is not configured")
		}
		return a
	}
	a.enabled = true
	h, err := parseHash(hashStr)
	if err != nil {
		a.bad = err
		return a
	}
	a.hash = h
	if secret == "" {
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		secret = string(b)
		log.Print("Warnung: AUTH_SECRET fehlt – Anmeldungen gelten nur bis zum nächsten Neustart der API (./lagezentrum.sh password legt es an)")
	}
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("lagezentrum-session\x00" + hashStr))
	a.macKey = m.Sum(nil)
	return a
}

func (a *authCfg) sign(payload string) string {
	m := hmac.New(sha256.New, a.macKey)
	m.Write([]byte(payload))
	return b64.EncodeToString(m.Sum(nil))
}

func (a *authCfg) newToken() string {
	now := a.now().Unix()
	p := "1." + strconv.FormatInt(now, 10) + "." + strconv.FormatInt(now+int64(sessionTTL/time.Second), 10)
	return p + "." + a.sign(p)
}

// session prüft das Cookie und liefert, wann es ausgestellt wurde
func (a *authCfg) session(r *http.Request) (issued time.Time, ok bool) {
	if a.macKey == nil {
		return time.Time{}, false
	}
	c, err := r.Cookie(cookieName)
	if err != nil {
		return time.Time{}, false
	}
	p := strings.Split(c.Value, ".")
	if len(p) != 4 || p[0] != "1" {
		return time.Time{}, false
	}
	payload := p[0] + "." + p[1] + "." + p[2]
	if !hmac.Equal([]byte(p[3]), []byte(a.sign(payload))) {
		return time.Time{}, false
	}
	iat, err1 := strconv.ParseInt(p[1], 10, 64)
	exp, err2 := strconv.ParseInt(p[2], 10, 64)
	now := a.now()
	if err1 != nil || err2 != nil || now.Unix() >= exp || iat > now.Add(5*time.Minute).Unix() {
		return time.Time{}, false
	}
	return time.Unix(iat, 0), true
}

// allowed: Zugriff ohne weitere Prüfung erlaubt?
func (a *authCfg) allowed(r *http.Request) bool {
	if !a.enabled {
		return true
	}
	_, ok := a.session(r)
	return ok
}

// Secure nur bei HTTPS – im LAN läuft das Dashboard meist über einfaches HTTP
func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func (a *authCfg) setCookie(w http.ResponseWriter, r *http.Request, value string, maxAge time.Duration) {
	c := &http.Cookie{
		Name: cookieName, Value: value, Path: "/",
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: a.secureCookies || isHTTPS(r),
	}
	if maxAge > 0 {
		c.MaxAge = int(maxAge / time.Second)
		c.Expires = a.now().Add(maxAge).UTC()
	} else {
		c.MaxAge = -1
		c.Expires = time.Unix(0, 0)
	}
	http.SetCookie(w, c)
}

// Seitenaufruf im Browser (dann Weiterleitung) oder fetch/WebSocket (dann 401)?
func wantsPage(r *http.Request) bool {
	m := r.Header.Get("X-Forwarded-Method")
	if m == "" {
		m = r.Method
	}
	if m != http.MethodGet && m != http.MethodHead {
		return false
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	if mode := r.Header.Get("Sec-Fetch-Mode"); mode != "" {
		return mode == "navigate"
	}
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

// Nur Pfade auf derselben Seite als Ziel nach dem Login zulassen
func safeNext(u string) string {
	if u == "" || u[0] != '/' || strings.HasPrefix(u, "//") || strings.HasPrefix(u, "/\\") {
		return "/"
	}
	for i := 0; i < len(u); i++ {
		if u[i] <= ' ' || u[i] == 0x7f { // Browser entfernen Tabs/Zeilenumbrüche: "/\t/host" würde zu "//host"
			return "/"
		}
	}
	if strings.HasPrefix(u, "/login.html") || strings.HasPrefix(u, "/auth/") {
		return "/"
	}
	return u
}

func (a *authCfg) deny(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if wantsPage(r) {
		next := r.Header.Get("X-Forwarded-Uri")
		if next == "" {
			next = r.URL.RequestURI()
		}
		loc := "/login.html"
		if n := safeNext(next); n != "/" {
			loc += "?next=" + url.QueryEscape(n)
		}
		http.Redirect(w, r, loc, http.StatusFound)
		return
	}
	fail(w, http.StatusUnauthorized, "Login required")
}

// require schützt einen Handler zusätzlich in der API selbst (falls Caddy falsch konfiguriert ist)
func (a *authCfg) require(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.enabled && a.bad != nil {
			fail(w, http.StatusServiceUnavailable, "Login misconfigured: "+a.bad.Error())
			return
		}
		if !a.allowed(r) {
			fail(w, http.StatusUnauthorized, "Login required")
			return
		}
		h(w, r)
	}
}

func (a *authCfg) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/check", func(w http.ResponseWriter, r *http.Request) {
		if a.allowed(r) && a.bad == nil {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		a.deny(w, r)
	})

	mux.HandleFunc("GET /auth/session", func(w http.ResponseWriter, r *http.Request) {
		issued, ok := a.session(r)
		ok = ok && a.bad == nil
		if ok && a.now().Sub(issued) > renewAfter {
			a.setCookie(w, r, a.newToken(), sessionTTL) // gleitend: wer das Dashboard nutzt, bleibt angemeldet
		}
		jsonOut(w, 200, map[string]bool{"enabled": a.enabled, "authenticated": ok || !a.enabled})
	})

	mux.HandleFunc("POST /auth/login", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			fail(w, 403, "cross-origin request rejected")
			return
		}
		if !a.enabled {
			fail(w, 400, "No password set. On the server run: ./lagezentrum.sh password")
			return
		}
		if a.bad != nil {
			log.Printf("Login nicht verfügbar: %v", a.bad)
			fail(w, 503, "Login is not configured correctly. On the server run: ./lagezentrum.sh password")
			return
		}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			fail(w, 415, "JSON expected")
			return
		}
		var in struct {
			Password string `json:"password"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil || in.Password == "" || len(in.Password) > 1024 {
			fail(w, 400, "Password missing")
			return
		}
		key := clientKey(r)
		if d := a.lim.wait(key, a.now()); d > 0 {
			secs := int(d.Round(time.Second) / time.Second)
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			fail(w, 429, fmt.Sprintf("Too many failed attempts. Try again in %s", humanWait(d)))
			return
		}
		select {
		case a.sem <- struct{}{}:
		case <-time.After(5 * time.Second):
			fail(w, 503, "Server busy, please try again in a moment")
			return
		case <-r.Context().Done():
			return
		}
		good := a.hash.verify(in.Password)
		<-a.sem
		if !good {
			a.lim.fail(key, a.now())
			log.Printf("Fehlgeschlagener Login von %s", key)
			time.Sleep(a.delay)
			fail(w, 401, "Wrong password")
			return
		}
		a.lim.reset(key)
		a.setCookie(w, r, a.newToken(), sessionTTL)
		log.Printf("Login von %s", key)
		jsonOut(w, 200, map[string]bool{"ok": true})
	})

	mux.HandleFunc("POST /auth/logout", func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			fail(w, 403, "cross-origin request rejected")
			return
		}
		a.setCookie(w, r, "", 0)
		jsonOut(w, 200, map[string]bool{"ok": true})
	})
}

func humanWait(d time.Duration) string {
	if d < time.Minute {
		return strconv.Itoa(max(1, int(d.Round(time.Second)/time.Second))) + " s"
	}
	return strconv.Itoa(int((d+time.Minute-1)/time.Minute)) + " min"
}

// "lz-api hash-password": Passwort von stdin lesen, Hash ausgeben
func cmdHashPassword() {
	line, err := bufio.NewReader(io.LimitReader(os.Stdin, 4096)).ReadString('\n')
	if err != nil && err != io.EOF {
		log.Fatal(err)
	}
	pw := strings.TrimRight(line, "\r\n")
	if pw == "" {
		log.Fatal("kein Passwort auf stdin")
	}
	iter := defaultIter
	if v, err := strconv.Atoi(os.Getenv("AUTH_PBKDF2_ITER")); err == nil && v >= 10_000 {
		iter = v
	}
	h, err := hashPassword(pw, iter)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(h)
}
