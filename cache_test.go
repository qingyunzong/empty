package q149

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newGET(t *testing.T, rawURL string, headers map[string]string) *http.Request {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	req := &http.Request{Method: http.MethodGet, URL: parsed, Header: make(http.Header)}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	return req
}

func responseHeader(kv ...string) http.Header {
	header := make(http.Header)
	for i := 0; i+1 < len(kv); i += 2 {
		header.Set(kv[i], kv[i+1])
	}
	return header
}

type failReadCloser struct {
	readErr error
	closed  atomic.Bool
}

func (f *failReadCloser) Read([]byte) (int, error) { return 0, f.readErr }

func (f *failReadCloser) Close() error {
	f.closed.Store(true)
	return nil
}

type closeTrackingBody struct {
	io.Reader
	closed atomic.Bool
}

func (c *closeTrackingBody) Close() error {
	c.closed.Store(true)
	return nil
}

func TestStoreAndLookupBasic(t *testing.T) {
	clock := NewFakeClock(time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC))
	cache := NewCache(clock)
	req := newGET(t, "https://example.test/a", nil)

	body := &closeTrackingBody{Reader: strings.NewReader("hello")}
	entry, err := cache.Store(req, responseHeader("Content-Length", "5"), body)
	if err != nil {
		t.Fatalf("Store: %v", err)
	}
	if entry == nil || entry.ID() == 0 || string(entry.Body()) != "hello" {
		t.Fatalf("unexpected entry: %+v", entry)
	}
	if !body.closed.Load() {
		t.Fatal("Store must close the body on success")
	}
	if !entry.StoredAt().Equal(clock.Now()) {
		t.Fatalf("storedAt = %v, want %v", entry.StoredAt(), clock.Now())
	}

	hit := cache.Lookup(newGET(t, "https://example.test/a", nil))
	if hit == nil || hit.ID() != entry.ID() {
		t.Fatalf("Lookup = %+v, want stored entry %d", hit, entry.ID())
	}
	if cache.Lookup(newGET(t, "https://example.test/other", nil)) != nil {
		t.Fatal("different URL must not hit")
	}
}

func TestVarySelectsVariant(t *testing.T) {
	cache := NewCache(SystemClock{})
	rawURL := "https://example.test/v"
	store := func(acceptEncoding, payload string) *Entry {
		req := newGET(t, rawURL, map[string]string{"Accept-Encoding": acceptEncoding})
		header := responseHeader("Vary", "Accept-Encoding", "Content-Length", strconv.Itoa(len(payload)))
		entry, err := cache.Store(req, header,
			&closeTrackingBody{Reader: strings.NewReader(payload)})
		if err != nil {
			t.Fatalf("Store: %v", err)
		}
		return entry
	}

	gzip := store("gzip", "compressed")
	plain := store("identity", "plain-text")
	if gzip.ID() == plain.ID() {
		t.Fatal("different Vary selectors must produce distinct entries")
	}

	hit := cache.Lookup(newGET(t, rawURL, map[string]string{"Accept-Encoding": "gzip"}))
	if hit == nil || hit.ID() != gzip.ID() || string(hit.Body()) != "compressed" {
		t.Fatalf("gzip lookup mismatch: %+v", hit)
	}
	hit = cache.Lookup(newGET(t, rawURL, map[string]string{"Accept-Encoding": "identity"}))
	if hit == nil || hit.ID() != plain.ID() || string(hit.Body()) != "plain-text" {
		t.Fatalf("identity lookup mismatch: %+v", hit)
	}
	if cache.Lookup(newGET(t, rawURL, map[string]string{"Accept-Encoding": "br"})) != nil {
		t.Fatal("unmatched selector must not hit")
	}
}

func TestVaryChangeReplacesVariant(t *testing.T) {
	cache := NewCache(SystemClock{})
	rawURL := "https://example.test/change"

	firstReq := newGET(t, rawURL, map[string]string{"Accept-Language": "en"})
	first, err := cache.Store(firstReq,
		responseHeader("Vary", "Accept-Language", "Content-Length", "2"),
		&closeTrackingBody{Reader: strings.NewReader("en")})
	if err != nil {
		t.Fatalf("Store first: %v", err)
	}

	// The response now varies on a different field set. The old record stays
	// until it is replaced via a request that still selects it under the new
	// Vary rule; the new rule is what governs subsequent selection.
	secondReq := newGET(t, rawURL, map[string]string{"Accept-Encoding": "gzip"})
	second, err := cache.Store(secondReq,
		responseHeader("Vary", "Accept-Encoding", "Content-Length", "1"),
		&closeTrackingBody{Reader: strings.NewReader("z")})
	if err != nil {
		t.Fatalf("Store second: %v", err)
	}
	if second.ID() == first.ID() {
		t.Fatal("changed Vary field set must create a new entry ID")
	}
	if hit := cache.Lookup(secondReq); hit == nil || hit.ID() != second.ID() {
		t.Fatalf("new variant lookup mismatch: %+v", hit)
	}

	// Re-fetching through a request matching the old selector under the new
	// Vary rule publishes a replacement and orphans the stale record.
	replacementReq := newGET(t, rawURL, map[string]string{"Accept-Encoding": "identity"})
	replacement, err := cache.Store(replacementReq,
		responseHeader("Vary", "Accept-Encoding", "Content-Length", "1"),
		&closeTrackingBody{Reader: strings.NewReader("i")})
	if err != nil {
		t.Fatalf("Store replacement: %v", err)
	}
	if cache.Lookup(replacementReq).ID() != replacement.ID() {
		t.Fatal("replacement must be the selected variant")
	}
	// Old- and new-shape records coexist for the URL; selection always follows
	// the Vary rule of the record that matches the request.
	if hit := cache.Lookup(firstReq); hit == nil || hit.ID() != first.ID() {
		t.Fatalf("old Vary shape remains selectable by its own rule, got %+v", hit)
	}
	// Once only the new Vary shape remains (old slot replaced via the new
	// rule), requests are selected purely on Accept-Encoding.
	if hit := cache.Lookup(secondReq); hit == nil || hit.ID() != second.ID() {
		t.Fatalf("new Vary rule must govern selection, got %+v", hit)
	}
}

func TestNoStoreAndVaryStarAreNotPersisted(t *testing.T) {
	cache := NewCache(SystemClock{})
	rawURL := "https://example.test/forbidden"

	for name, header := range map[string]http.Header{
		"no-store":  responseHeader("Cache-Control", "no-store"),
		"vary-star": responseHeader("Vary", "*"),
	} {
		body := &closeTrackingBody{Reader: strings.NewReader("secret")}
		entry, err := cache.Store(newGET(t, rawURL, nil), header, body)
		if err != nil {
			t.Fatalf("%s Store: %v", name, err)
		}
		if entry != nil {
			t.Fatalf("%s response must not be stored", name)
		}
		if !body.closed.Load() {
			t.Fatalf("%s body must still be drained and closed", name)
		}
		if cache.Lookup(newGET(t, rawURL, nil)) != nil {
			t.Fatalf("%s response became visible", name)
		}
	}
}

func TestBodyInterruptionPublishesNothingAndCloses(t *testing.T) {
	cache := NewCache(SystemClock{})
	readErr := errors.New("connection reset")
	body := &failReadCloser{readErr: readErr}

	entry, err := cache.Store(
		newGET(t, "https://example.test/broken", nil),
		responseHeader("Content-Length", "100"),
		body,
	)
	if !errors.Is(err, readErr) {
		t.Fatalf("err = %v, want read failure", err)
	}
	if entry != nil {
		t.Fatal("interrupted body must not produce an entry")
	}
	if !body.closed.Load() {
		t.Fatal("interrupted body must be closed")
	}
	if cache.Lookup(newGET(t, "https://example.test/broken", nil)) != nil {
		t.Fatal("no partial entry may be visible after interruption")
	}
}

func TestLengthMismatchRejectsEntry(t *testing.T) {
	cache := NewCache(SystemClock{})
	body := &closeTrackingBody{Reader: strings.NewReader("abc")}
	entry, err := cache.Store(
		newGET(t, "https://example.test/len", nil),
		responseHeader("Content-Length", "99"),
		body,
	)
	if !errors.Is(err, ErrLengthMismatch) {
		t.Fatalf("err = %v, want ErrLengthMismatch", err)
	}
	if entry != nil {
		t.Fatal("length mismatch must not publish an entry")
	}
	if !body.closed.Load() {
		t.Fatal("mismatched body must be closed")
	}
}

func TestAtomicVisibilityWhileBodyInFlight(t *testing.T) {
	cache := NewCache(SystemClock{})
	rawURL := "https://example.test/inflight"
	release := make(chan struct{})
	stream := newBlockingReadCloser("payload", release)

	storeDone := make(chan struct{})
	go func() {
		_, _ = cache.Store(newGET(t, rawURL, nil),
			responseHeader("Content-Length", "7"), stream)
		close(storeDone)
	}()

	// While the body read blocks, concurrent lookups must never observe the
	// half-published entry.
	for i := 0; i < 20; i++ {
		if cache.Lookup(newGET(t, rawURL, nil)) != nil {
			t.Fatal("entry visible before body completion")
		}
		time.Sleep(time.Millisecond)
	}

	close(release)
	select {
	case <-storeDone:
	case <-time.After(time.Second):
		t.Fatal("Store did not finish after release")
	}
	select {
	case <-stream.Closed():
	case <-time.After(time.Second):
		t.Fatal("stored body was not closed")
	}
	if cache.Lookup(newGET(t, rawURL, nil)) == nil {
		t.Fatal("entry must be visible after atomic publication")
	}
}

func TestRevalidateRefreshesBoundVariant(t *testing.T) {
	clock := NewFakeClock(time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC))
	cache := NewCache(clock)
	rawURL := "https://example.test/rev"

	stale, err := cache.Store(
		newGET(t, rawURL, map[string]string{"Accept-Encoding": "gzip"}),
		responseHeader("Vary", "Accept-Encoding", "ETag", `"v1"`, "Cache-Control", "max-age=10", "Content-Length", "4"),
		&closeTrackingBody{Reader: strings.NewReader("data")},
	)
	if err != nil {
		t.Fatalf("Store: %v", err)
	}

	clock.Advance(time.Hour)
	refreshed, err := cache.Revalidate(stale, responseHeader(
		"ETag", `"v2"`,
		"Cache-Control", "max-age=60",
		"Connection", "keep-alive",
	))
	if err != nil {
		t.Fatalf("Revalidate: %v", err)
	}
	if refreshed.ID() != stale.ID() {
		t.Fatal("revalidation must preserve the variant identity")
	}
	if string(refreshed.Body()) != "data" {
		t.Fatal("304 must keep the stored body")
	}
	if refreshed.Header().Get("ETag") != `"v2"` {
		t.Fatal("304 must update validator headers")
	}
	if refreshed.Header().Get("Connection") != "" {
		t.Fatal("hop-by-hop headers from the 304 must not persist")
	}
	if got := refreshed.Header().Get("Content-Length"); got != "4" {
		t.Fatalf("stored Content-Length must be retained, got %q", got)
	}
	if !refreshed.StoredAt().Equal(clock.Now()) {
		t.Fatal("revalidation must stamp a fresh storage time")
	}
}

func TestLate304DoesNotOverwriteNewerResponse(t *testing.T) {
	cache := NewCache(SystemClock{})
	rawURL := "https://example.test/race"

	stale, err := cache.Store(newGET(t, rawURL, nil),
		responseHeader("ETag", `"old"`),
		&closeTrackingBody{Reader: strings.NewReader("old-body")})
	if err != nil {
		t.Fatalf("Store stale: %v", err)
	}

	// A fresh full response for the same URL and variant commits first and
	// replaces the old ID.
	fresh, err := cache.Store(newGET(t, rawURL, nil),
		responseHeader("ETag", `"new"`),
		&closeTrackingBody{Reader: strings.NewReader("new-body")})
	if err != nil {
		t.Fatalf("Store fresh: %v", err)
	}
	if fresh.ID() != stale.ID() {
		t.Fatal("same variant must reuse the same slot ID")
	}

	// The late 304 was generated from the stale conditional request.
	refreshed, err := cache.Revalidate(stale, responseHeader("ETag", `"late"`))
	if !errors.Is(err, ErrEntryGone) {
		t.Fatalf("err = %v, want ErrEntryGone", err)
	}
	if refreshed != nil {
		t.Fatal("late 304 must not return an entry")
	}

	current := cache.Lookup(newGET(t, rawURL, nil))
	if current == nil || string(current.Body()) != "new-body" ||
		current.Header().Get("ETag") != `"new"` {
		t.Fatalf("newer response must survive the late 304: %+v", current)
	}
}

func TestConcurrentStoresAndLookups(t *testing.T) {
	cache := NewCache(SystemClock{})
	rawURL := "https://example.test/concurrent"

	const writers = 16
	const readers = 16
	var wg sync.WaitGroup

	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			payload := "payload-" + strconv.Itoa(i)
			_, _ = cache.Store(newGET(t, rawURL, nil),
				responseHeader("Content-Length", strconv.Itoa(len(payload))),
				&closeTrackingBody{Reader: strings.NewReader(payload)})
		}(w)
	}

	var failures atomic.Int32
	for r := 0; r < readers; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				hit := cache.Lookup(newGET(t, rawURL, nil))
				if hit == nil {
					continue
				}
				// Every observed entry must be internally complete: the body
				// always matches its declared Content-Length.
				if declared := hit.Header().Get("Content-Length"); declared != "" {
					if n, convErr := strconv.Atoi(declared); convErr == nil && n != len(hit.Body()) {
						failures.Add(1)
						return
					}
				}
				runtime.Gosched()
			}
		}()
	}

	wg.Wait()
	if failures.Load() != 0 {
		t.Fatal("observed an entry whose body did not match Content-Length")
	}

	hit := cache.Lookup(newGET(t, rawURL, nil))
	if hit == nil {
		t.Fatal("an entry must remain visible after concurrent stores")
	}
	if len(cache.Entries()) != 1 {
		t.Fatalf("same variant must collapse to one entry, got %d", len(cache.Entries()))
	}
}
