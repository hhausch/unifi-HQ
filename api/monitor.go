package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultAlertInterval      = time.Minute
	defaultSourceStaleAfter   = 15 * time.Minute
	monitorQueryLimit         = 5000
	monitorQueryResponseLimit = 4 << 20
)

type volumeSample struct {
	IP        string  `json:"ip"`
	Period    string  `json:"period"`
	Direction string  `json:"direction"`
	Bytes     float64 `json:"bytes"`
}

type discoveryEvent struct {
	LocalIP        string `json:"local_ip"`
	LocalName      string `json:"local_name"`
	RemoteIP       string `json:"remote_ip"`
	Country        string `json:"r_country"`
	CountryName    string `json:"r_country_name"`
	Organization   string `json:"r_org"`
}

type discoveryState struct {
	devices   map[string]bool
	countries map[string]bool
	orgs      map[string]bool
	ready     bool
}

type sourceObservation struct {
	last *time.Time
	err  error
}

type dashboardMonitor struct {
	store      *dashboardStore
	interval   time.Duration
	staleAfter time.Duration
	now        func() time.Time
	query      func(context.Context, string, int) ([]map[string]json.RawMessage, error)
	latest     func(context.Context, string) (*time.Time, error)
	discovery  *discoveryState
}

func newDashboardMonitor(store *dashboardStore, interval, staleAfter time.Duration) *dashboardMonitor {
	return &dashboardMonitor{
		store: store, interval: interval, staleAfter: staleAfter, now: time.Now,
		query: queryVictoriaLogs, latest: latestEvent,
	}
}

func monitorDuration(name string, fallback, minimum, maximum time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration < minimum || duration > maximum {
		log.Printf("Ungültiger Wert für %s=%q; verwende %s", name, value, fallback)
		return fallback
	}
	return duration
}

func queryVictoriaLogs(ctx context.Context, query string, limit int) ([]map[string]json.RawMessage, error) {
	form := url.Values{"query": {query}}
	if limit > 0 {
		form.Set("limit", strconv.Itoa(limit))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://127.0.0.1:9428/select/logsql/query", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("VictoriaLogs returned HTTP %d", resp.StatusCode)
	}
	dec := json.NewDecoder(io.LimitReader(resp.Body, monitorQueryResponseLimit))
	rows := make([]map[string]json.RawMessage, 0)
	for {
		row := map[string]json.RawMessage{}
		if err := dec.Decode(&row); err != nil {
			if errors.Is(err, io.EOF) {
				return rows, nil
			}
			return nil, err
		}
		rows = append(rows, row)
	}
}

func rowString(row map[string]json.RawMessage, key string) string {
	var value string
	_ = json.Unmarshal(row[key], &value)
	return value
}

func rowFloat(row map[string]json.RawMessage, key string) float64 {
	var number json.Number
	if err := json.Unmarshal(row[key], &number); err == nil {
		value, _ := number.Float64()
		if !math.IsNaN(value) && !math.IsInf(value, 0) {
			return value
		}
	}
	var text string
	if err := json.Unmarshal(row[key], &text); err == nil {
		value, _ := strconv.ParseFloat(text, 64)
		if !math.IsNaN(value) && !math.IsInf(value, 0) {
			return value
		}
	}
	var value float64
	_ = json.Unmarshal(row[key], &value)
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return value
}

func (s *dashboardStore) checkVolumeSamples(samples []volumeSample) ([]dashboardAlert, error) {
	if len(samples) == 0 {
		return []dashboardAlert{}, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	now := s.now().UTC()
	created := make([]dashboardAlert, 0)
	dirty := false
	for _, sample := range samples {
		prefs, ok := data.Devices[sample.IP]
		if !ok || prefs.VolumeThresholdGiB <= 0 || prefs.VolumePeriod != sample.Period || prefs.VolumeDirection != sample.Direction {
			continue
		}
		stateKey := sample.Period + ":" + sample.Direction
		if prefs.VolumeAbove == nil {
			prefs.VolumeAbove = map[string]bool{}
		}
		over := sample.Bytes >= prefs.VolumeThresholdGiB*1024*1024*1024
		if over && !prefs.VolumeAbove[stateKey] {
			detail := fmt.Sprintf("%s used %.2f GiB in %s (%s; limit %.2f GiB)",
				sample.IP, sample.Bytes/(1024*1024*1024), sample.Period, sample.Direction, prefs.VolumeThresholdGiB)
			alert, alertErr := makeDashboardAlert(
				fmt.Sprintf("volume:%s:%s:%s:%g:%s", sample.IP, sample.Period, sample.Direction, prefs.VolumeThresholdGiB, now.Format("2006010215")),
				"volume", "Device volume threshold exceeded", detail, sample.IP, "device", sample.IP, now)
			if alertErr != nil {
				return nil, alertErr
			}
			prefs.VolumeAbove[stateKey] = true
			data.Alerts = prependAlert(data.Alerts, alert)
			created = append(created, alert)
			dirty = true
		} else if !over && prefs.VolumeAbove[stateKey] {
			prefs.VolumeAbove[stateKey] = false
			dirty = true
		}
		data.Devices[sample.IP] = prefs
	}
	if dirty {
		if err := s.saveLocked(data); err != nil {
			return nil, err
		}
	}
	return created, nil
}

func (s *dashboardStore) appendAlerts(alerts []dashboardAlert) error {
	if len(alerts) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.loadLocked()
	if err != nil {
		return err
	}
	now := s.now().UTC()
	changed := false
	for _, alert := range alerts {
		duplicate := false
		for _, existing := range data.Alerts {
			age := now.Sub(existing.CreatedAt)
			if existing.Key == alert.Key && age >= 0 && age < alertDedupWindow {
				duplicate = true
				break
			}
		}
		if !duplicate {
			data.Alerts = prependAlert(data.Alerts, alert)
			changed = true
		}
	}
	if changed {
		return s.saveLocked(data)
	}
	return nil
}

func (s *dashboardStore) updateSourceStates(observations map[string]sourceObservation, staleAfter time.Duration, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.loadLocked()
	if err != nil {
		return err
	}
	changed := false
	for name, observation := range observations {
		if observation.err != nil || observation.last == nil {
			continue
		}
		stale := now.Sub(*observation.last) > staleAfter
		wasStale := data.SourceStale[name]
		if stale == wasStale {
			continue
		}
		state := "recovered"
		title := "Data source recovered"
		detail := fmt.Sprintf("%s events resumed; latest event %s", name, observation.last.UTC().Format(time.RFC3339))
		if stale {
			state = "stale"
			title = "Data source stopped reporting"
			detail = fmt.Sprintf("No %s events recorded for more than %s; last event %s", name, staleAfter, observation.last.UTC().Format(time.RFC3339))
		}
		key := fmt.Sprintf("source:%s:%s:%d", name, state, now.UnixNano())
		alert, alertErr := makeDashboardAlert(key, "source", title, detail, "", "", "", now.UTC())
		if alertErr != nil {
			return alertErr
		}
		data.Alerts = prependAlert(data.Alerts, alert)
		data.SourceStale[name] = stale
		changed = true
	}
	if changed {
		return s.saveLocked(data)
	}
	return nil
}

func (m *dashboardMonitor) run(ctx context.Context) {
	m.check(ctx)
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.check(ctx)
		}
	}
}

func (m *dashboardMonitor) check(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 45*time.Second)
	defer cancel()
	m.checkVolumes(ctx)
	m.checkSources(ctx)
	m.checkDiscoveries(ctx)
}

func (m *dashboardMonitor) checkVolumes(ctx context.Context) {
	m.store.mu.Lock()
	data, err := m.store.loadLocked()
	m.store.mu.Unlock()
	if err != nil {
		log.Printf("Alarmüberwachung: Geräteeinstellungen nicht lesbar: %v", err)
		return
	}
	groups := map[string][]string{}
	for ip, pref := range data.Devices {
		if pref.VolumeThresholdGiB > 0 && validPeriod(pref.VolumePeriod) && validDirection(pref.VolumeDirection) {
			key := pref.VolumePeriod + ":" + pref.VolumeDirection
			groups[key] = append(groups[key], ip)
		}
	}
	if len(groups) == 0 {
		return
	}
	samples := make([]volumeSample, 0, len(data.Devices))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for key, ips := range groups {
		parts := strings.SplitN(key, ":", 2)
		period, direction := parts[0], parts[1]
		wg.Add(1)
		go func(ips []string, period, direction string) {
			defer wg.Done()
			queryDirection := "dir:" + direction
			if direction == "both" {
				queryDirection = "(dir:out or dir:\"in\")"
			} else if direction == "in" {
				queryDirection = "dir:\"in\""
			}
			rows, queryErr := m.query(ctx, fmt.Sprintf("_time:%s %s | stats by (local_ip) sum(bytes) as b", period, queryDirection), monitorQueryLimit)
			if queryErr != nil {
				log.Printf("Alarmüberwachung: Volumenabfrage %s/%s fehlgeschlagen: %v", period, direction, queryErr)
				return
			}
			totals := make(map[string]float64, len(rows))
			for _, row := range rows {
				totals[rowString(row, "local_ip")] = rowFloat(row, "b")
			}
			mu.Lock()
			for _, ip := range ips {
				samples = append(samples, volumeSample{IP: ip, Period: period, Direction: direction, Bytes: totals[ip]})
			}
			mu.Unlock()
		}(ips, period, direction)
	}
	wg.Wait()
	created, err := m.store.checkVolumeSamples(samples)
	if err != nil {
		log.Printf("Alarmüberwachung: Volumenzustand konnte nicht gespeichert werden: %v", err)
		return
	}
	if len(created) > 0 {
		log.Printf("Alarmüberwachung: %d Volumenschwellen überschritten", len(created))
	}
}

func (m *dashboardMonitor) checkSources(ctx context.Context) {
	observations := make(map[string]sourceObservation, 2)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for name, query := range map[string]string{
		"NetFlow/IPFIX": "kind:flow | sort by (_time desc) | limit 1",
		"Firewall/Syslog": "kind:blocked | sort by (_time desc) | limit 1",
	} {
		wg.Add(1)
		go func(name, query string) {
			defer wg.Done()
			last, err := m.latest(ctx, query)
			mu.Lock()
			observations[name] = sourceObservation{last: last, err: err}
			mu.Unlock()
			if err != nil {
				log.Printf("Alarmüberwachung: Status von %s nicht abfragbar: %v", name, err)
			}
		}(name, query)
	}
	wg.Wait()
	if err := m.store.updateSourceStates(observations, m.staleAfter, m.now().UTC()); err != nil {
		log.Printf("Alarmüberwachung: Datenquellenstatus konnte nicht gespeichert werden: %v", err)
	}
}

func (m *dashboardMonitor) checkDiscoveries(ctx context.Context) {
	if m.discovery == nil {
		state, err := m.loadDiscoveryBaseline(ctx)
		if err != nil {
			log.Printf("Alarmüberwachung: Erstkontakt-Baseline konnte nicht geladen werden: %v", err)
			return
		}
		m.discovery = state
		return
	}
	lookback := 2 * m.interval
	if lookback < 2*time.Minute {
		lookback = 2 * time.Minute
	}
	lookbackMinutes := int(math.Ceil(lookback.Minutes()))
	query := fmt.Sprintf(`_time:%dm (dir:out or dir:"in") | stats by (local_ip, local_name, remote_ip, r_country, r_country_name, r_org) count() as n`, lookbackMinutes)
	rows, err := m.query(ctx, query, monitorQueryLimit)
	if err != nil {
		log.Printf("Alarmüberwachung: neue Kontakte konnten nicht abgefragt werden: %v", err)
		return
	}
	now := m.now().UTC()
	window := now.Unix() / int64((30*24*time.Hour)/time.Second)
	alerts := make([]dashboardAlert, 0)
	for _, row := range rows {
		event := discoveryEvent{
			LocalIP: rowString(row, "local_ip"), LocalName: rowString(row, "local_name"),
			RemoteIP: rowString(row, "remote_ip"), Country: rowString(row, "r_country"),
			CountryName: rowString(row, "r_country_name"), Organization: rowString(row, "r_org"),
		}
		who := event.LocalName
		if who == "" {
			who = event.LocalIP
		}
		if event.LocalIP != "" && !m.discovery.devices[event.LocalIP] {
			m.discovery.devices[event.LocalIP] = true
			if alert, alertErr := makeDashboardAlert(discoveryAlertKey("device", window, event.LocalIP), "device", "Device not seen in 30 days", fmt.Sprintf("%s (%s)", who, event.LocalIP), event.LocalIP, "device", event.LocalIP, now); alertErr == nil {
				alerts = append(alerts, alert)
			} else {
				log.Printf("Alarmüberwachung: Gerätealarm konnte nicht erstellt werden: %v", alertErr)
			}
		}
		if !m.discovery.ready {
			continue
		}
		if event.Country != "" && !m.discovery.countries[event.Country] {
			m.discovery.countries[event.Country] = true
			name := event.CountryName
			if name == "" {
				name = event.Country
			}
			if alert, alertErr := makeDashboardAlert(discoveryAlertKey("country", window, event.LocalIP, event.Country), "first-contact", "First contact with "+name, fmt.Sprintf("%s → %s", who, firstNonEmpty(event.Organization, event.RemoteIP)), event.LocalIP, "country", event.Country, now); alertErr == nil {
				alerts = append(alerts, alert)
			} else {
				log.Printf("Alarmüberwachung: Länderalarm konnte nicht erstellt werden: %v", alertErr)
			}
		} else if event.Organization != "" && !m.discovery.orgs[event.Organization] {
			m.discovery.orgs[event.Organization] = true
			if alert, alertErr := makeDashboardAlert(discoveryAlertKey("org", window, event.LocalIP, event.Organization), "first-contact", "New remote: "+event.Organization, fmt.Sprintf("%s · from %s", event.Country, who), event.LocalIP, "org", event.Organization, now); alertErr == nil {
				alerts = append(alerts, alert)
			} else {
				log.Printf("Alarmüberwachung: Organisationsalarm konnte nicht erstellt werden: %v", alertErr)
			}
		}
	}
	if err := m.store.appendAlerts(alerts); err != nil {
		log.Printf("Alarmüberwachung: Entdeckungsalarme konnten nicht gespeichert werden: %v", err)
	}
}

func (m *dashboardMonitor) loadDiscoveryBaseline(ctx context.Context) (*discoveryState, error) {
	queries := []string{
		`_time:30d (dir:out or dir:"in") | stats by (local_ip) count() as n`,
		`_time:30d (dir:out or dir:"in") r_country:* | stats by (r_country) count() as n`,
		`_time:30d (dir:out or dir:"in") r_org:* | stats by (r_org) count() as n`,
		`_time:30d kind:flow | stats min(_time) as first`,
	}
	results := make([][]map[string]json.RawMessage, len(queries))
	errs := make([]error, len(queries))
	var wg sync.WaitGroup
	for i, query := range queries {
		wg.Add(1)
		go func(i int, query string) {
			defer wg.Done()
			results[i], errs[i] = m.query(ctx, query, monitorQueryLimit)
		}(i, query)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	state := &discoveryState{
		devices: make(map[string]bool, len(results[0])), countries: make(map[string]bool, len(results[1])),
		orgs: make(map[string]bool, len(results[2])),
	}
	for _, row := range results[0] {
		if ip := rowString(row, "local_ip"); ip != "" {
			state.devices[ip] = true
		}
	}
	for _, row := range results[1] {
		if country := rowString(row, "r_country"); country != "" {
			state.countries[country] = true
		}
	}
	for _, row := range results[2] {
		if org := rowString(row, "r_org"); org != "" {
			state.orgs[org] = true
		}
	}
	if len(results[3]) > 0 {
		first := rowString(results[3][0], "first")
		if first != "" {
			if firstSeen, err := time.Parse(time.RFC3339Nano, first); err == nil {
				state.ready = m.now().Sub(firstSeen) > 24*time.Hour
			}
		}
	}
	return state, nil
}

func discoveryAlertKey(kind string, window int64, parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return fmt.Sprintf("%s:%s:%d", kind, hex.EncodeToString(sum[:12]), window)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return "unknown"
}
