package robots

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestQ216FailureModeText(t *testing.T) {
	tests := map[string]FailureMode{
		"fail-open":   FailOpen,
		"FAIL-OPEN":   FailOpen,
		"open":        FailOpen,
		"fail-closed": FailClosed,
		"closed":      FailClosed,
	}
	for value, want := range tests {
		got, err := ParseFailureMode(value)
		if err != nil || got != want {
			t.Fatalf("ParseFailureMode(%q) = %v, %v", value, got, err)
		}
	}
	if _, err := ParseFailureMode("sometimes"); err == nil {
		t.Fatal("invalid failure mode was accepted")
	}
	if FailOpen.String() != "fail-open" || FailClosed.String() != "fail-closed" {
		t.Fatal("unexpected failure mode strings")
	}

	text, err := FailOpen.MarshalText()
	if err != nil || string(text) != "fail-open" {
		t.Fatalf("MarshalText = %q, %v", text, err)
	}
	var mode FailureMode
	if err := mode.UnmarshalText([]byte("fail-open")); err != nil || mode != FailOpen {
		t.Fatalf("UnmarshalText = %v, %v", mode, err)
	}
}

func TestQ216SnapshotConvenience(t *testing.T) {
	var snapshot Snapshot
	if !snapshot.Fresh(time.Now()) || snapshot.Expired(time.Now()) {
		t.Fatal("zero ExpiresAt should mean no expiry")
	}
	if !snapshot.Allowed("bot", "/anything") {
		t.Fatal("nil rules should allow")
	}
	if snapshot.CrawlDelay("bot") != 0 {
		t.Fatal("nil rules should have zero delay")
	}

	snapshot = Snapshot{
		Rules:     q216Rules(t, "User-agent: *\nDisallow: /x\nCrawl-delay: 1\n"),
		ExpiresAt: time.Now().Add(-time.Second),
	}
	if !snapshot.Expired(time.Now()) {
		t.Fatal("snapshot should be expired")
	}
	clone := snapshot.Clone()
	clone.Rules.Groups[0].Rules[0].Pattern = "/y"
	if snapshot.Allowed("bot", "/x") {
		t.Fatal("Clone did not deep-copy rules")
	}
}

func TestQ216RequestPathNormalisation(t *testing.T) {
	tests := map[string]string{
		"":                                 "/",
		"article":                          "/article",
		"/article?q=1#fragment":            "/article?q=1",
		"https://example.com/a/b?q=1#frag": "/a/b?q=1",
		"https://example.com":              "/",
		"#fragment":                        "/",
	}
	for input, want := range tests {
		if got := RequestPath(input); got != want {
			t.Errorf("RequestPath(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestQ216CacheAliasesAndAuditLog(t *testing.T) {
	scope := NewScope("tenant", q216Origin(t, "https://example.com"))
	cache := NewCache(WithCacheCapacity(2))
	if first, ok := cache.InstallIfVersion(scope, 0, DisallowAllRules(), time.Minute); !ok || first.Generation != 1 {
		t.Fatalf("InstallIfVersion = %+v, %v", first, ok)
	}
	if _, ok := cache.StoreIfVersion(scope, 0, Snapshot{Rules: AllowAllRules()}, time.Minute); ok {
		t.Fatal("StoreIfVersion accepted a stale version")
	}
	if snapshot, ok := cache.Load(scope); !ok || snapshot.Allowed("bot", "/x") {
		t.Fatalf("Load = %+v, %v", snapshot, ok)
	}
	if cache.Len() != 1 || len(cache.Scopes()) != 1 {
		t.Fatal("cache bookkeeping is wrong")
	}
	cache.Delete(scope)
	if _, ok := cache.Lookup(scope); ok {
		t.Fatal("Delete did not remove the entry")
	}

	manual := Scope{Tenant: "tenant", Origin: Origin{Scheme: "HTTPS", Host: "Example.COM.", Port: "443"}}
	cache.Install(manual, AllowAllRules(), time.Minute)
	if _, ok := cache.Get(scope); !ok {
		t.Fatal("cache did not canonicalise a manually constructed origin")
	}

	log := NewAuditLog(2)
	for i := 0; i < 3; i++ {
		log.Record(AuditEvent{Kind: AuditPolicyInstalled})
	}
	if log.Len() != 2 || len(log.Events()) != 2 {
		t.Fatalf("audit cap = %d events=%d", log.Len(), len(log.Events()))
	}
	AuditFunc(nil).Record(AuditEvent{})

	fetchErr := &FetchError{StatusCode: 503, Err: ErrRobotsUnavailable}
	if fetchErr.Error() == "" || !errors.Is(fetchErr, ErrRobotsUnavailable) {
		t.Fatalf("FetchError = %v", fetchErr)
	}
}

func TestQ216ClaimCanceledContextAndRevoked(t *testing.T) {
	manager, _ := q216Manager(t, &q216Fetcher{body: []byte("User-agent: *\nDisallow:\n")}, Config{TTL: time.Hour})
	claim, err := manager.ClaimFor(context.Background(), "tenant", q216Origin(t, "https://example.com"), "bot")
	if err != nil {
		t.Fatal(err)
	}
	if err := claim.Revoked(); err != nil {
		t.Fatalf("fresh claim revoked: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := claim.Begin(ctx, "/x"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Begin with canceled context = %v", err)
	}
	claim.Release()
	if !errors.Is(claim.Revoked(), ErrClaimReleased) {
		t.Fatalf("Revoked after release = %v", claim.Revoked())
	}
	if _, err := claim.Begin(context.Background(), "/x"); !errors.Is(err, ErrClaimRevoked) {
		t.Fatalf("Begin after release = %v", err)
	}
}

func TestQ216MarkSentRejectsNewerPolicyVersion(t *testing.T) {
	manager, audit := q216Manager(t, &q216Fetcher{body: []byte("User-agent: *\nDisallow:\n")}, Config{TTL: time.Hour})
	origin := q216Origin(t, "https://example.com")
	claim, err := manager.ClaimFor(context.Background(), "tenant", origin, "bot")
	if err != nil {
		t.Fatal(err)
	}
	defer claim.Release()

	permit, err := claim.Begin(context.Background(), "/x")
	if err != nil {
		t.Fatal(err)
	}
	// Even a cache write that bypasses Manager's audit path must stop a
	// pending request from being marked sent.
	manager.Cache().Install(NewScope("tenant", origin), DisallowAllRules(), time.Hour)
	if err := permit.MarkSent(); !errors.Is(err, ErrPolicySuperseded) {
		t.Fatalf("MarkSent after newer version = %v", err)
	}
	if cause := context.Cause(permit.Context()); !errors.Is(cause, ErrPolicySuperseded) {
		t.Fatalf("permit cause = %v", cause)
	}
	if _, err := claim.Begin(context.Background(), "/y"); !errors.Is(err, ErrClaimRevoked) {
		t.Fatalf("Begin after cache-only supersession = %v", err)
	}
	if !hasQ216Audit(audit.Events(), AuditRequestCanceled) {
		t.Fatal("MarkSent cancellation was not audited")
	}
}
