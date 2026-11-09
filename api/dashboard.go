package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxDashboardFile = 2 << 20
	maxDashboardBody = 256 << 10
	maxDashboardIPs  = 2000
	maxAlerts        = 1000
	alertRetention   = 90 * 24 * time.Hour
	alertDedupWindow = 30 * 24 * time.Hour
)

type devicePreferences struct {
	Group             string          `json:"group"`
	Note              string          `json:"note"`
	VolumeThresholdGiB float64         `json:"volumeThresholdGiB"`
	VolumePeriod      string          `json:"volumePeriod"`
	VolumeDirection   string          `json:"volumeDirection"`
	VolumeAbove       map[string]bool `json:"volumeAbove,omitempty"`
}

type dashboardAlert struct {
	ID          string    `json:"id"`
	Key         string    `json:"key"`
	Type        string    `json:"type"`
	Title       string    `json:"title"`
	Detail      string    `json:"detail"`
	IP          string    `json:"ip,omitempty"`
	TargetType  string    `json:"targetType,omitempty"`
	TargetValue string    `json:"targetValue,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	Read        bool      `json:"read"`
}

type dashboardData struct {
	Devices     map[string]devicePreferences `json:"devices"`
	Alerts      []dashboardAlert             `json:"alerts"`
	SourceStale map[string]bool              `json:"sourceStale,omitempty"`
}

type dashboardStore struct {
	mu   sync.Mutex
	path string
	now  func() time.Time
}

func newDashboardStore(path string) *dashboardStore {
	return &dashboardStore{path: path, now: time.Now}
}

func (s *dashboardStore) loadLocked() (dashboardData, error) {
	data := dashboardData{
		Devices: map[string]devicePreferences{}, Alerts: []dashboardAlert{},
		SourceStale: map[string]bool{},
	}
	f, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return data, nil
	}
	if err != nil {
		return data, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return dashboardData{}, err
	}
	if info.Size() > maxDashboardFile {
		return dashboardData{}, errors.New("dashboard settings file exceeds storage limit")
	}
	dec := json.NewDecoder(io.LimitReader(f, maxDashboardFile+1))
	if err := dec.Decode(&data); err != nil {
		return dashboardData{}, err
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return dashboardData{}, errors.New("invalid dashboard settings file")
	}
	if data.Devices == nil {
		data.Devices = map[string]devicePreferences{}
	}
	if data.Alerts == nil {
		data.Alerts = []dashboardAlert{}
	}
	if data.SourceStale == nil {
		data.SourceStale = map[string]bool{}
	}
	if len(data.Devices) > maxDashboardIPs {
		return dashboardData{}, errors.New("too many device preferences")
	}
	if len(data.Alerts) > maxAlerts {
		data.Alerts = data.Alerts[:maxAlerts]
	}
	cutoff := s.now().Add(-alertRetention)
	kept := data.Alerts[:0]
	for _, alert := range data.Alerts {
		if alert.CreatedAt.After(cutoff) {
			kept = append(kept, alert)
		}
	}
	data.Alerts = kept
	return data, nil
}

func (s *dashboardStore) saveLocked(data dashboardData) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if len(raw) > maxDashboardFile {
		return errors.New("dashboard settings exceed storage limit")
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".dashboard-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}

func validPeriod(period string) bool {
	return period == "1h" || period == "24h" || period == "7d"
}

func validDirection(direction string) bool {
	return direction == "both" || direction == "out" || direction == "in"
}

func cleanDashboardText(value string, maxRunes int) (string, error) {
	value = strings.TrimSpace(value)
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return "", fmt.Errorf("text must be valid and at most %d characters", maxRunes)
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", errors.New("control characters not allowed")
		}
	}
	return value, nil
}

func decodeDashboardJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		fail(w, http.StatusUnsupportedMediaType, "JSON expected")
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxDashboardBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		fail(w, http.StatusBadRequest, "invalid JSON")
		return false
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		fail(w, http.StatusBadRequest, "invalid JSON")
		return false
	}
	return true
}

func (s *dashboardStore) routes(mux *http.ServeMux, auth *authCfg) {
	mux.HandleFunc("GET /api/dashboard", auth.require(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		data, err := s.loadLocked()
		if err != nil {
			fail(w, http.StatusInternalServerError, "cannot read dashboard settings")
			return
		}
		jsonOut(w, http.StatusOK, data)
	}))
	mux.HandleFunc("GET /api/dashboard/devices", auth.require(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		data, err := s.loadLocked()
		if err != nil {
			fail(w, http.StatusInternalServerError, "cannot read dashboard settings")
			return
		}
		jsonOut(w, http.StatusOK, data.Devices)
	}))
	mux.HandleFunc("GET /api/dashboard/alerts", auth.require(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		data, err := s.loadLocked()
		if err != nil {
			fail(w, http.StatusInternalServerError, "cannot read dashboard settings")
			return
		}
		jsonOut(w, http.StatusOK, data.Alerts)
	}))

	mux.HandleFunc("PUT /api/dashboard/device", auth.require(func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			fail(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}
		var input struct {
			IP                  string  `json:"ip"`
			Group               string  `json:"group"`
			Note                string  `json:"note"`
			VolumeThresholdGiB  float64 `json:"volumeThresholdGiB"`
			VolumePeriod         string  `json:"volumePeriod"`
			VolumeDirection      string  `json:"volumeDirection"`
		}
		if !decodeDashboardJSON(w, r, &input) {
			return
		}
		ip, err := netip.ParseAddr(strings.TrimSpace(input.IP))
		if err != nil {
			fail(w, http.StatusBadRequest, "not a valid IP address")
			return
		}
		group, err := cleanDashboardText(input.Group, 64)
		if err != nil {
			fail(w, http.StatusBadRequest, "invalid device group")
			return
		}
		note, err := cleanDashboardText(input.Note, 240)
		if err != nil {
			fail(w, http.StatusBadRequest, "invalid device note")
			return
		}
		if input.VolumeThresholdGiB < 0 || input.VolumeThresholdGiB > 1_000_000 {
			fail(w, http.StatusBadRequest, "volume threshold must be between 0 and 1000000 GiB")
			return
		}
		if !validPeriod(input.VolumePeriod) || !validDirection(input.VolumeDirection) {
			fail(w, http.StatusBadRequest, "invalid volume threshold period or direction")
			return
		}

		s.mu.Lock()
		defer s.mu.Unlock()
		data, err := s.loadLocked()
		if err != nil {
			fail(w, http.StatusInternalServerError, "cannot read dashboard settings")
			return
		}
		key := ip.String()
		old, exists := data.Devices[key]
		if !exists && len(data.Devices) >= maxDashboardIPs {
			fail(w, http.StatusBadRequest, "too many device preferences")
			return
		}
		above := old.VolumeAbove
		if old.VolumePeriod != input.VolumePeriod || old.VolumeDirection != input.VolumeDirection || old.VolumeThresholdGiB != input.VolumeThresholdGiB {
			above = nil
		}
		if input.VolumeThresholdGiB == 0 {
			above = nil
		}
		data.Devices[key] = devicePreferences{
			Group: group, Note: note, VolumeThresholdGiB: input.VolumeThresholdGiB,
			VolumePeriod: input.VolumePeriod, VolumeDirection: input.VolumeDirection, VolumeAbove: above,
		}
		if err := s.saveLocked(data); err != nil {
			fail(w, http.StatusInternalServerError, "saving dashboard settings failed")
			return
		}
		jsonOut(w, http.StatusOK, map[string]any{"ip": key, "device": data.Devices[key]})
	}))

	mux.HandleFunc("POST /api/dashboard/alerts", auth.require(func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			fail(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}
		var input struct {
			Key         string `json:"key"`
			Type        string `json:"type"`
			Title       string `json:"title"`
			Detail      string `json:"detail"`
			IP          string `json:"ip"`
			TargetType  string `json:"targetType"`
			TargetValue string `json:"targetValue"`
		}
		if !decodeDashboardJSON(w, r, &input) {
			return
		}
		key, err := cleanDashboardText(input.Key, 200)
		if err != nil || key == "" {
			fail(w, http.StatusBadRequest, "invalid alert key")
			return
		}
		if input.Type != "device" && input.Type != "first-contact" && input.Type != "volume" && input.Type != "source" {
			fail(w, http.StatusBadRequest, "invalid alert type")
			return
		}
		title, err := cleanDashboardText(input.Title, 160)
		if err != nil || title == "" {
			fail(w, http.StatusBadRequest, "invalid alert title")
			return
		}
		detail, err := cleanDashboardText(input.Detail, 400)
		if err != nil {
			fail(w, http.StatusBadRequest, "invalid alert detail")
			return
		}
		if input.IP != "" {
			ip, parseErr := netip.ParseAddr(strings.TrimSpace(input.IP))
			if parseErr != nil {
				fail(w, http.StatusBadRequest, "not a valid IP address")
				return
			}
			input.IP = ip.String()
		}
		if input.TargetType != "" && input.TargetType != "device" && input.TargetType != "ip" && input.TargetType != "country" && input.TargetType != "org" {
			fail(w, http.StatusBadRequest, "invalid alert target")
			return
		}
		target, err := cleanDashboardText(input.TargetValue, 200)
		if err != nil {
			fail(w, http.StatusBadRequest, "invalid alert target")
			return
		}

		s.mu.Lock()
		defer s.mu.Unlock()
		data, err := s.loadLocked()
		if err != nil {
			fail(w, http.StatusInternalServerError, "cannot read dashboard settings")
			return
		}
		now := s.now().UTC()
		for i := range data.Alerts {
			age := now.Sub(data.Alerts[i].CreatedAt)
			if data.Alerts[i].Key == key && age >= 0 && age < alertDedupWindow {
				jsonOut(w, http.StatusOK, map[string]any{"alert": data.Alerts[i], "created": false})
				return
			}
		}
		alert, err := makeDashboardAlert(key, input.Type, title, detail, input.IP, input.TargetType, target, now)
		if err != nil {
			fail(w, http.StatusInternalServerError, "cannot create alert")
			return
		}
		data.Alerts = prependAlert(data.Alerts, alert)
		if err := s.saveLocked(data); err != nil {
			fail(w, http.StatusInternalServerError, "saving alert failed")
			return
		}
		jsonOut(w, http.StatusCreated, map[string]any{"alert": alert, "created": true})
	}))

	mux.HandleFunc("POST /api/dashboard/volume-check", auth.require(func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			fail(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}
		var input struct {
			Samples []volumeSample `json:"samples"`
		}
		if !decodeDashboardJSON(w, r, &input) {
			return
		}
		if len(input.Samples) > maxDashboardIPs {
			fail(w, http.StatusBadRequest, "too many volume samples")
			return
		}
		for i, sample := range input.Samples {
			ip, err := netip.ParseAddr(strings.TrimSpace(sample.IP))
			if err != nil ||
				!validPeriod(sample.Period) || !validDirection(sample.Direction) ||
				math.IsNaN(sample.Bytes) || math.IsInf(sample.Bytes, 0) || sample.Bytes < 0 {
				fail(w, http.StatusBadRequest, "invalid volume sample")
				return
			}
			input.Samples[i].IP = ip.String()
		}
		created, err := s.checkVolumeSamples(input.Samples)
		if err != nil {
			fail(w, http.StatusInternalServerError, "saving volume alert state failed")
			return
		}
		jsonOut(w, http.StatusOK, map[string]any{"alerts": created})
	}))

	mux.HandleFunc("PATCH /api/dashboard/alerts", auth.require(func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			fail(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}
		var input struct {
			IDs []string `json:"ids"`
			All bool     `json:"all"`
		}
		if !decodeDashboardJSON(w, r, &input) {
			return
		}
		if !input.All && (len(input.IDs) == 0 || len(input.IDs) > maxAlerts) {
			fail(w, http.StatusBadRequest, "alert IDs required")
			return
		}
		idSet := make(map[string]bool, len(input.IDs))
		for _, id := range input.IDs {
			idSet[id] = true
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		data, err := s.loadLocked()
		if err != nil {
			fail(w, http.StatusInternalServerError, "cannot read dashboard settings")
			return
		}
		updated := 0
		for i := range data.Alerts {
			if input.All || idSet[data.Alerts[i].ID] {
				if !data.Alerts[i].Read {
					data.Alerts[i].Read = true
					updated++
				}
			}
		}
		if err := s.saveLocked(data); err != nil {
			fail(w, http.StatusInternalServerError, "saving alert state failed")
			return
		}
		jsonOut(w, http.StatusOK, map[string]int{"updated": updated})
	}))

	mux.HandleFunc("DELETE /api/dashboard/alerts", auth.require(func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			fail(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		data, err := s.loadLocked()
		if err != nil {
			fail(w, http.StatusInternalServerError, "cannot read dashboard settings")
			return
		}
		data.Alerts = []dashboardAlert{}
		if err := s.saveLocked(data); err != nil {
			fail(w, http.StatusInternalServerError, "clearing alerts failed")
			return
		}
		jsonOut(w, http.StatusOK, data.Alerts)
	}))
}

func makeDashboardAlert(key, kind, title, detail, ip, targetType, targetValue string, now time.Time) (dashboardAlert, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return dashboardAlert{}, err
	}
	return dashboardAlert{
		ID: hex.EncodeToString(id[:]), Key: key, Type: kind, Title: title, Detail: detail,
		IP: ip, TargetType: targetType, TargetValue: targetValue, CreatedAt: now,
	}, nil
}

func prependAlert(alerts []dashboardAlert, alert dashboardAlert) []dashboardAlert {
	alerts = append([]dashboardAlert{alert}, alerts...)
	if len(alerts) > maxAlerts {
		alerts = alerts[:maxAlerts]
	}
	return alerts
}
