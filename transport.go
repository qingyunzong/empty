package q149

import (
	"bytes"
	"errors"
	"io"
	"net/http"
)

// CachingTransport is an http.RoundTripper that serves and maintains a Cache
// in front of a base transport. Only GET requests participate in caching;
// requests carrying Cache-Control: no-store or no-cache always bypass it.
type CachingTransport struct {
	Cache *Cache
	Base  http.RoundTripper
}

// RoundTrip implements http.RoundTripper.
func (t *CachingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	if !requestCacheable(req) {
		return base.RoundTrip(req)
	}

	if hit := t.Cache.Lookup(req); hit != nil {
		return t.serveCached(req, base, hit)
	}
	return t.fetchAndStore(req, base)
}

func (t *CachingTransport) serveCached(req *http.Request, base http.RoundTripper, hit *Entry) (*http.Response, error) {
	if t.Cache.Fresh(hit) {
		return cachedResponse(hit), nil
	}
	conditional, err := conditionalRequest(req, hit)
	if err != nil {
		// No validator available: serve the stored representation as-is.
		return cachedResponse(hit), nil
	}

	resp, err := base.RoundTrip(conditional)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusNotModified {
		// A full response replaces the stale cache path.
		if !Cacheable(resp.Header) {
			t.deleteStale(hit)
			return resp, nil
		}
		stored, storeErr := t.Cache.Store(req, resp.Header, resp.Body)
		if storeErr != nil {
			return nil, storeErr
		}
		return cachedResponse(stored), nil
	}

	drainAndClose(resp.Body)
	refreshed, err := t.Cache.Revalidate(hit, resp.Header)
	if err == ErrEntryGone {
		// A newer committed response wins; re-read whichever variant now matches.
		if current := t.Cache.Lookup(req); current != nil {
			return cachedResponse(current), nil
		}
		return t.fetchAndStore(req, base)
	}
	if err != nil {
		return nil, err
	}
	return cachedResponse(refreshed), nil
}

func (t *CachingTransport) fetchAndStore(req *http.Request, base http.RoundTripper) (*http.Response, error) {
	resp, err := base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	if !Cacheable(resp.Header) {
		return resp, nil
	}
	stored, err := t.Cache.Store(req, resp.Header, resp.Body)
	if err != nil {
		return nil, err
	}
	return cachedResponse(stored), nil
}

func (t *CachingTransport) deleteStale(stale *Entry) {
	t.Cache.mu.Lock()
	defer t.Cache.mu.Unlock()
	if current, ok := t.Cache.byID[stale.id]; ok && current == stale {
		delete(t.Cache.byID, stale.id)
		if variants := t.Cache.byURL[stale.url]; variants != nil {
			delete(variants, stale.id)
			if len(variants) == 0 {
				delete(t.Cache.byURL, stale.url)
			}
		}
	}
}

func cachedResponse(entry *Entry) *http.Response {
	return &http.Response{
		StatusCode:    entry.status,
		Status:        http.StatusText(entry.status),
		Header:        cloneHeader(entry.header),
		Body:          io.NopCloser(bytes.NewReader(entry.body)),
		ContentLength: int64(len(entry.body)),
	}
}

func conditionalRequest(original *http.Request, entry *Entry) (*http.Request, error) {
	etag := entry.header.Get("ETag")
	lastModified := entry.header.Get("Last-Modified")
	if etag == "" && lastModified == "" {
		return nil, errNoValidator
	}

	conditional := original.Clone(original.Context())
	conditional.Header = cloneHeader(original.Header)
	conditional.Header.Del("If-None-Match")
	conditional.Header.Del("If-Modified-Since")
	if etag != "" {
		conditional.Header.Set("If-None-Match", etag)
	}
	if lastModified != "" {
		conditional.Header.Set("If-Modified-Since", lastModified)
	}
	return conditional, nil
}

var errNoValidator = errors.New("q149: stored entry has no ETag or Last-Modified validator")

func requestCacheable(req *http.Request) bool {
	if req.Method != "" && req.Method != http.MethodGet {
		return false
	}
	for _, directive := range parseCacheControl(req.Header.Get("Cache-Control")) {
		if directive == "no-store" || directive == "no-cache" {
			return false
		}
	}
	return true
}

func drainAndClose(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, body)
	_ = body.Close()
}
