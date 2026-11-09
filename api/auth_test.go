package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testPW = "korrekt-pferd-batterie"

func testAuth(t *testing.T) (*authCfg, *http.ServeMux, *time.Time) {
	t.Helper()
	h, err := hashPassword(testPW, 10_000)
	if err != nil {
		t.Fatal(err)
	}
	a := newAuth(h, "test-secret-0123456789abcdef", true, false)
	now := time.Unix(1_800_000_000, 0)
	a.now = func() time.Time { return now }
	a.delay = 0
	mux := http.NewServeMux()
	a.routes(mux)
	mux.HandleFunc("GET /api/names", a.require(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	return a, mux, &now
}

func do(mux *http.ServeMux, method, path, body string, hdr map[string]string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = "lz.lan:8080"
	r.Header.Set("X-Forwarded-For", "10.0.0.5")
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func login(mux *http.ServeMux, pw string) *httptest.ResponseRecorder {
	return do(mux, "POST", "/auth/login", `{"password":"`+pw+`"}`,
		map[string]string{"Content-Type": "application/json", "Origin": "http://lz.lan:8080"}, nil)
}

func sessionCookie(t *testing.T, w *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range w.Result().Cookies() {
		if c.Name == cookieName {
			return c
		}
	}
	t.Fatalf("kein Cookie gesetzt (Status %d, %s)", w.Code, w.Body.String())
	return nil
}

func TestHashRoundtrip(t *testing.T) {
	s, err := hashPassword("geheim", 10_000)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, "$") {
		t.Fatalf("Hash enthält $: %s", s)
	}
	h, err := parseHash(s)
	if err != nil {
		t.Fatal(err)
	}
	if !h.verify("geheim") || h.verify("Geheim") || h.verify("") {
		t.Fatal("verify falsch")
	}
	for _, bad := range []string{"", "bcrypt:1:a:b", "pbkdf2-sha256:5:AAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA", "pbkdf2-sha256:x:y:z"} {
		if _, err := parseHash(bad); err == nil {
			t.Errorf("parseHash(%q) sollte scheitern", bad)
		}
	}
}

func TestLoginFlow(t *testing.T) {
	_, mux, now := testAuth(t)

	// ohne Cookie: Seitenaufruf -> Login-Seite, fetch/WebSocket -> 401
	w := do(mux, "GET", "/auth/check", "", map[string]string{"Sec-Fetch-Mode": "navigate", "X-Forwarded-Method": "GET", "X-Forwarded-Uri": "/select/vmui/?x=1"}, nil)
	if w.Code != 302 || w.Header().Get("Location") != "/login.html?next=%2Fselect%2Fvmui%2F%3Fx%3D1" {
		t.Fatalf("navigate: %d %q", w.Code, w.Header().Get("Location"))
	}
	w = do(mux, "GET", "/auth/check", "", map[string]string{"Sec-Fetch-Mode": "websocket", "Upgrade": "websocket", "X-Forwarded-Uri": "/ws"}, nil)
	if w.Code != 401 {
		t.Fatalf("websocket: %d", w.Code)
	}
	w = do(mux, "GET", "/auth/check", "", map[string]string{"Accept": "*/*", "X-Forwarded-Method": "POST", "X-Forwarded-Uri": "/select/logsql/query"}, nil)
	if w.Code != 401 {
		t.Fatalf("fetch: %d", w.Code)
	}
	if w := do(mux, "GET", "/api/names", "", nil, nil); w.Code != 401 {
		t.Fatalf("API ohne Sitzung: %d", w.Code)
	}

	// falsches Passwort
	if w := login(mux, "falsch"); w.Code != 401 || len(w.Result().Cookies()) != 0 {
		t.Fatalf("falsches Passwort: %d", w.Code)
	}
	// fremde Herkunft
	w = do(mux, "POST", "/auth/login", `{"password":"`+testPW+`"}`, map[string]string{"Content-Type": "application/json", "Origin": "http://evil.example"}, nil)
	if w.Code != 403 {
		t.Fatalf("fremde Herkunft: %d", w.Code)
	}

	// richtiges Passwort
	w = login(mux, testPW)
	c := sessionCookie(t, w)
	if !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.Secure || c.MaxAge != int(sessionTTL/time.Second) || c.Path != "/" {
		t.Fatalf("Cookie-Attribute: %+v", c)
	}
	w = do(mux, "POST", "/auth/login", `{"password":"`+testPW+`"}`,
		map[string]string{"Content-Type": "application/json", "Origin": "https://lz.lan:8080", "X-Forwarded-Proto": "https"}, nil)
	if !sessionCookie(t, w).Secure {
		t.Fatal("HTTPS-Sitzungscookie muss Secure setzen")
	}
	secureProxyHash, err := hashPassword(testPW, 10_000)
	if err != nil {
		t.Fatal(err)
	}
	secureProxy := newAuth(secureProxyHash, "test-secret-0123456789abcdef", true, true)
	secureMux := http.NewServeMux()
	secureProxy.routes(secureMux)
	w = login(secureMux, testPW)
	if !sessionCookie(t, w).Secure {
		t.Fatal("Sitzungscookie hinter HTTP-TLS-Proxy muss Secure setzen")
	}
	if w := do(mux, "GET", "/auth/check", "", nil, c); w.Code != 204 {
		t.Fatalf("check mit Cookie: %d", w.Code)
	}
	if w := do(mux, "GET", "/api/names", "", nil, c); w.Code != 200 {
		t.Fatalf("API mit Sitzung: %d", w.Code)
	}

	// manipuliertes Cookie
	bad := *c
	bad.Value = strings.Replace(c.Value, ".", ".9", 1)
	if w := do(mux, "GET", "/auth/check", "", nil, &bad); w.Code != 401 {
		t.Fatalf("manipuliert: %d", w.Code)
	}

	// gleitende Erneuerung: frisch nichts, nach > renewAfter neues Cookie
	if w := do(mux, "GET", "/auth/session", "", nil, c); len(w.Result().Cookies()) != 0 || !strings.Contains(w.Body.String(), `"authenticated":true`) {
		t.Fatalf("session frisch: %v %s", w.Result().Cookies(), w.Body.String())
	}
	*now = now.Add(399 * 24 * time.Hour)
	w = do(mux, "GET", "/auth/session", "", nil, c)
	c2 := sessionCookie(t, w)
	*now = now.Add(2 * 24 * time.Hour) // altes Cookie wäre jetzt abgelaufen
	if w := do(mux, "GET", "/auth/check", "", nil, c); w.Code != 401 {
		t.Fatalf("abgelaufen: %d", w.Code)
	}
	if w := do(mux, "GET", "/auth/check", "", nil, c2); w.Code != 204 {
		t.Fatalf("erneuert: %d", w.Code)
	}

	// Logout löscht das Cookie
	w = do(mux, "POST", "/auth/logout", "", map[string]string{"Origin": "http://lz.lan:8080"}, c2)
	if lc := sessionCookie(t, w); lc.MaxAge >= 0 || lc.Value != "" {
		t.Fatalf("logout: %+v", lc)
	}
}

func TestNewPasswordInvalidatesSessions(t *testing.T) {
	a, mux, _ := testAuth(t)
	c := sessionCookie(t, login(mux, testPW))
	h2, _ := hashPassword("neues-passwort-123", 10_000)
	b := newAuth(h2, "test-secret-0123456789abcdef", true, false)
	b.now = a.now
	mux2 := http.NewServeMux()
	b.routes(mux2)
	if w := do(mux2, "GET", "/auth/check", "", nil, c); w.Code != 401 {
		t.Fatalf("altes Cookie nach Passwortwechsel: %d", w.Code)
	}
}

func TestBruteForceLock(t *testing.T) {
	_, mux, now := testAuth(t)
	for i := 0; i < freeFails; i++ {
		if w := login(mux, "falsch"); w.Code != 401 {
			t.Fatalf("Versuch %d: %d", i, w.Code)
		}
	}
	w := login(mux, testPW) // auch das richtige Passwort wird während der Sperre abgewiesen
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatalf("Sperre: %d", w.Code)
	}
	*now = now.Add(61 * time.Second)
	if w := login(mux, testPW); w.Code != 200 {
		t.Fatalf("nach Sperre: %d %s", w.Code, w.Body.String())
	}
	// nach Erfolg zurückgesetzt
	if w := login(mux, "falsch"); w.Code != 401 {
		t.Fatalf("nach Reset: %d", w.Code)
	}
}

func TestDisabledAndBroken(t *testing.T) {
	open := newAuth("", "", false, false)
	mux := http.NewServeMux()
	open.routes(mux)
	if w := do(mux, "GET", "/auth/check", "", nil, nil); w.Code != 204 {
		t.Fatalf("ohne Passwort: %d", w.Code)
	}
	if w := do(mux, "GET", "/auth/session", "", nil, nil); !strings.Contains(w.Body.String(), `"enabled":false`) {
		t.Fatalf("session ohne Passwort: %s", w.Body.String())
	}

	broken := newAuth("pbkdf2-sha256:kaputt", "x", true, false)
	mux = http.NewServeMux()
	broken.routes(mux)
	if w := do(mux, "GET", "/auth/check", "", nil, nil); w.Code != 401 {
		t.Fatalf("kaputter Hash muss sperren: %d", w.Code)
	}

	unconfigured := newAuth("", "", true, false)
	mux = http.NewServeMux()
	unconfigured.routes(mux)
	if w := do(mux, "GET", "/auth/check", "", nil, nil); w.Code != 401 {
		t.Fatalf("nicht konfiguriertes Passwort muss sperren: %d", w.Code)
	}
	if w := login(mux, testPW); w.Code != 503 {
		t.Fatalf("Login ohne konfiguriertes Passwort: %d", w.Code)
	}
}

func TestSafeNext(t *testing.T) {
	for in, want := range map[string]string{
		"/":                 "/",
		"/select/vmui/":     "/select/vmui/",
		"/?lite":            "/?lite",
		"//evil.example":    "/",
		"/\\evil.example":   "/",
		"/\t/evil.example":  "/",
		"https://evil":      "/",
		"/login.html?next=": "/",
		"":                  "/",
	} {
		if got := safeNext(in); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClientKey(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Forwarded-For", "2003:ab:cd00:1:aaaa::1")
	if k := clientKey(r); k != "2003:ab:cd00:1::/64" {
		t.Fatalf("IPv6: %s", k)
	}
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 10.0.0.7")
	if k := clientKey(r); k != "10.0.0.7" {
		t.Fatalf("IPv4: %s", k)
	}
}
