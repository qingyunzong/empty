package tokenbucket

import (
	"os"
	"path/filepath"
	"testing"
)

func open(t *testing.T, path string, cfg Config) *Limiter {
	t.Helper()
	l, err := Open(path, cfg)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return l
}

func mustAllow(t *testing.T, l *Limiter, id string, cost, now int64) bool {
	t.Helper()
	d, err := l.Allow(id, cost, now)
	if err != nil {
		t.Fatalf("Allow(%q): %v", id, err)
	}
	return d
}

func testConfig() Config {
	return Config{Capacity: 10, RateNum: 1, RateDen: 2, Window: 4}
}

func TestRemainderAccumulation(t *testing.T) {
	l := open(t, filepath.Join(t.TempDir(), "log"), testConfig())
	defer l.Close()
	// Rate 1/2 token per tick: one token every two ticks, none lost.
	l.b.tokens = 0
	l.b.refill(0) // establish the logical epoch
	for now := int64(1); now <= 4; now++ {
		l.b.refill(now)
	}
	if l.b.tokens != 2 || l.b.rem != 0 {
		t.Fatalf("after 4 ticks got tokens=%d rem=%d, want 2,0", l.b.tokens, l.b.rem)
	}
	l.b.refill(5)
	if l.b.tokens != 2 || l.b.rem != 1 {
		t.Fatalf("after 5 ticks got tokens=%d rem=%d, want 2,1", l.b.tokens, l.b.rem)
	}
}

func TestBackwardsTimeAddsNothing(t *testing.T) {
	l := open(t, filepath.Join(t.TempDir(), "log"), testConfig())
	defer l.Close()
	l.b.tokens = 0
	l.b.refill(0) // establish the logical epoch
	l.b.refill(10)
	if l.b.tokens != 5 {
		t.Fatalf("tokens=%d, want 5", l.b.tokens)
	}
	l.b.refill(3) // rewind: no accrual, clock must not move back
	if l.b.tokens != 5 || l.b.last != 10 {
		t.Fatalf("after rewind tokens=%d last=%d, want 5,10", l.b.tokens, l.b.last)
	}
	l.b.refill(10) // same instant: still nothing
	if l.b.tokens != 5 {
		t.Fatalf("after same-time refill tokens=%d, want 5", l.b.tokens)
	}
	l.b.refill(12) // forward again accrues from 10, not from 3
	if l.b.tokens != 6 {
		t.Fatalf("tokens=%d, want 6", l.b.tokens)
	}
}

func TestDuplicateIDReturnsOriginalDecision(t *testing.T) {
	l := open(t, filepath.Join(t.TempDir(), "log"), testConfig())
	defer l.Close()
	if !mustAllow(t, l, "r1", 4, 0) {
		t.Fatal("first r1 denied, want allowed")
	}
	tokens, _, _ := l.State()
	if tokens != 6 {
		t.Fatalf("tokens=%d, want 6", tokens)
	}
	// Duplicate at a later time: same decision, no second charge, no refill effect on the decision.
	if !mustAllow(t, l, "r1", 4, 100) {
		t.Fatal("duplicate r1 denied, want original decision")
	}
	tokens, _, _ = l.State()
	if tokens != 6 { // duplicate performs no refill and no charge
		t.Fatalf("tokens=%d after duplicate, want 6", tokens)
	}
	// Denials are also sticky.
	if mustAllow(t, l, "r2", 100, 0) {
		t.Fatal("r2 allowed, want denied (cost > capacity)")
	}
	if mustAllow(t, l, "r2", 100, 1000) {
		t.Fatal("duplicate r2 allowed, want original denial")
	}
}

func TestRestartDoesNotRecharge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	l := open(t, path, testConfig())
	if !mustAllow(t, l, "r1", 4, 0) {
		t.Fatal("first r1 denied")
	}
	if !mustAllow(t, l, "r2", 3, 1) {
		t.Fatal("first r2 denied")
	}
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	l2 := open(t, path, testConfig())
	defer l2.Close()
	tokens, rem, last := l2.State()
	if tokens != 3 || rem != 1 || last != 1 {
		t.Fatalf("restored state tokens=%d rem=%d last=%d, want 3,1,1", tokens, rem, last)
	}
	if !mustAllow(t, l2, "r1", 4, 50) {
		t.Fatal("r1 after restart: want original decision")
	}
	if !mustAllow(t, l2, "r2", 3, 50) {
		t.Fatal("r2 after restart: want original decision")
	}
	tokens, _, _ = l2.State()
	if tokens != 3 {
		t.Fatalf("tokens=%d after replayed IDs, want 3 (no double charge)", tokens)
	}
}

func TestTruncatePreservesIdempotencyWindow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	cfg := testConfig() // Window = 4
	l := open(t, path, cfg)
	// 6 distinct requests; window keeps only the last 4 (r3..r6).
	for i, id := range []string{"r1", "r2", "r3", "r4", "r5", "r6"} {
		mustAllow(t, l, id, 1, int64(i))
	}
	if err := l.Truncate(); err != nil {
		t.Fatalf("Truncate: %v", err)
	}
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// Snapshot (1 line) + 4 window entries = 5 lines, far smaller than 6 decision records would grow to.
	if fi.Size() > 200 {
		t.Fatalf("truncated log is %d bytes, want compact", fi.Size())
	}

	l2 := open(t, path, cfg)
	defer l2.Close()
	before, _, _ := l2.State()
	// Window IDs survive truncation + restart and are not re-charged.
	for _, id := range []string{"r3", "r4", "r5", "r6"} {
		mustAllow(t, l2, id, 1, 100)
	}
	after, _, _ := l2.State()
	if before != after {
		t.Fatalf("window IDs re-charged after truncate: tokens %d -> %d", before, after)
	}
	// r1 fell out of the window: it is re-evaluated (and charged) as a new request.
	mustAllow(t, l2, "probe", 0, 100) // force refill up to t=100
	tokensBefore, _, _ := l2.State()
	mustAllow(t, l2, "r1", 1, 100)
	tokensAfter, _, _ := l2.State()
	if tokensAfter != tokensBefore-1 {
		t.Fatalf("evicted id not re-charged: tokens %d -> %d", tokensBefore, tokensAfter)
	}
}

func TestConfigValidation(t *testing.T) {
	dir := t.TempDir()
	bad := []Config{
		{Capacity: -1, RateNum: 1, RateDen: 1, Window: 1},
		{Capacity: 1, RateNum: 1, RateDen: 0, Window: 1},
		{Capacity: 1, RateNum: 1, RateDen: 1, Window: 0},
	}
	for i, cfg := range bad {
		if _, err := Open(filepath.Join(dir, "log"), cfg); err == nil {
			t.Fatalf("config %d: want error", i)
		}
	}
}
