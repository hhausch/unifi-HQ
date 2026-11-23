package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type pushNotifier struct {
	provider string
	baseURL  string
	topic    string
	token    string
	client   *http.Client
}

func newPushNotifier() (*pushNotifier, error) {
	provider := strings.ToLower(strings.TrimSpace(os.Getenv("ALERT_PUSH_PROVIDER")))
	if provider == "" || provider == "off" {
		return nil, nil
	}
	if provider != "ntfy" && provider != "gotify" {
		return nil, errors.New("ALERT_PUSH_PROVIDER must be ntfy, gotify or off")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("ALERT_PUSH_URL")), "/")
	u, err := url.Parse(baseURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("ALERT_PUSH_URL must be an http(s) URL without credentials, query or fragment")
	}
	topic := strings.TrimSpace(os.Getenv("ALERT_PUSH_TOPIC"))
	if provider == "ntfy" {
		if topic == "" || len(topic) > 64 || strings.ContainsAny(topic, "/?#") {
			return nil, errors.New("ALERT_PUSH_TOPIC is required for ntfy and must be at most 64 characters")
		}
		baseURL += "/" + url.PathEscape(topic)
	}
	token := strings.TrimSpace(os.Getenv("ALERT_PUSH_TOKEN"))
	if provider == "gotify" && token == "" {
		return nil, errors.New("ALERT_PUSH_TOKEN is required for Gotify")
	}
	return &pushNotifier{
		provider: provider, baseURL: baseURL, topic: topic, token: token,
		client: &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

func (p *pushNotifier) send(ctx context.Context, alert dashboardAlert) error {
	var body []byte
	var err error
	contentType := "application/json"
	endpoint := p.baseURL
	if p.provider == "ntfy" {
		body = []byte(alert.Title + ": " + alert.Detail)
		contentType = "text/plain; charset=utf-8"
	} else {
		body, err = json.Marshal(map[string]any{"title": alert.Title, "message": alert.Detail, "priority": 5})
		if err != nil {
			return err
		}
		endpoint += "/message"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	if p.provider == "ntfy" {
		req.Header.Set("Title", alert.Title)
		if p.token != "" {
			req.Header.Set("Authorization", "Bearer "+p.token)
		}
	} else {
		req.Header.Set("X-Gotify-Key", p.token)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s returned HTTP %d", p.provider, resp.StatusCode)
	}
	return nil
}

func (s *dashboardStore) pendingPushAlerts() ([]dashboardAlert, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	pending := make([]dashboardAlert, 0)
	for _, alert := range data.Alerts {
		if alert.PushPending {
			pending = append(pending, alert)
			if len(pending) == 25 {
				break
			}
		}
	}
	return pending, nil
}

func (s *dashboardStore) markPushDelivered(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.loadLocked()
	if err != nil {
		return err
	}
	for i := range data.Alerts {
		if data.Alerts[i].ID == id && data.Alerts[i].PushPending {
			data.Alerts[i].PushPending = false
			return s.saveLocked(data)
		}
	}
	return nil
}

func runPushDelivery(ctx context.Context, store *dashboardStore, notifier *pushNotifier) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	deliver := func() {
		alerts, err := store.pendingPushAlerts()
		if err != nil {
			log.Printf("Push-Benachrichtigungen: Warteschlange nicht lesbar: %v", err)
			return
		}
		for _, alert := range alerts {
			requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := notifier.send(requestCtx, alert)
			cancel()
			if err != nil {
				log.Printf("Push-Benachrichtigung %s fehlgeschlagen: %v", alert.ID, err)
				continue
			}
			if err := store.markPushDelivered(alert.ID); err != nil {
				log.Printf("Push-Benachrichtigung %s wurde gesendet, Status konnte nicht gespeichert werden: %v", alert.ID, err)
			}
		}
	}
	deliver()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			deliver()
		}
	}
}
