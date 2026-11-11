package q149

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func memoryResponse(status int, header http.Header, body string) *http.Response {
	if header == nil {
		header = make(http.Header)
	}
	if header.Get("Content-Length") == "" && status != http.StatusNotModified {
		header.Set("Content-Length", strconv.Itoa(len(body)))
	}
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close body: %v", err)
	}
	return string(data)
}

func TestCachingTransportStoresAndServesCache(t *testing.T) {
	memory := NewMemoryTransport()
	rawURL := "https://example.test/page"
	memory.Handle(rawURL, func(*http.Request) *http.Response {
		return memoryResponse(http.StatusOK,
			responseHeader("ETag", `"v1"`, "Cache-Control", "max-age=60"), "first")
	})

	transport := &CachingTransport{Cache: NewCache(SystemClock{}), Base: memory}

	first, err := transport.RoundTrip(newGET(t, rawURL, nil))
	if err != nil {
		t.Fatalf("first RoundTrip: %v", err)
	}
	if body := readBody(t, first); body != "first" {
		t.Fatalf("first body = %q", body)
	}

	second, err := transport.RoundTrip(newGET(t, rawURL, nil))
	if err != nil {
		t.Fatalf("second RoundTrip: %v", err)
	}
	if body := readBody(t, second); body != "first" {
		t.Fatalf("cached body = %q, want first", body)
	}
	if len(memory.Requests()) != 1 {
		t.Fatalf("transport issued %d requests, fresh hit must not hit base", len(memory.Requests()))
	}
	if memory.BodiesOpened() != memory.BodiesClosed() {
		t.Fatalf("body leak: opened=%d closed=%d", memory.BodiesOpened(), memory.BodiesClosed())
	}
}

func TestCachingTransportConditional304(t *testing.T) {
	memory := NewMemoryTransport()
	rawURL := "https://example.test/cached"
	memory.Handle(rawURL, func(req *http.Request) *http.Response {
		if req.Header.Get("If-None-Match") == `"v1"` {
			return memoryResponse(http.StatusNotModified,
				responseHeader("ETag", `"v1"`, "Cache-Control", "max-age=99"), "")
		}
		return memoryResponse(http.StatusOK, responseHeader("ETag", `"v1"`), "payload")
	})

	transport := &CachingTransport{Cache: NewCache(SystemClock{}), Base: memory}

	first, err := transport.RoundTrip(newGET(t, rawURL, nil))
	if err != nil {
		t.Fatalf("first RoundTrip: %v", err)
	}
	if body := readBody(t, first); body != "payload" {
		t.Fatalf("first body = %q", body)
	}

	second, err := transport.RoundTrip(newGET(t, rawURL, nil))
	if err != nil {
		t.Fatalf("second RoundTrip: %v", err)
	}
	if body := readBody(t, second); body != "payload" {
		t.Fatalf("revalidated body = %q", body)
	}
	if got := second.Header.Get("Cache-Control"); got != "max-age=99" {
		t.Fatalf("304 headers not merged: %q", got)
	}

	requests := memory.Requests()
	if len(requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(requests))
	}
	if requests[1].Header.Get("If-None-Match") != `"v1"` {
		t.Fatal("conditional request must carry the stored validator")
	}
	if memory.BodiesOpened() != memory.BodiesClosed() {
		t.Fatalf("304 body leak: opened=%d closed=%d", memory.BodiesOpened(), memory.BodiesClosed())
	}
}

func TestCachingTransportFullResponseReplacesStale(t *testing.T) {
	memory := NewMemoryTransport()
	rawURL := "https://example.test/refresh"
	memory.Handle(rawURL, func(req *http.Request) *http.Response {
		if req.Header.Get("If-None-Match") != "" {
			return memoryResponse(http.StatusOK, responseHeader("ETag", `"v2"`), "fresh")
		}
		return memoryResponse(http.StatusOK, responseHeader("ETag", `"v1"`), "stale")
	})

	transport := &CachingTransport{Cache: NewCache(SystemClock{}), Base: memory}

	first, err := transport.RoundTrip(newGET(t, rawURL, nil))
	if err != nil {
		t.Fatalf("first RoundTrip: %v", err)
	}
	readBody(t, first)

	second, err := transport.RoundTrip(newGET(t, rawURL, nil))
	if err != nil {
		t.Fatalf("second RoundTrip: %v", err)
	}
	if body := readBody(t, second); body != "fresh" {
		t.Fatalf("body = %q, want fresh full response", body)
	}

	third, err := transport.RoundTrip(newGET(t, rawURL, nil))
	if err != nil {
		t.Fatalf("third RoundTrip: %v", err)
	}
	if got := third.Header.Get("ETag"); got != `"v2"` {
		t.Fatalf("new validator = %q, want v2", got)
	}
	if memory.BodiesOpened() != memory.BodiesClosed() {
		t.Fatalf("body leak: opened=%d closed=%d", memory.BodiesOpened(), memory.BodiesClosed())
	}
}

func TestCachingTransportLate304KeepsNewerResponse(t *testing.T) {
	rawURL := "https://example.test/late"
	cache := NewCache(SystemClock{})
	transport := &CachingTransport{Cache: cache}

	staleEntry, err := cache.Store(newGET(t, rawURL, nil),
		responseHeader("ETag", `"old"`, "Content-Length", "3"),
		&closeTrackingBody{Reader: strings.NewReader("old")})
	if err != nil {
		t.Fatalf("seed stale: %v", err)
	}

	// A newer response for the same variant commits before the 304 lands.
	if _, err := cache.Store(newGET(t, rawURL, nil),
		responseHeader("ETag", `"new"`, "Content-Length", "4"),
		&closeTrackingBody{Reader: strings.NewReader("new!")}); err != nil {
		t.Fatalf("seed newer: %v", err)
	}

	transport.Base = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return memoryResponse(http.StatusNotModified,
			responseHeader("ETag", `"late"`), ""), nil
	})

	resp, err := transport.serveCached(newGET(t, rawURL, nil), transport.Base, staleEntry)
	if err != nil {
		t.Fatalf("serveCached: %v", err)
	}
	if body := readBody(t, resp); body != "new!" {
		t.Fatalf("body = %q, late 304 must not clobber the newer response", body)
	}
	if got := resp.Header.Get("ETag"); got != `"new"` {
		t.Fatalf("ETag = %q, want new", got)
	}
}

func TestCachingTransportNoStoreBypassesCache(t *testing.T) {
	memory := NewMemoryTransport()
	rawURL := "https://example.test/nostore"
	memory.Handle(rawURL, func(*http.Request) *http.Response {
		return memoryResponse(http.StatusOK,
			responseHeader("Cache-Control", "no-store"), "secret")
	})

	cache := NewCache(SystemClock{})
	transport := &CachingTransport{Cache: cache, Base: memory}

	resp, err := transport.RoundTrip(newGET(t, rawURL, nil))
	if err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	if body := readBody(t, resp); body != "secret" {
		t.Fatalf("body = %q", body)
	}
	if cache.Lookup(newGET(t, rawURL, nil)) != nil {
		t.Fatal("no-store response must never be persisted")
	}

	noCacheReq := newGET(t, rawURL, nil)
	noCacheReq.Header.Set("Cache-Control", "no-cache")
	bypassed, err := transport.RoundTrip(noCacheReq)
	if err != nil {
		t.Fatalf("no-cache RoundTrip: %v", err)
	}
	readBody(t, bypassed)
	if len(memory.Requests()) != 2 {
		t.Fatalf("requests = %d, request directives must bypass cache", len(memory.Requests()))
	}
	// Both bypassed responses are caller-owned and both were consumed above.
	if got := memory.BodiesClosed(); got != 2 {
		t.Fatalf("bypassed bodies closed = %d, want 2", got)
	}
}

func TestCachingTransportVarySelection(t *testing.T) {
	memory := NewMemoryTransport()
	rawURL := "https://example.test/negotiate"
	memory.Handle(rawURL, func(req *http.Request) *http.Response {
		if req.Header.Get("Accept-Encoding") == "gzip" {
			return memoryResponse(http.StatusOK, responseHeader("Vary", "Accept-Encoding"), "gzip-body")
		}
		return memoryResponse(http.StatusOK, responseHeader("Vary", "Accept-Encoding"), "plain-body")
	})

	transport := &CachingTransport{Cache: NewCache(SystemClock{}), Base: memory}

	gzipReq := newGET(t, rawURL, map[string]string{"Accept-Encoding": "gzip"})
	plainReq := newGET(t, rawURL, map[string]string{"Accept-Encoding": "identity"})

	first, err := transport.RoundTrip(gzipReq)
	if err != nil {
		t.Fatalf("gzip first: %v", err)
	}
	readBody(t, first)
	second, err := transport.RoundTrip(plainReq)
	if err != nil {
		t.Fatalf("plain first: %v", err)
	}
	readBody(t, second)

	gzipHit, err := transport.RoundTrip(gzipReq)
	if err != nil {
		t.Fatalf("gzip hit: %v", err)
	}
	if body := readBody(t, gzipHit); body != "gzip-body" {
		t.Fatalf("gzip variant = %q", body)
	}
	plainHit, err := transport.RoundTrip(plainReq)
	if err != nil {
		t.Fatalf("plain hit: %v", err)
	}
	if body := readBody(t, plainHit); body != "plain-body" {
		t.Fatalf("plain variant = %q", body)
	}

	if len(memory.Requests()) != 2 {
		t.Fatalf("requests = %d, each variant fetched once", len(memory.Requests()))
	}
	if memory.BodiesOpened() != memory.BodiesClosed() {
		t.Fatalf("body leak: opened=%d closed=%d", memory.BodiesOpened(), memory.BodiesClosed())
	}
}

func TestCachingTransportBodyReadFailureClosesAndErrors(t *testing.T) {
	readErr := errors.New("stream exploded")
	base := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     responseHeader("Content-Length", "10"),
			Body:       &failReadCloser{readErr: readErr},
		}, nil
	})

	transport := &CachingTransport{Cache: NewCache(SystemClock{}), Base: base}
	resp, err := transport.RoundTrip(newGET(t, "https://example.test/fail", nil))
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("expected Store error to surface from RoundTrip")
	}
	if !errors.Is(err, readErr) {
		t.Fatalf("err = %v, want read failure", err)
	}
}

func TestCachingTransportConcurrentResponses(t *testing.T) {
	memory := NewMemoryTransport()
	rawURL := "https://example.test/hot"

	release := make(chan struct{})
	var calls atomic.Int32
	memory.Handle(rawURL, func(*http.Request) *http.Response {
		call := calls.Add(1)
		stream := memory.NewTrackingBody(
			newBlockingReadCloser("body-"+strconv.Itoa(int(call)), release))
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     responseHeader("ETag", `"v"`, "Cache-Control", "max-age=60"),
			Body:       stream,
		}
	})

	transport := &CachingTransport{Cache: NewCache(SystemClock{}), Base: memory}
	const parallel = 12

	var wg sync.WaitGroup
	errs := make(chan error, parallel)
	resps := make(chan *http.Response, parallel)
	for i := 0; i < parallel; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := transport.RoundTrip(newGET(t, rawURL, nil))
			if err != nil {
				errs <- err
				return
			}
			resps <- resp
		}()
	}

	// All fetches block mid-body; no entry is visible while they are in flight.
	time.Sleep(50 * time.Millisecond)
	if hit := transport.Cache.Lookup(newGET(t, rawURL, nil)); hit != nil {
		t.Fatal("entry visible before any body completed")
	}

	close(release)
	wg.Wait()
	close(errs)
	close(resps)

	for err := range errs {
		t.Fatalf("concurrent RoundTrip: %v", err)
	}
	for resp := range resps {
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatalf("read cached body: %v", err)
		}
		if !strings.HasPrefix(string(data), "body-") {
			t.Fatalf("unexpected body %q", string(data))
		}
		if err := resp.Body.Close(); err != nil {
			t.Fatalf("close cached body: %v", err)
		}
	}

	if got := calls.Load(); got != parallel {
		t.Fatalf("base calls = %d, want %d (no entry was visible to coalesce)", got, parallel)
	}
	if memory.BodiesOpened() != memory.BodiesClosed() {
		t.Fatalf("body leak: opened=%d closed=%d", memory.BodiesOpened(), memory.BodiesClosed())
	}

	// After publication, further requests are served without touching base.
	if got := calls.Load(); got != parallel {
		t.Fatalf("base calls after fill = %d, want %d", got, parallel)
	}
	hit, err := transport.RoundTrip(newGET(t, rawURL, nil))
	if err != nil {
		t.Fatalf("cached RoundTrip: %v", err)
	}
	readBody(t, hit)
	if got := calls.Load(); got != parallel {
		t.Fatalf("cached hit triggered base call: %d, want %d", got, parallel)
	}
}

func TestCachingTransportNonGETBypassesCache(t *testing.T) {
	memory := NewMemoryTransport()
	rawURL := "https://example.test/post"
	memory.HandleResponse(rawURL, memoryResponse(http.StatusOK, nil, "ok"))

	transport := &CachingTransport{Cache: NewCache(SystemClock{}), Base: memory}
	req := newGET(t, rawURL, nil)
	req.Method = http.MethodPost

	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatalf("POST RoundTrip: %v", err)
	}
	readBody(t, resp)
	if transport.Cache.Lookup(newGET(t, rawURL, nil)) != nil {
		t.Fatal("non-GET responses must not be cached")
	}
}
