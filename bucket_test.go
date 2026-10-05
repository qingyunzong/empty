package tokenbucket

import "testing"

func mustBucket(t *testing.T, cfg Config) *Bucket {
	t.Helper()
	b, err := NewBucket(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func allow(t *testing.T, b *Bucket, now, cost int64) bool {
	t.Helper()
	ok, err := b.Allow(now, cost)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func TestRemainderAccumulatesExactly(t *testing.T) {
	// Rate 1/2 token per tick: a token materializes every second tick.
	b := mustBucket(t, Config{Capacity: 10, RateNum: 1, RateDen: 2})
	// Drain the initial 10 tokens.
	if !allow(t, b, 0, 10) {
		t.Fatal("expected initial capacity to be spendable")
	}
	want := []struct {
		now    int64
		tokens int64
		rem    int64
	}{
		{1, 0, 1},
		{2, 1, 0},
		{3, 1, 1},
		{4, 2, 0},
		{5, 2, 1},
	}
	for _, w := range want {
		allow(t, b, w.now, 0)
		tokens, rem, _ := b.State()
		if tokens != w.tokens || rem != w.rem {
			t.Fatalf("t=%d: got (%d, %d), want (%d, %d)", w.now, tokens, rem, w.tokens, w.rem)
		}
	}
}

func TestBackwardClockNeverRefills(t *testing.T) {
	b := mustBucket(t, Config{Capacity: 5, RateNum: 1, RateDen: 1})
	allow(t, b, 100, 5) // empty at t=100
	if allow(t, b, 0, 1) {
		t.Fatal("backwards clock must not refill")
	}
	if allow(t, b, 50, 1) {
		t.Fatal("backwards clock must not refill")
	}
	_, _, last := b.State()
	if last != 100 {
		t.Fatalf("lastTime regressed to %d", last)
	}
	// Forward again: only elapsed beyond 100 counts.
	if !allow(t, b, 101, 1) {
		t.Fatal("expected 1 token at t=101")
	}
}

func TestCapDiscardsFraction(t *testing.T) {
	// Refill overshoots capacity: fraction is discarded, matching the
	// rational model clamped to an integer capacity.
	b := mustBucket(t, Config{Capacity: 1, RateNum: 3, RateDen: 2})
	allow(t, b, 0, 1) // empty
	allow(t, b, 10, 0)
	tokens, rem, _ := b.State()
	if tokens != 1 || rem != 0 {
		t.Fatalf("got (%d, %d), want (1, 0)", tokens, rem)
	}
}

func TestHugeTimeJumpSaturates(t *testing.T) {
	b := mustBucket(t, Config{Capacity: 3, RateNum: 1 << 40, RateDen: 1})
	allow(t, b, 0, 3)
	if !allow(t, b, 1<<62, 3) {
		t.Fatal("expected saturation to capacity")
	}
}

func TestNegativeCostRejected(t *testing.T) {
	b := mustBucket(t, Config{Capacity: 1, RateNum: 1, RateDen: 1})
	if _, err := b.Allow(0, -1); err == nil {
		t.Fatal("expected error for negative cost")
	}
}

func TestInvalidConfig(t *testing.T) {
	for _, cfg := range []Config{
		{Capacity: -1, RateNum: 1, RateDen: 1},
		{Capacity: 1, RateNum: -1, RateDen: 1},
		{Capacity: 1, RateNum: 1, RateDen: 0},
	} {
		if _, err := NewBucket(cfg); err == nil {
			t.Fatalf("expected error for %+v", cfg)
		}
	}
}
