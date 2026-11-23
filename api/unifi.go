package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const unifiResponseLimit = 8 << 20

type unifiImporter struct {
	baseURL string
	apiKey  string
	siteID  string
	client  *http.Client
}

type unifiClientRecord struct {
	Name      string `json:"name"`
	IP        string `json:"ipAddress"`
	MAC       string `json:"macAddress"`
	Hostname  string `json:"hostname"`
}

type unifiSite struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type unifiSyncResult struct {
	Imported int `json:"imported"`
	Skipped  int `json:"skipped"`
}

func newUniFiImporter() (*unifiImporter, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("UNIFI_URL")), "/")
	apiKey := strings.TrimSpace(os.Getenv("UNIFI_API_KEY"))
	if baseURL == "" && apiKey == "" {
		return nil, nil
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("UNIFI_URL must be an https URL without credentials, query or fragment")
	}
	if apiKey == "" {
		return nil, errors.New("UNIFI_API_KEY is required when UNIFI_URL is set")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if caFile := strings.TrimSpace(os.Getenv("UNIFI_CA_FILE")); caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, fmt.Errorf("read UNIFI_CA_FILE: %w", err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("UNIFI_CA_FILE contains no valid CA certificate")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	return &unifiImporter{
		baseURL: baseURL, apiKey: apiKey, siteID: strings.TrimSpace(os.Getenv("UNIFI_SITE_ID")),
		client: &http.Client{Timeout: 15 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

func (u *unifiImporter) configured() bool { return u != nil && u.baseURL != "" && u.apiKey != "" }

func (u *unifiImporter) get(ctx context.Context, endpoint string, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.baseURL+endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-API-Key", u.apiKey)
	resp, err := u.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("UniFi Network API returned HTTP %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, unifiResponseLimit)).Decode(target); err != nil {
		return fmt.Errorf("invalid UniFi Network API response: %w", err)
	}
	return nil
}

func (u *unifiImporter) resolveSite(ctx context.Context) (string, error) {
	if u.siteID != "" {
		return u.siteID, nil
	}
	var response struct {
		Data []unifiSite `json:"data"`
	}
	if err := u.get(ctx, "/proxy/network/integration/v1/sites", &response); err != nil {
		return "", err
	}
	if len(response.Data) != 1 || response.Data[0].ID == "" {
		return "", errors.New("set UNIFI_SITE_ID: UniFi API did not return exactly one site")
	}
	return response.Data[0].ID, nil
}

func (u *unifiImporter) clients(ctx context.Context) ([]unifiClientRecord, error) {
	siteID, err := u.resolveSite(ctx)
	if err != nil {
		return nil, err
	}
	var clients []unifiClientRecord
	const pageSize = 100
	for offset := 0; offset < 10000; offset += pageSize {
		path := "/proxy/network/integration/v1/sites/" + url.PathEscape(siteID) + "/clients?limit=" + strconv.Itoa(pageSize) + "&offset=" + strconv.Itoa(offset)
		var response struct {
			Data []unifiClientRecord `json:"data"`
		}
		if err := u.get(ctx, path, &response); err != nil {
			return nil, err
		}
		clients = append(clients, response.Data...)
		if len(response.Data) < pageSize {
			return clients, nil
		}
	}
	return nil, errors.New("UniFi client list exceeded 10000 records")
}

func (u *unifiImporter) importNames(ctx context.Context, hosts *store) (unifiSyncResult, error) {
	clients, err := u.clients(ctx)
	if err != nil {
		return unifiSyncResult{}, err
	}
	hosts.mu.Lock()
	defer hosts.mu.Unlock()
	names, err := hosts.load()
	if err != nil {
		return unifiSyncResult{}, err
	}
	result := unifiSyncResult{}
	for _, client := range clients {
		ip, err := netip.ParseAddr(strings.TrimSpace(client.IP))
		if err != nil {
			result.Skipped++
			continue
		}
		if _, exists := names[ip.String()]; exists {
			result.Skipped++
			continue
		}
		name := strings.TrimSpace(client.Name)
		if name == "" {
			name = strings.TrimSpace(client.Hostname)
		}
		name, err = cleanName(name)
		if err != nil || name == "" {
			result.Skipped++
			continue
		}
		if len(names) >= maxEntries {
			return result, errors.New("hosts.csv is at its 5000-entry limit")
		}
		names[ip.String()] = name
		result.Imported++
	}
	if result.Imported > 0 {
		if err := hosts.save(names); err != nil {
			return result, err
		}
	}
	return result, nil
}

func (u *unifiImporter) routes(mux *http.ServeMux, auth *authCfg, hosts *store) {
	mux.HandleFunc("GET /api/unifi/status", auth.require(func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, http.StatusOK, map[string]bool{"configured": u.configured()})
	}))
	mux.HandleFunc("POST /api/unifi/sync", auth.require(func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			fail(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}
		if !u.configured() {
			fail(w, http.StatusServiceUnavailable, "UniFi import is not configured")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		result, err := u.importNames(ctx, hosts)
		if err != nil {
			log.Printf("UniFi-Import fehlgeschlagen: %v", err)
			fail(w, http.StatusBadGateway, "UniFi import failed; check the API and server logs")
			return
		}
		if result.Imported > 0 {
			reloadVector()
		}
		jsonOut(w, http.StatusOK, result)
	}))
}
