package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testDashboardMux(t *testing.T, path string, auth *authCfg) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	newDashboardStore(path).routes(mux, auth)
	return mux
}

func dashboardRequest(mux *http.ServeMux, method, path, body string, origin string, cookie *http.Cookie) *httptest.ResponseRecorder {
	headers := map[string]string{"Content-Type": "application/json"}
	if origin != "" {
		headers["Origin"] = origin
	}
	return do(mux, method, path, body, headers, cookie)
}

func TestDashboardDeviceSettingsAndAlertArchive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config", "dashboard.json")
	auth := newAuth("", "", false, false)
	mux := testDashboardMux(t, path, auth)
	origin := "http://lz.lan:8080"

	device := `{"ip":"10.0.0.5","group":"Servers","note":"NAS","volumeThresholdGiB":2.5,"volumePeriod":"7d","volumeDirection":"out"}`
	if w := dashboardRequest(mux, "PUT", "/api/dashboard/device", device, origin, nil); w.Code != http.StatusOK {
		t.Fatalf("save device: %d %s", w.Code, w.Body.String())
	}
	if w := dashboardRequest(mux, "PUT", "/api/dashboard/device", strings.Replace(device, `"7d"`, `"30d"`, 1), origin, nil); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid period: %d %s", w.Code, w.Body.String())
	}

	sample := `{"samples":[{"ip":"10.0.0.5","period":"7d","direction":"out","bytes":3221225472}]}`
	w := dashboardRequest(mux, "POST", "/api/dashboard/volume-check", sample, origin, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("volume check: %d %s", w.Code, w.Body.String())
	}
	var checked struct {
		Alerts []dashboardAlert `json:"alerts"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &checked); err != nil || len(checked.Alerts) != 1 {
		t.Fatalf("expected one volume alert, got %s (%v)", w.Body.String(), err)
	}

	w = dashboardRequest(mux, "POST", "/api/dashboard/volume-check", sample, origin, nil)
	if err := json.Unmarshal(w.Body.Bytes(), &checked); err != nil || len(checked.Alerts) != 0 {
		t.Fatalf("repeated over-limit sample created duplicate: %s (%v)", w.Body.String(), err)
	}
	below := `{"samples":[{"ip":"10.0.0.5","period":"7d","direction":"out","bytes":0}]}`
	if w := dashboardRequest(mux, "POST", "/api/dashboard/volume-check", below, origin, nil); w.Code != http.StatusOK {
		t.Fatalf("rearm threshold: %d %s", w.Code, w.Body.String())
	}
	w = dashboardRequest(mux, "POST", "/api/dashboard/volume-check", sample, origin, nil)
	if err := json.Unmarshal(w.Body.Bytes(), &checked); err != nil || len(checked.Alerts) != 1 {
		t.Fatalf("threshold did not rearm: %s (%v)", w.Body.String(), err)
	}

	newMux := testDashboardMux(t, path, auth)
	w = dashboardRequest(newMux, "GET", "/api/dashboard", "", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("read dashboard state: %d %s", w.Code, w.Body.String())
	}
	var saved dashboardData
	if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if got := saved.Devices["10.0.0.5"]; got.Group != "Servers" || got.Note != "NAS" || got.VolumeThresholdGiB != 2.5 || got.VolumePeriod != "7d" || got.VolumeDirection != "out" {
		t.Fatalf("device settings did not persist: %+v", got)
	}
	if len(saved.Alerts) != 2 {
		t.Fatalf("want two threshold crossings in archive, got %d", len(saved.Alerts))
	}
	w = dashboardRequest(newMux, "PATCH", "/api/dashboard/alerts", `{"all":true}`, origin, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("mark archive read: %d %s", w.Code, w.Body.String())
	}
	w = dashboardRequest(newMux, "GET", "/api/dashboard/alerts", "", "", nil)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), `"read":false`) {
		t.Fatalf("alerts were not marked read: %d %s", w.Code, w.Body.String())
	}
	w = dashboardRequest(newMux, "DELETE", "/api/dashboard/alerts", "", origin, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("clear archive: %d %s", w.Code, w.Body.String())
	}
	w = dashboardRequest(newMux, "GET", "/api/dashboard", "", "", nil)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), `"id"`) || !strings.Contains(w.Body.String(), `"10.0.0.5"`) {
		t.Fatalf("clearing alerts should preserve device settings: %d %s", w.Code, w.Body.String())
	}
}

func TestDashboardWritesRequireSameOriginAndLogin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dashboard.json")
	auth := newAuth("", "", false, false)
	mux := testDashboardMux(t, path, auth)
	payload := `{"ip":"10.0.0.5","group":"Home","note":"","volumeThresholdGiB":0,"volumePeriod":"24h","volumeDirection":"both"}`
	if w := dashboardRequest(mux, "PUT", "/api/dashboard/device", payload, "https://evil.example", nil); w.Code != http.StatusForbidden {
		t.Fatalf("cross-origin write accepted: %d", w.Code)
	}

	protected := testDashboardMux(t, path, newAuth("pbkdf2-sha256:bad", "x", true, false))
	if w := dashboardRequest(protected, "GET", "/api/dashboard", "", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("dashboard data without login: %d", w.Code)
	}
	if w := dashboardRequest(protected, "DELETE", "/api/dashboard/alerts", "", "http://lz.lan:8080", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("alert archive writable without login: %d", w.Code)
	}
}

func TestDashboardAlertRetentionAndDeduplication(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dashboard.json")
	s := newDashboardStore(path)
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	mux := http.NewServeMux()
	s.routes(mux, newAuth("", "", false, false))
	body := `{"key":"device:10.0.0.5:20261109","type":"device","title":"Device seen","detail":"10.0.0.5","ip":"10.0.0.5","targetType":"device","targetValue":"10.0.0.5"}`
	w := dashboardRequest(mux, "POST", "/api/dashboard/alerts", body, "http://lz.lan:8080", nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("create alert: %d %s", w.Code, w.Body.String())
	}
	if w := dashboardRequest(mux, "POST", "/api/dashboard/alerts", body, "http://lz.lan:8080", nil); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"created":false`) {
		t.Fatalf("duplicate alert: %d %s", w.Code, w.Body.String())
	}
	now = now.Add(alertDedupWindow + time.Second)
	if w := dashboardRequest(mux, "POST", "/api/dashboard/alerts", body, "http://lz.lan:8080", nil); w.Code != http.StatusCreated {
		t.Fatalf("new alert after dedup window: %d %s", w.Code, w.Body.String())
	}
	now = now.Add(alertRetention + time.Second)
	w = dashboardRequest(mux, "GET", "/api/dashboard", "", "", nil)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), `"id"`) {
		t.Fatalf("expired alerts should be excluded: %d %s", w.Code, w.Body.String())
	}
}
