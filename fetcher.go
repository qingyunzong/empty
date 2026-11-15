package dataeng

import (
	"context"
	"io"
	"net/http"
	"strings"
)

// Fetcher retrieves a URL. Implementations should return the response body as
// bytes, without interpreting XML or gzip; Scheduler handles both.
type Fetcher interface {
	Fetch(ctx context.Context, rawURL string) ([]byte, error)
}

// FetchFunc adapts a function to Fetcher.
type FetchFunc func(ctx context.Context, rawURL string) ([]byte, error)

func (f FetchFunc) Fetch(ctx context.Context, rawURL string) ([]byte, error) {
	return f(ctx, rawURL)
}

// Loader is an alias for Fetcher.
type Loader = Fetcher

// SitemapFetcher is an alias for Fetcher.
type SitemapFetcher = Fetcher

// MapFetcher is a static in-memory Fetcher, convenient for tests and for
// embedding sitemaps from a local cache.
type MapFetcher map[string][]byte

func (m MapFetcher) Fetch(ctx context.Context, rawURL string) ([]byte, error) {
	if err := contextErr(ctx); err != nil {
		return nil, err
	}
	if data, ok := m[rawURL]; ok {
		return append([]byte(nil), data...), nil
	}
	if normalized, err := NormalizeURL(rawURL); err == nil {
		if data, ok := m[normalized]; ok {
			return append([]byte(nil), data...), nil
		}
	}
	return nil, &MissingResourceError{URL: rawURL}
}

// MissingResourceError is returned by MapFetcher.
type MissingResourceError struct {
	URL string
}

func (e *MissingResourceError) Error() string {
	return "sitemap: resource not found in map: " + e.URL
}

// HTTPFetcher retrieves sitemaps and pages over HTTP(S).
type HTTPFetcher struct {
	Client    *http.Client
	UserAgent string
	MaxBytes  int64
	Header    http.Header
}

// NewHTTPFetcher creates an HTTPFetcher. A nil client uses http.DefaultClient.
func NewHTTPFetcher(client *http.Client) *HTTPFetcher {
	if client == nil {
		client = http.DefaultClient
	}
	return &HTTPFetcher{
		Client:    client,
		UserAgent: "dataeng-sitemap-scheduler/1.0",
		MaxBytes:  DefaultMaxBodyBytes,
	}
}

// Fetch implements Fetcher.
func (f *HTTPFetcher) Fetch(ctx context.Context, rawURL string) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	normalized, err := NormalizeURL(rawURL)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, normalized, nil)
	if err != nil {
		return nil, err
	}
	userAgent := strings.TrimSpace(f.UserAgent)
	if userAgent == "" {
		userAgent = "dataeng-sitemap-scheduler/1.0"
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/xml, text/xml, application/x-gzip, */*")
	for key, values := range f.Header {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	client := f.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HTTPError{
			URL:        normalized,
			StatusCode: resp.StatusCode,
			Status:     resp.Status,
		}
	}
	maxBytes := f.MaxBytes
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBodyBytes
	}
	data, err := ReadAllLimit(io.LimitReader(resp.Body, maxBytes+1), maxBytes)
	if err != nil {
		return nil, err
	}
	return data, nil
}
