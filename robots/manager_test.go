package robots

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type q216Fetcher struct {
	mu    sync.Mutex
	calls int
	body  []byte
	err   error
}

func (f *q216Fetcher) Fetch(context.Context, Origin, string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return append([]byte(nil), f.body...), f.err
}

func (f *q216Fetcher) set(body string, err error) {
	f.mu.Lock()
	f.body = []byte(body)
	f.err = err
	f.mu.Unlock()
}

func (f *q216Fetcher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func q216Manager(t *testing.T, fetcher Fetcher, cfg Config) (*Manager, *AuditLog) {
	t.Helper()
	audit := NewAuditLog(0)
	if cfg.Clock == nil {
		cfg.Clock = newQ216Clock().Now
	}
	cfg.Fetcher = fetcher
	cfg.Auditor = audit
	manager, err := NewManager(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Close)
	return manager, audit
}

func hasQ216Audit(events []AuditEvent, kind AuditKind) bool {
	for _, event := range events {
		if event.Kind == kind {
			return true
		}
	}
	return false
}

func TestQ216ResolveCachesByTenantAndOrigin(t *testing.T) {
	fetcher := &q216Fetcher{body: []byte("User-agent: *\nDisallow: /private\nCrawl-delay: 2\n")}
	manager, _ := q216Manager(t, fetcher, Config{TTL: time.Hour})
	origin := q216Origin(t, "https://example.com")

	first, err := manager.Resolve(context.Background(), "tenant-a", origin)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.Resolve(context.Background(), "tenant-a", Origin{
		Scheme: "HTTPS",
		Host:   "Example.COM.",
		Port:   "443",
	})
	if err != nil {
		t.Fatal(err)
	}
	if fetcher.callCount() != 1 {
		t.Fatalf("fetch calls = %d", fetcher.callCount())
	}
	if first.Version != second.Version || first.Generation != second.Generation {
		t.Fatalf("snapshots differ: %+v %+v", first, second)
	}
	if first.Allowed("*", "/private") {
		t.Fatal("/private should be denied")
	}
	if first.CrawlDelay("*") != 2*time.Second {
		t.Fatalf("crawl delay = %v", first.CrawlDelay("*"))
	}

	if _, err := manager.Resolve(context.Background(), "tenant-b", origin); err != nil {
		t.Fatal(err)
	}
	if fetcher.callCount() != 2 {
		t.Fatalf("tenants should not share policy fetches, calls = %d", fetcher.callCount())
	}
}

func TestQ216FailOpenAndFailClosedAreAudited(t *testing.T) {
	networkError := errors.New("dial refused")
	for _, mode := range []FailureMode{FailOpen, FailClosed} {
		t.Run(mode.String(), func(t *testing.T) {
			fetcher := &q216Fetcher{err: networkError}
			manager, audit := q216Manager(t, fetcher, Config{FailureMode: mode, FailureTTL: time.Minute})
			origin := q216Origin(t, "https://example.com")

			snapshot, err := manager.Resolve(context.Background(), "tenant", origin)
			if err != nil {
				t.Fatalf("Resolve returned an error instead of a fallback: %v", err)
			}
			if !snapshot.Degraded || snapshot.Source != SourceFallback || snapshot.FailureMode != mode {
				t.Fatalf("snapshot = %+v", snapshot)
			}
			claim, err := manager.ClaimFor(context.Background(), "tenant", origin, "bot")
			if err != nil {
				t.Fatal(err)
			}
			defer claim.Release()

			if mode == FailOpen && !claim.Allowed("/anything") {
				t.Fatal("fail-open claim should allow")
			}
			if mode == FailClosed && claim.Allowed("/anything") {
				t.Fatal("fail-closed claim should deny")
			}

			events := audit.Events()
			if !hasQ216Audit(events, AuditFetchFailed) || !hasQ216Audit(events, AuditFallback) {
				t.Fatalf("missing failure/fallback audit events: %+v", events)
			}
			if !hasQ216Audit(events, AuditPolicyInstalled) || !hasQ216Audit(events, AuditClaimBound) {
				t.Fatalf("missing install/claim audit events: %+v", events)
			}
		})
	}
}

func TestQ216HTTPStatusPolicyMapping(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		wantAllow bool
		wantDeg   bool
		wantSrc   Source
	}{
		{"not found allows", &FetchError{StatusCode: 404, Err: ErrRobotsNotFound}, true, false, SourceAbsent},
		{"forbidden denies", &FetchError{StatusCode: 403, Err: ErrRobotsAccessDenied}, false, false, SourceAccessDenied},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manager, _ := q216Manager(t, &q216Fetcher{err: test.err}, Config{FailureMode: FailOpen})
			snapshot, err := manager.Resolve(context.Background(), "tenant", q216Origin(t, "https://example.com"))
			if err != nil {
				t.Fatal(err)
			}
			if snapshot.Allowed("*", "/x") != test.wantAllow {
				t.Fatalf("allowed = %v, want %v", snapshot.Allowed("*", "/x"), test.wantAllow)
			}
			if snapshot.Degraded != test.wantDeg || snapshot.Source != test.wantSrc {
				t.Fatalf("snapshot = %+v", snapshot)
			}
		})
	}
}

func TestQ216TTLRefreshCreatesNewVersion(t *testing.T) {
	clock := newQ216Clock()
	fetcher := &q216Fetcher{body: []byte("User-agent: *\nDisallow: /old\n")}
	manager, _ := q216Manager(t, fetcher, Config{TTL: time.Minute, Clock: clock.Now})
	origin := q216Origin(t, "https://example.com")

	first, err := manager.Resolve(context.Background(), "tenant", origin)
	if err != nil {
		t.Fatal(err)
	}
	fetcher.set("User-agent: *\nDisallow: /new\n", nil)
	clock.Advance(2 * time.Minute)
	second, err := manager.Resolve(context.Background(), "tenant", origin)
	if err != nil {
		t.Fatal(err)
	}
	if second.Version <= first.Version || second.Generation != first.Generation+1 {
		t.Fatalf("versions: first=%+v second=%+v", first, second)
	}
	if !second.Allowed("*", "/old") || second.Allowed("*", "/new") {
		t.Fatal("refreshed rules were not installed")
	}
}

func TestQ216ClaimSupersessionCancelsPendingButPreservesEvidence(t *testing.T) {
	fetcher := &q216Fetcher{body: []byte("User-agent: *\nDisallow: /blocked\n")}
	manager, audit := q216Manager(t, fetcher, Config{TTL: time.Hour})
	origin := q216Origin(t, "https://example.com")

	claim, err := manager.Claim(context.Background(), Task{Tenant: "tenant", URL: "https://example.com/article"})
	if err != nil {
		t.Fatal(err)
	}
	defer claim.Release()

	pending, err := claim.Begin(context.Background(), "/article/2")
	if err != nil {
		t.Fatal(err)
	}
	sent, err := claim.Begin(context.Background(), "/article/3")
	if err != nil {
		t.Fatal(err)
	}
	if err := sent.MarkSent(); err != nil {
		t.Fatal(err)
	}

	second, err := manager.InstallPolicy("tenant", origin, DisallowAllRules(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if second.Version <= claim.Version() {
		t.Fatalf("new version %d did not advance claim version %d", second.Version, claim.Version())
	}

	select {
	case <-pending.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("pending permit was not canceled")
	}
	if cause := context.Cause(pending.Context()); !errors.Is(cause, ErrPolicySuperseded) {
		t.Fatalf("pending cause = %v", cause)
	}
	if err := pending.MarkSent(); !errors.Is(err, ErrPolicySuperseded) {
		t.Fatalf("pending MarkSent = %v", err)
	}
	if cause := context.Cause(sent.Context()); cause != nil {
		t.Fatalf("sent permit was canceled: %v", cause)
	}
	if err := sent.MarkSent(); err != nil {
		t.Fatalf("sent MarkSent = %v", err)
	}

	recorded, err := sent.Complete(Evidence{ID: "evidence-1", StatusCode: 200})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if recorded.PolicyVersion != claim.Version() || recorded.PolicyGeneration != claim.Generation() {
		t.Fatalf("evidence version = %d/%d, claim = %d/%d",
			recorded.PolicyVersion, recorded.PolicyGeneration, claim.Version(), claim.Generation())
	}

	if _, err := sent.Complete(Evidence{ID: "evidence-1", StatusCode: 500}); !errors.Is(err, ErrEvidenceExists) {
		t.Fatalf("duplicate evidence error = %v", err)
	}
	stored, ok := manager.EvidenceStore().Get("evidence-1")
	if !ok || stored.StatusCode != 200 {
		t.Fatalf("completed evidence was rewritten: %+v, %v", stored, ok)
	}

	if _, err := claim.Begin(context.Background(), "/article/4"); !errors.Is(err, ErrClaimRevoked) || !errors.Is(err, ErrPolicySuperseded) {
		t.Fatalf("revoked claim Begin = %v", err)
	}

	fresh, err := manager.ClaimFor(context.Background(), "tenant", origin, "bot")
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Release()
	if _, err := fresh.Begin(context.Background(), "/anything"); !errors.Is(err, ErrDisallowed) {
		t.Fatalf("fresh claim Begin = %v", err)
	}

	events := audit.Events()
	for _, kind := range []AuditKind{
		AuditClaimRevoked,
		AuditRequestCanceled,
		AuditEvidenceRecorded,
		AuditEvidenceRejected,
		AuditRequestDenied,
	} {
		if !hasQ216Audit(events, kind) {
			t.Errorf("missing audit kind %s", kind)
		}
	}
}

func TestQ216ReleaseCancelsPendingButNotSent(t *testing.T) {
	fetcher := &q216Fetcher{body: []byte("User-agent: *\nDisallow:\n")}
	manager, _ := q216Manager(t, fetcher, Config{TTL: time.Hour})
	claim, err := manager.ClaimFor(context.Background(), "tenant", q216Origin(t, "https://example.com"), "bot")
	if err != nil {
		t.Fatal(err)
	}
	pending, err := claim.Begin(context.Background(), "/pending")
	if err != nil {
		t.Fatal(err)
	}
	sent, err := claim.Begin(context.Background(), "/sent")
	if err != nil {
		t.Fatal(err)
	}
	if err := sent.MarkSent(); err != nil {
		t.Fatal(err)
	}
	claim.Release()
	if cause := context.Cause(pending.Context()); !errors.Is(cause, ErrClaimReleased) {
		t.Fatalf("pending cause = %v", cause)
	}
	if cause := context.Cause(sent.Context()); cause != nil {
		t.Fatalf("sent permit canceled: %v", cause)
	}
	if _, err := sent.Complete(Evidence{ID: "after-release", StatusCode: 204}); err != nil {
		t.Fatalf("evidence after release: %v", err)
	}
}

func TestQ216ManagerCloseRevokesClaims(t *testing.T) {
	fetcher := &q216Fetcher{body: []byte("User-agent: *\nDisallow:\n")}
	manager, audit := q216Manager(t, fetcher, Config{TTL: time.Hour})
	claim, err := manager.ClaimFor(context.Background(), "tenant", q216Origin(t, "https://example.com"), "bot")
	if err != nil {
		t.Fatal(err)
	}
	permit, err := claim.Begin(context.Background(), "/pending")
	if err != nil {
		t.Fatal(err)
	}
	manager.Close()
	if cause := context.Cause(permit.Context()); !errors.Is(cause, ErrManagerClosed) {
		t.Fatalf("cause = %v", cause)
	}
	if _, err := manager.Resolve(context.Background(), "tenant", q216Origin(t, "https://example.com")); !errors.Is(err, ErrManagerClosed) {
		t.Fatalf("Resolve after close = %v", err)
	}
	if !hasQ216Audit(audit.Events(), AuditManagerClosed) {
		t.Fatal("missing manager close audit")
	}
}

func TestQ216ConcurrentResolvesUseSingleFlight(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var calls int32
	fetcher := FetchFunc(func(context.Context, Origin, string) ([]byte, error) {
		if atomic.AddInt32(&calls, 1) == 1 {
			close(started)
		}
		<-release
		return []byte("User-agent: *\nDisallow:\n"), nil
	})
	manager, _ := q216Manager(t, fetcher, Config{TTL: time.Hour})
	origin := q216Origin(t, "https://example.com")

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := manager.Resolve(context.Background(), "tenant", origin); err != nil {
				t.Errorf("Resolve: %v", err)
			}
		}()
	}
	<-started
	close(release)
	wg.Wait()
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("fetch calls = %d, want 1", got)
	}
}

func TestQ216LateFetchCannotOverwriteNewerGeneration(t *testing.T) {
	clock := newQ216Clock()
	cache := NewCache(WithCacheClock(clock.Now))
	started := make(chan struct{})
	release := make(chan struct{})
	slowFetcher := FetchFunc(func(context.Context, Origin, string) ([]byte, error) {
		close(started)
		<-release
		return []byte("User-agent: *\nDisallow: /stale\n"), nil
	})
	fastFetcher := &q216Fetcher{body: []byte("User-agent: *\nDisallow: /new\n")}

	slowManager, slowAudit := q216Manager(t, slowFetcher, Config{Cache: cache, TTL: time.Hour, Clock: clock.Now})
	fastManager, _ := q216Manager(t, fastFetcher, Config{Cache: cache, TTL: time.Hour, Clock: clock.Now})
	origin := q216Origin(t, "https://example.com")

	type result struct {
		snapshot Snapshot
		err      error
	}
	resultChannel := make(chan result, 1)
	go func() {
		snapshot, err := slowManager.Resolve(context.Background(), "tenant", origin)
		resultChannel <- result{snapshot: snapshot, err: err}
	}()
	<-started

	newer, err := fastManager.Resolve(context.Background(), "tenant", origin)
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	late := <-resultChannel
	if late.err != nil {
		t.Fatalf("late Resolve: %v", late.err)
	}
	if late.snapshot.Version != newer.Version {
		t.Fatalf("late version = %d, newer = %d", late.snapshot.Version, newer.Version)
	}
	if late.snapshot.Allowed("*", "/new") || !late.snapshot.Allowed("*", "/stale") {
		t.Fatal("the late fetch overwrote the newer policy")
	}
	if !hasQ216Audit(slowAudit.Events(), AuditPolicyStale) {
		t.Fatal("stale generation was not audited")
	}
}

func TestQ216EvidenceStoreIsAppendOnlyAndDefensive(t *testing.T) {
	store := NewMemoryEvidenceStore()
	original := Evidence{
		ID:       "e",
		Body:     []byte("original"),
		Headers:  map[string][]string{"X-Test": {"one"}},
		Metadata: map[string]string{"k": "v"},
	}
	if err := store.Append(original); err != nil {
		t.Fatal(err)
	}
	original.Body[0] = 'X'
	original.Headers.Set("X-Test", "two")
	original.Metadata["k"] = "changed"

	stored, ok := store.Get("e")
	if !ok || string(stored.Body) != "original" || stored.Headers.Get("X-Test") != "one" || stored.Metadata["k"] != "v" {
		t.Fatalf("store did not retain a defensive copy: %+v", stored)
	}
	stored.Body[0] = 'Y'
	again, _ := store.Get("e")
	if string(again.Body) != "original" {
		t.Fatal("Get exposed mutable storage")
	}
	if err := store.Append(Evidence{ID: "e"}); !errors.Is(err, ErrEvidenceExists) {
		t.Fatalf("duplicate append = %v", err)
	}
}
