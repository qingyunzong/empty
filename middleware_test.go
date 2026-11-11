package q245_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	q245 "example.com/dlks/q245"
)

const (
	tenantA   = "tenant-a"
	tenantB   = "tenant-b"
	secretA   = "secret-for-a"
	secretB   = "secret-for-b"
	tolerance = 30 * time.Second
	nonceTTL  = time.Minute
	maxBody   = int64(1024)
)

var errBoom = errors.New("business boom")

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 11, 11, 8, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type recordingHandler struct {
	mu      sync.Mutex
	calls   int
	bodies  []string
	tenants []string
	err     error
}

func (h *recordingHandler) HandleWebhook(ctx context.Context, tx q245.Tx, tenant string, body []byte) error {
	if q245.TenantFromContext(ctx) != tenant {
		return fmt.Errorf("context tenant %q != %q", q245.TenantFromContext(ctx), tenant)
	}
	if q245.TxFromContext(ctx) != tx {
		return errors.New("tx missing from context")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls++
	h.bodies = append(h.bodies, string(body))
	h.tenants = append(h.tenants, tenant)
	return h.err
}

func (h *recordingHandler) callCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.calls
}

type fixture struct {
	clock   *fakeClock
	keys    *q245.MemoryTenantKeyStore
	txMgr   *q245.MemoryTransactionManager
	handler *recordingHandler
	mux     http.Handler
}

func newFixture(t *testing.T, handlerErr error) *fixture {
	t.Helper()

	clock := newFakeClock()
	keys := q245.NewMemoryTenantKeyStore(map[string][]byte{
		tenantA: []byte(secretA),
		tenantB: []byte(secretB),
	})
	txMgr := q245.NewMemoryTransactionManager(clock)
	handler := &recordingHandler{err: handlerErr}

	mw, err := q245.New(q245.Config{
		Keys:           keys,
		TxManager:      txMgr,
		Handler:        handler,
		ClockTolerance: tolerance,
		MaxBodyBytes:   maxBody,
		NonceTTL:       nonceTTL,
		Clock:          clock,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("POST /webhooks/{tenant}", mw)

	return &fixture{
		clock:   clock,
		keys:    keys,
		txMgr:   txMgr,
		handler: handler,
		mux:     mux,
	}
}

func (f *fixture) newSignedRequest(t *testing.T, tenant, secret, nonce string, body []byte, ts time.Time) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "/webhooks/"+tenant, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set(q245.HeaderTimestamp, strconv.FormatInt(ts.Unix(), 10))
	req.Header.Set(q245.HeaderNonce, nonce)
	req.Header.Set(q245.HeaderSignature, q245.Sign([]byte(secret), ts.Unix(), nonce, body))
	return req
}

func (f *fixture) serve(req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	return rec
}

func bodyText(rec *httptest.ResponseRecorder) string {
	return rec.Body.String()
}

func TestValidRequestDispatchesExactBytes(t *testing.T) {
	f := newFixture(t, nil)
	body := []byte(`{"event":"order.created","id":42}`)

	rec := f.serve(f.newSignedRequest(t, tenantA, secretA, "nonce-1", body, f.clock.Now()))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, bodyText(rec))
	}
	if f.handler.callCount() != 1 {
		t.Fatalf("handler calls = %d, want 1", f.handler.callCount())
	}
	if got := f.handler.bodies[0]; got != string(body) {
		t.Fatalf("handler body = %q, want %q", got, body)
	}
	if got := f.handler.tenants[0]; got != tenantA {
		t.Fatalf("handler tenant = %q, want %q", got, tenantA)
	}
	if f.txMgr.Committed() != 1 || f.txMgr.RolledBack() != 0 {
		t.Fatalf("committed=%d rolledBack=%d, want 1/0", f.txMgr.Committed(), f.txMgr.RolledBack())
	}
}

func TestRouteTenantWinsOverBodyTenant(t *testing.T) {
	f := newFixture(t, nil)
	// The body claims tenantB, but the request is mounted on tenantA's
	// route and signed with tenantA's secret.
	body := []byte(`{"tenant":"tenant-b","event":"ping"}`)

	rec := f.serve(f.newSignedRequest(t, tenantA, secretA, "nonce-route", body, f.clock.Now()))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, bodyText(rec))
	}
	if got := f.handler.tenants[0]; got != tenantA {
		t.Fatalf("handler tenant = %q, want route tenant %q", got, tenantA)
	}
}

func TestUnknownTenantRejected(t *testing.T) {
	f := newFixture(t, nil)

	rec := f.serve(f.newSignedRequest(t, "ghost", "whatever", "nonce-x", []byte(`{}`), f.clock.Now()))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if f.handler.callCount() != 0 {
		t.Fatalf("handler must not run for unknown tenant, calls=%d", f.handler.callCount())
	}
}

func TestWrongTenantSecretRejected(t *testing.T) {
	f := newFixture(t, nil)
	body := []byte(`{"event":"ping"}`)

	// Signed with tenantB's secret but delivered on tenantA's route.
	rec := f.serve(f.newSignedRequest(t, tenantA, secretB, "nonce-wrong-key", body, f.clock.Now()))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401, body=%s", rec.Code, bodyText(rec))
	}
	if f.handler.callCount() != 0 {
		t.Fatalf("handler must not run on bad signature, calls=%d", f.handler.callCount())
	}
}

func TestBytesChangedAfterSigningRejected(t *testing.T) {
	f := newFixture(t, nil)
	original := []byte(`{"amount":100}`)
	req := f.newSignedRequest(t, tenantA, secretA, "nonce-tamper", original, f.clock.Now())

	// Swap the body after signing without refreshing the signature.
	tampered := []byte(`{"amount":999}`)
	req.Body = io.NopCloser(bytes.NewReader(tampered))
	req.ContentLength = int64(len(tampered))

	rec := f.serve(req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401, body=%s", rec.Code, bodyText(rec))
	}
	if f.handler.callCount() != 0 {
		t.Fatalf("handler must not run on tampered body, calls=%d", f.handler.callCount())
	}
}

func TestSignatureHeaderTamperedRejected(t *testing.T) {
	f := newFixture(t, nil)
	req := f.newSignedRequest(t, tenantA, secretA, "nonce-sig", []byte(`{"event":"ping"}`), f.clock.Now())
	req.Header.Set(q245.HeaderSignature, req.Header.Get(q245.HeaderSignature)+"00")

	rec := f.serve(req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestBodyOverLimitRejected(t *testing.T) {
	f := newFixture(t, nil)
	body := bytes.Repeat([]byte("x"), int(maxBody)+1)

	rec := f.serve(f.newSignedRequest(t, tenantA, secretA, "nonce-big", body, f.clock.Now()))

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if f.handler.callCount() != 0 {
		t.Fatalf("handler must not run on oversized body, calls=%d", f.handler.callCount())
	}
}

func TestTimestampToleranceBoundaries(t *testing.T) {
	body := []byte(`{}`)

	tests := []struct {
		name   string
		offset time.Duration
		want   int
	}{
		{name: "exactly at lower bound", offset: -tolerance, want: http.StatusOK},
		{name: "exactly at upper bound", offset: tolerance, want: http.StatusOK},
		{name: "one second past upper bound", offset: tolerance + time.Second, want: http.StatusUnauthorized},
		{name: "one second before lower bound", offset: -tolerance - time.Second, want: http.StatusUnauthorized},
	}

	for i, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, nil)
			ts := f.clock.Now().Add(tc.offset)
			req := f.newSignedRequest(t, tenantA, secretA, fmt.Sprintf("nonce-ts-%d", i), body, ts)

			rec := f.serve(req)

			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d, body=%s", rec.Code, tc.want, bodyText(rec))
			}
		})
	}
}

func TestNonceReplayRejectedSequentially(t *testing.T) {
	f := newFixture(t, nil)
	body := []byte(`{"event":"ping"}`)

	first := f.serve(f.newSignedRequest(t, tenantA, secretA, "shared-nonce", body, f.clock.Now()))
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d, want 200", first.Code)
	}

	second := f.serve(f.newSignedRequest(t, tenantA, secretA, "shared-nonce", body, f.clock.Now()))
	if second.Code != http.StatusConflict {
		t.Fatalf("second status = %d, want 409, body=%s", second.Code, bodyText(second))
	}
	if f.handler.callCount() != 1 {
		t.Fatalf("handler calls = %d, want 1 (replay blocked)", f.handler.callCount())
	}
	if f.txMgr.Committed() != 1 || f.txMgr.Duplicates() != 1 {
		t.Fatalf("committed=%d duplicates=%d, want 1/1", f.txMgr.Committed(), f.txMgr.Duplicates())
	}
}

func TestSameNonceDifferentTenantsIsolated(t *testing.T) {
	f := newFixture(t, nil)
	body := []byte(`{"event":"ping"}`)

	respA := f.serve(f.newSignedRequest(t, tenantA, secretA, "same-nonce", body, f.clock.Now()))
	respB := f.serve(f.newSignedRequest(t, tenantB, secretB, "same-nonce", body, f.clock.Now()))

	if respA.Code != http.StatusOK || respB.Code != http.StatusOK {
		t.Fatalf("statuses A=%d B=%d, want both 200", respA.Code, respB.Code)
	}
	if f.txMgr.Committed() != 2 {
		t.Fatalf("committed = %d, want 2", f.txMgr.Committed())
	}
}

func TestConcurrentDuplicateNonceCommitsOnce(t *testing.T) {
	f := newFixture(t, nil)
	body := []byte(`{"event":"burst"}`)

	const n = 16
	var wg sync.WaitGroup
	statuses := make(chan int, n)
	start := make(chan struct{})

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := f.newSignedRequest(t, tenantA, secretA, "race-nonce", body, f.clock.Now())
			<-start
			statuses <- f.serve(req).Code
		}()
	}

	close(start)
	wg.Wait()
	close(statuses)

	var ok, conflict int
	for status := range statuses {
		switch status {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			conflict++
		default:
			t.Fatalf("unexpected status %d", status)
		}
	}

	if ok != 1 {
		t.Fatalf("successful commits = %d, want exactly 1", ok)
	}
	if conflict != n-1 {
		t.Fatalf("conflicts = %d, want %d", conflict, n-1)
	}
	if f.handler.callCount() != 1 {
		t.Fatalf("handler calls = %d, want 1", f.handler.callCount())
	}
	if f.txMgr.Committed() != 1 {
		t.Fatalf("committed = %d, want 1", f.txMgr.Committed())
	}
}

func TestRollbackFreesNonceForRetry(t *testing.T) {
	f := newFixture(t, errBoom)
	body := []byte(`{"event":"transfer"}`)

	first := f.serve(f.newSignedRequest(t, tenantA, secretA, "retry-nonce", body, f.clock.Now()))
	if first.Code != http.StatusInternalServerError {
		t.Fatalf("failing request status = %d, want 500", first.Code)
	}
	if f.txMgr.RolledBack() != 1 {
		t.Fatalf("rolledBack = %d, want 1", f.txMgr.RolledBack())
	}

	// Same nonce again: the rollback released the occupation, so the
	// duplicate check must not block the retry.
	second := f.serve(f.newSignedRequest(t, tenantA, secretA, "retry-nonce", body, f.clock.Now()))
	if second.Code != http.StatusInternalServerError {
		t.Fatalf("retry status = %d, want 500 (handler still failing)", second.Code)
	}
	if f.txMgr.Duplicates() != 0 {
		t.Fatalf("duplicates = %d, want 0 after rollback", f.txMgr.Duplicates())
	}

	// Once the business problem is fixed, the same nonce commits.
	f.handler.err = nil
	third := f.serve(f.newSignedRequest(t, tenantA, secretA, "retry-nonce", body, f.clock.Now()))
	if third.Code != http.StatusOK {
		t.Fatalf("successful retry status = %d, want 200, body=%s", third.Code, bodyText(third))
	}
	if f.txMgr.Committed() != 1 || f.txMgr.RolledBack() != 2 {
		t.Fatalf("committed=%d rolledBack=%d, want 1/2", f.txMgr.Committed(), f.txMgr.RolledBack())
	}
}

func TestExpiredNonceReclaimedAndReusable(t *testing.T) {
	f := newFixture(t, nil)
	body := []byte(`{"event":"ping"}`)

	first := f.serve(f.newSignedRequest(t, tenantA, secretA, "expiring-nonce", body, f.clock.Now()))
	if first.Code != http.StatusOK {
		t.Fatalf("first status = %d, want 200", first.Code)
	}

	// One nanosecond before expiry the nonce is still live and blocks.
	f.clock.advance(nonceTTL - time.Nanosecond)
	live := f.serve(f.newSignedRequest(t, tenantA, secretA, "expiring-nonce", body, f.clock.Now()))
	if live.Code != http.StatusConflict {
		t.Fatalf("pre-expiry status = %d, want 409", live.Code)
	}

	// Exactly at the expiry instant the entry is reclaimable; the
	// duplicate attempt evicts it lazily and commits fresh.
	f.clock.advance(time.Nanosecond)
	expired := f.serve(f.newSignedRequest(t, tenantA, secretA, "expiring-nonce", body, f.clock.Now()))
	if expired.Code != http.StatusOK {
		t.Fatalf("post-expiry status = %d, want 200, body=%s", expired.Code, bodyText(expired))
	}
	if f.txMgr.Reaped() != 1 || f.txMgr.Committed() != 2 {
		t.Fatalf("reaped=%d committed=%d, want 1/2", f.txMgr.Reaped(), f.txMgr.Committed())
	}
}

func TestReapExpiredBoundary(t *testing.T) {
	clock := newFakeClock()
	mgr := q245.NewMemoryTransactionManager(clock)
	ctx := context.Background()
	now := clock.Now()

	runTx := func(nonce string, ttl time.Duration) {
		t.Helper()
		err := mgr.WithinTx(ctx, tenantA, nonce, now.Add(ttl), func(q245.Tx) error { return nil })
		if err != nil {
			t.Fatalf("WithinTx(%s): %v", nonce, err)
		}
	}

	runTx("expires-on-the-second", nonceTTL)
	runTx("lives-longer", 2*nonceTTL)

	clock.advance(nonceTTL)
	if reaped := mgr.ReapExpired(); reaped != 1 {
		t.Fatalf("ReapExpired at exact expiry = %d, want 1", reaped)
	}

	// The expired nonce is available again; the live one still guards.
	if err := mgr.WithinTx(ctx, tenantA, "expires-on-the-second", clock.Now().Add(nonceTTL), func(q245.Tx) error { return nil }); err != nil {
		t.Fatalf("reuse reaped nonce: %v", err)
	}
	err := mgr.WithinTx(ctx, tenantA, "lives-longer", clock.Now().Add(nonceTTL), func(q245.Tx) error { return nil })
	if !errors.Is(err, q245.ErrDuplicateNonce) {
		t.Fatalf("live nonce error = %v, want ErrDuplicateNonce", err)
	}
}

func TestMissingOrMalformedHeadersRejected(t *testing.T) {
	f := newFixture(t, nil)

	t.Run("missing nonce", func(t *testing.T) {
		req := f.newSignedRequest(t, tenantA, secretA, "nonce-h", []byte("{}"), f.clock.Now())
		req.Header.Del(q245.HeaderNonce)
		if rec := f.serve(req); rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("missing timestamp", func(t *testing.T) {
		req := f.newSignedRequest(t, tenantA, secretA, "nonce-h2", []byte("{}"), f.clock.Now())
		req.Header.Del(q245.HeaderTimestamp)
		if rec := f.serve(req); rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("malformed timestamp", func(t *testing.T) {
		req := f.newSignedRequest(t, tenantA, secretA, "nonce-h3", []byte("{}"), f.clock.Now())
		req.Header.Set(q245.HeaderTimestamp, "not-a-unix-time")
		if rec := f.serve(req); rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("non-hex signature", func(t *testing.T) {
		req := f.newSignedRequest(t, tenantA, secretA, "nonce-h4", []byte("{}"), f.clock.Now())
		req.Header.Set(q245.HeaderSignature, "zzzz")
		if rec := f.serve(req); rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	if f.handler.callCount() != 0 {
		t.Fatalf("handler calls = %d, want 0", f.handler.callCount())
	}
}

func TestNewValidatesConfig(t *testing.T) {
	base := q245.Config{
		Keys:           q245.NewMemoryTenantKeyStore(nil),
		TxManager:      q245.NewMemoryTransactionManager(nil),
		Handler:        q245.MessageHandlerFunc(func(context.Context, q245.Tx, string, []byte) error { return nil }),
		ClockTolerance: tolerance,
		MaxBodyBytes:   maxBody,
		NonceTTL:       nonceTTL,
	}

	cases := []struct {
		name string
		edit func(*q245.Config)
	}{
		{name: "nil keys", edit: func(c *q245.Config) { c.Keys = nil }},
		{name: "nil tx manager", edit: func(c *q245.Config) { c.TxManager = nil }},
		{name: "nil handler", edit: func(c *q245.Config) { c.Handler = nil }},
		{name: "zero tolerance", edit: func(c *q245.Config) { c.ClockTolerance = 0 }},
		{name: "zero body limit", edit: func(c *q245.Config) { c.MaxBodyBytes = 0 }},
		{name: "zero ttl", edit: func(c *q245.Config) { c.NonceTTL = 0 }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := base
			tc.edit(&cfg)
			if _, err := q245.New(cfg); err == nil {
				t.Fatal("New returned nil error, want validation error")
			}
		})
	}
}
