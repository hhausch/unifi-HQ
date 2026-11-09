// Lagezentrum-API – speichert Namen für IP-Adressen in config/hosts.csv und lässt
// Vector die Datei neu laden (SIGHUP; der Container teilt sich den PID-Namespace
// mit dem Collector). Lauscht nur auf 127.0.0.1; erreichbar über Caddy unter /api/.
//
//	GET    /api/names              -> [{"ip":"10.37.10.3","name":"homelable"}, …]
//	PUT    /api/names              <- {"ip":"10.37.10.3","name":"homelable"}  (leerer Name = löschen)
//	DELETE /api/names?ip=10.37.10.3
//	GET    /api/health
//	GET    /api/status            -> service and data-source status (requires login)
//
// Dazu der Login (auth.go): /auth/login, /auth/logout, /auth/session, /auth/check.
// "lz-api hash-password" liest ein Passwort von stdin und gibt den Hash für die .env aus.
package main

import (
	"context"
	"encoding/csv"
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
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

const maxEntries = 5000

type entry struct {
	IP   string `json:"ip"`
	Name string `json:"name"`
}

type store struct {
	mu   sync.Mutex
	path string
}

type serviceStatus struct {
	State    string     `json:"state"`
	Detail   string     `json:"detail"`
	LastSeen *time.Time `json:"lastSeen,omitempty"`
}

type dashboardStatus struct {
	CheckedAt time.Time      `json:"checkedAt"`
	API       serviceStatus  `json:"api"`
	Live      serviceStatus  `json:"live"`
	History   serviceStatus  `json:"history"`
	NetFlow   serviceStatus  `json:"netflow"`
	Firewall  serviceStatus  `json:"firewall"`
	GeoIPCity serviceStatus  `json:"geoipCity"`
	GeoIPASN  serviceStatus  `json:"geoipAsn"`
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func latestEvent(ctx context.Context, query string) (*time.Time, error) {
	form := url.Values{"query": {query}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:9428/select/logsql/query", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("VictoriaLogs returned HTTP %d", resp.StatusCode)
	}
	dec := json.NewDecoder(io.LimitReader(resp.Body, 64<<10))
	for {
		var row struct {
			Time string `json:"_time"`
		}
		if err := dec.Decode(&row); err != nil {
			if errors.Is(err, io.EOF) {
				return nil, nil
			}
			return nil, err
		}
		if row.Time == "" {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, row.Time)
		if err != nil {
			return nil, err
		}
		return &t, nil
	}
}

func recordedSource(last *time.Time, err error, label string, now time.Time) serviceStatus {
	if err != nil {
		return serviceStatus{State: "down", Detail: "History unavailable"}
	}
	if last == nil {
		return serviceStatus{State: "waiting", Detail: "No recorded events"}
	}
	state := "idle"
	if now.Sub(*last) <= 5*time.Minute {
		state = "healthy"
	}
	return serviceStatus{State: state, Detail: label, LastSeen: last}
}

func geoIPStatus(path string, now time.Time) serviceStatus {
	info, err := os.Stat(path)
	if err != nil || info.Size() == 0 {
		return serviceStatus{State: "down", Detail: "Database missing"}
	}
	age := now.Sub(info.ModTime())
	state := "healthy"
	if age > 45*24*time.Hour {
		state = "warning"
	}
	t := info.ModTime().UTC()
	return serviceStatus{State: state, Detail: "Database available", LastSeen: &t}
}

func collectStatus() dashboardStatus {
	now := time.Now().UTC()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	var flowTime, firewallTime *time.Time
	var flowErr, firewallErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		flowTime, flowErr = latestEvent(ctx, "kind:flow | sort by (_time desc) | limit 1")
	}()
	go func() {
		defer wg.Done()
		firewallTime, firewallErr = latestEvent(ctx, "kind:blocked | sort by (_time desc) | limit 1")
	}()
	wg.Wait()

	live := serviceStatus{State: "healthy", Detail: "Listener reachable"}
	conn, err := net.DialTimeout("tcp", "127.0.0.1:8090", time.Second)
	if err != nil {
		live = serviceStatus{State: "down", Detail: "Listener unavailable"}
	} else {
		_ = conn.Close()
	}

	history := serviceStatus{State: "healthy", Detail: "Queries successful"}
	if flowErr != nil || firewallErr != nil {
		history = serviceStatus{State: "down", Detail: "Query failed"}
	}

	return dashboardStatus{
		CheckedAt: now,
		API:       serviceStatus{State: "healthy", Detail: "Responding"},
		Live:      live,
		History:   history,
		NetFlow:   recordedSource(flowTime, flowErr, "Last event", now),
		Firewall:  recordedSource(firewallTime, firewallErr, "Last blocked event", now),
		GeoIPCity: geoIPStatus("/geoip/dbip-city-lite.mmdb", now),
		GeoIPASN:  geoIPStatus("/geoip/dbip-asn-lite.mmdb", now),
	}
}

func (s *store) load() (map[string]string, error) {
	m := map[string]string{}
	f, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r := csv.NewReader(f)
	r.Comment = '#'
	r.FieldsPerRecord = -1
	r.TrimLeadingSpace = true
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(rec) < 2 || strings.EqualFold(rec[0], "ip") {
			continue
		}
		if a, err := netip.ParseAddr(strings.TrimSpace(rec[0])); err == nil {
			m[a.String()] = strings.TrimSpace(rec[1])
		}
	}
	return m, nil
}

func (s *store) save(m map[string]string) error {
	ips := make([]netip.Addr, 0, len(m))
	for k := range m {
		a, _ := netip.ParseAddr(k)
		ips = append(ips, a)
	}
	sort.Slice(ips, func(i, j int) bool { return ips[i].Less(ips[j]) })

	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".hosts-*.csv")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	w := csv.NewWriter(tmp)
	_ = w.Write([]string{"ip", "name"})
	for _, a := range ips {
		_ = w.Write([]string{a.String(), m[a.String()]})
	}
	w.Flush()
	if err := w.Error(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

// Vector-Prozess im geteilten PID-Namespace finden und neu laden lassen
func reloadVector() {
	dirs, _ := os.ReadDir("/proc")
	for _, d := range dirs {
		pid, err := strconv.Atoi(d.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		cmd, err := os.ReadFile("/proc/" + d.Name() + "/cmdline")
		if err != nil {
			continue
		}
		args := strings.Split(string(cmd), "\x00")
		if len(args) > 0 && filepath.Base(args[0]) == "vector" {
			if err := syscall.Kill(pid, syscall.SIGHUP); err != nil {
				log.Printf("SIGHUP an Vector (%d) fehlgeschlagen: %v", pid, err)
			}
			return
		}
	}
	log.Print("Vector-Prozess nicht gefunden – Namen gelten erst nach Neustart des Collectors")
}

func cleanName(n string) (string, error) {
	n = strings.TrimSpace(n)
	if !utf8.ValidString(n) {
		return "", errors.New("invalid characters")
	}
	if utf8.RuneCountInString(n) > 64 {
		return "", errors.New("name too long (max. 64 characters)")
	}
	for _, r := range n {
		if unicode.IsControl(r) {
			return "", errors.New("control characters not allowed")
		}
	}
	return n, nil
}

func jsonOut(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	jsonOut(w, code, map[string]string{"error": msg})
}

// Schreibende Anfragen nur von derselben Seite (Schutz gegen CSRF aus anderen Tabs)
func sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return r.Header.Get("Sec-Fetch-Site") == "" || r.Header.Get("Sec-Fetch-Site") == "same-origin"
	}
	u, err := url.Parse(o)
	return err == nil && u.Host == r.Host
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		cmdHashPassword()
		return
	}
	s := &store{path: env("HOSTS_FILE", "/config/hosts.csv")}
	addr := env("LISTEN", "127.0.0.1:8092")
	auth := newAuth(os.Getenv("AUTH_PASSWORD_HASH"), os.Getenv("AUTH_SECRET"))
	switch {
	case auth.bad != nil:
		log.Printf("FEHLER: AUTH_PASSWORD_HASH ungültig (%v) – Dashboard gesperrt, bis ./lagezentrum.sh password ein neues Passwort setzt", auth.bad)
	case auth.enabled:
		log.Print("Login aktiv")
	default:
		log.Print("Kein Login-Passwort gesetzt – das Dashboard ist für das ganze LAN offen (./lagezentrum.sh password)")
	}

	mux := http.NewServeMux()
	auth.routes(mux)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/status", auth.require(func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, 200, collectStatus())
	}))
	mux.HandleFunc("GET /api/names", auth.require(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		m, err := s.load()
		s.mu.Unlock()
		if err != nil {
			fail(w, 500, "cannot read hosts.csv: "+err.Error())
			return
		}
		out := make([]entry, 0, len(m))
		for ip, n := range m {
			out = append(out, entry{ip, n})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].IP < out[j].IP })
		jsonOut(w, 200, out)
	}))
	write := func(w http.ResponseWriter, r *http.Request, ipRaw, nameRaw string) {
		if !sameOrigin(r) {
			fail(w, 403, "cross-origin request rejected")
			return
		}
		a, err := netip.ParseAddr(strings.TrimSpace(ipRaw))
		if err != nil {
			fail(w, 400, "not a valid IP address")
			return
		}
		name, err := cleanName(nameRaw)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		m, err := s.load()
		if err != nil {
			fail(w, 500, err.Error())
			return
		}
		if name == "" {
			delete(m, a.String())
		} else {
			if _, ok := m[a.String()]; !ok && len(m) >= maxEntries {
				fail(w, 400, "too many entries")
				return
			}
			m[a.String()] = name
		}
		if err := s.save(m); err != nil {
			fail(w, 500, "saving failed: "+err.Error())
			return
		}
		reloadVector()
		log.Printf("Name gesetzt: %s = %q", a, name)
		jsonOut(w, 200, entry{a.String(), name})
	}
	mux.HandleFunc("PUT /api/names", auth.require(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			fail(w, 415, "JSON expected")
			return
		}
		var e entry
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&e); err != nil {
			fail(w, 400, "invalid JSON")
			return
		}
		write(w, r, e.IP, e.Name)
	}))
	mux.HandleFunc("DELETE /api/names", auth.require(func(w http.ResponseWriter, r *http.Request) {
		write(w, r, r.URL.Query().Get("ip"), "")
	}))

	srv := &http.Server{Addr: addr, Handler: mux, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, MaxHeaderBytes: 16 << 10}
	log.Printf("Lagezentrum-API auf %s, Datei %s", addr, s.path)
	log.Fatal(srv.ListenAndServe())
}
