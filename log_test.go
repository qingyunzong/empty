package logcompact

import (
	"errors"
	"fmt"
	"testing"
)

// putter appends to both the compacted log and the full-retention
// model with deterministic keys/values.
func putter(l *Log, m *model, keyMod int) func(i int) {
	return func(i int) {
		key := fmt.Sprintf("key-%d", i%keyMod)
		val := fmt.Sprintf("val-%d", i)
		seq := l.Append(key, val)
		m.append(Entry{Seq: seq, Key: key, Value: val})
	}
}

func TestTruncateRespectsLeaseAndSnapshot(t *testing.T) {
	l := New()
	var m model
	put := putter(l, &m, 10)

	for i := 0; i < 30; i++ {
		put(i)
	}
	leaseTok := l.AcquireLease("reader") // pins version 30
	for i := 30; i < 60; i++ {
		put(i)
	}
	snapTok := l.PublishSnapshot("snap") // pins version 60
	for i := 60; i < 90; i++ {
		put(i)
	}

	if got, want := l.Horizon(), uint64(30); got != want {
		t.Fatalf("Horizon = %d, want %d", got, want)
	}
	// Entries 1..29 compact to the latest per key: 10 kept, 19 dropped.
	if dropped := l.Truncate(); dropped != 19 {
		t.Fatalf("Truncate dropped %d, want 19", dropped)
	}
	if got, want := l.Len(), 71; got != want {
		t.Fatalf("Len = %d, want %d", got, want)
	}
	assertPinReads(t, l, &m)
	assertStateAt(t, l, &m, 90)

	// Releasing the lease moves the horizon up to the snapshot.
	if err := l.Release(leaseTok); err != nil {
		t.Fatalf("Release lease: %v", err)
	}
	if got, want := l.Horizon(), uint64(60); got != want {
		t.Fatalf("Horizon = %d, want %d", got, want)
	}
	if dropped := l.Truncate(); dropped != 30 {
		t.Fatalf("Truncate dropped %d, want 30", dropped)
	}
	assertPinReads(t, l, &m)
	assertStateAt(t, l, &m, 90)

	// Releasing the snapshot frees everything below head+1.
	if err := l.Release(snapTok); err != nil {
		t.Fatalf("Release snapshot: %v", err)
	}
	if dropped := l.Truncate(); dropped != 31 {
		t.Fatalf("Truncate dropped %d, want 31", dropped)
	}
	if got, want := l.Len(), 10; got != want {
		t.Fatalf("Len = %d, want %d", got, want)
	}
	assertStateAt(t, l, &m, 90)

	if _, err := l.ScanFrom(1); !errors.Is(err, ErrCompacted) {
		t.Fatalf("ScanFrom(1) err = %v, want ErrCompacted", err)
	}
	if _, err := l.StateAt(5); !errors.Is(err, ErrCompacted) {
		t.Fatalf("StateAt(5) err = %v, want ErrCompacted", err)
	}
}

func TestReleaseStaleTokenKeepsNewLease(t *testing.T) {
	l := New()
	var m model
	put := putter(l, &m, 4)

	for i := 0; i < 10; i++ {
		put(i)
	}
	old := l.AcquireLease("reader") // pins version 10
	for i := 10; i < 20; i++ {
		put(i)
	}
	cur := l.AcquireLease("reader") // same name, new generation, pins 20

	// Releasing the old generation must not release the new lease.
	if err := l.Release(old); !errors.Is(err, ErrStaleToken) {
		t.Fatalf("Release(old) = %v, want ErrStaleToken", err)
	}
	pins := l.Pins()
	if len(pins) != 1 || pins[0].Ver != 20 {
		t.Fatalf("Pins = %+v, want one lease pinned at 20", pins)
	}
	if got, want := l.Horizon(), uint64(20); got != want {
		t.Fatalf("Horizon = %d, want %d", got, want)
	}
	l.Truncate()
	assertPinReads(t, l, &m)

	// The current generation releases normally.
	if err := l.Release(cur); err != nil {
		t.Fatalf("Release(cur): %v", err)
	}
	if got, want := l.Horizon(), uint64(21); got != want {
		t.Fatalf("Horizon = %d, want %d", got, want)
	}
}

func TestReleaseStaleTokenKeepsNewSnapshot(t *testing.T) {
	l := New()
	var m model
	put := putter(l, &m, 4)

	for i := 0; i < 10; i++ {
		put(i)
	}
	old := l.PublishSnapshot("daily") // pins 10
	for i := 10; i < 20; i++ {
		put(i)
	}
	l.PublishSnapshot("daily") // replaces, pins 20

	if err := l.Release(old); !errors.Is(err, ErrStaleToken) {
		t.Fatalf("Release(old) = %v, want ErrStaleToken", err)
	}
	if got, want := l.Horizon(), uint64(20); got != want {
		t.Fatalf("Horizon = %d, want %d", got, want)
	}
	l.Truncate()
	assertPinReads(t, l, &m)
}

func TestRenewAdvancesLeaseAndInvalidatesOldToken(t *testing.T) {
	l := New()
	var m model
	put := putter(l, &m, 4)

	for i := 0; i < 10; i++ {
		put(i)
	}
	tok := l.AcquireLease("reader") // pins 10
	for i := 10; i < 20; i++ {
		put(i)
	}

	renewed, err := l.Renew(tok)
	if err != nil {
		t.Fatalf("Renew: %v", err)
	}
	if renewed == tok {
		t.Fatalf("Renew returned the same token %v", renewed)
	}
	if got, want := l.Horizon(), uint64(20); got != want {
		t.Fatalf("Horizon = %d, want %d", got, want)
	}

	// The pre-renew token is now stale for both renew and release.
	if _, err := l.Renew(tok); !errors.Is(err, ErrStaleToken) {
		t.Fatalf("Renew(stale) = %v, want ErrStaleToken", err)
	}
	if err := l.Release(tok); !errors.Is(err, ErrStaleToken) {
		t.Fatalf("Release(stale) = %v, want ErrStaleToken", err)
	}

	l.Truncate()
	assertPinReads(t, l, &m)

	if err := l.Release(renewed); err != nil {
		t.Fatalf("Release(renewed): %v", err)
	}
	if n := len(l.Pins()); n != 0 {
		t.Fatalf("Pins = %d, want 0", n)
	}
}

func TestRenewUnknownToken(t *testing.T) {
	l := New()
	if _, err := l.Renew(Token{name: "ghost", gen: 1, kind: Lease}); !errors.Is(err, ErrStaleToken) {
		t.Fatalf("Renew(unknown) = %v, want ErrStaleToken", err)
	}
}

func TestTruncateWithoutPinsKeepsLatestPerKey(t *testing.T) {
	l := New()
	var m model
	put := putter(l, &m, 7)

	for i := 0; i < 100; i++ {
		put(i)
	}
	if dropped := l.Truncate(); dropped != 93 {
		t.Fatalf("Truncate dropped %d, want 93", dropped)
	}
	if got, want := l.Len(), 7; got != want {
		t.Fatalf("Len = %d, want %d", got, want)
	}
	assertStateAt(t, l, &m, 100)
}
