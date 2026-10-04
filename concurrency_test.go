package logcompact

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"testing"
)

// TestBarrierInterleavedPublishRenewTruncate forces snapshot publish,
// lease renewal and truncation to start at the same barrier, then
// checks the reclamation invariants against the full-retention model
// after each round, regardless of the actual interleaving.
func TestBarrierInterleavedPublishRenewTruncate(t *testing.T) {
	l := New()
	var m model
	put := putter(l, &m, 11)

	for i := 0; i < 40; i++ {
		put(i)
	}
	leaseTok := l.AcquireLease("reader") // pins 40
	for i := 40; i < 80; i++ {
		put(i)
	}

	// Round 1: publish + renew + truncate released from one barrier.
	var snapTok, renewedTok Token
	var renewErr error
	start := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		<-start
		snapTok = l.PublishSnapshot("snap")
	}()
	go func() {
		defer wg.Done()
		<-start
		renewedTok, renewErr = l.Renew(leaseTok)
	}()
	go func() {
		defer wg.Done()
		<-start
		l.Truncate()
	}()
	close(start)
	wg.Wait()

	if renewErr != nil {
		t.Fatalf("Renew: %v", renewErr)
	}
	pins := l.Pins()
	if len(pins) != 2 {
		t.Fatalf("Pins = %+v, want 2", pins)
	}
	if got, want := l.Horizon(), min(pins[0].Ver, pins[1].Ver); got != want {
		t.Fatalf("Horizon = %d, want %d", got, want)
	}
	assertPinReads(t, l, &m)
	assertStateAt(t, l, &m, 80)

	// Round 2: a stale release (pre-renew token) racing a truncation
	// must not disturb the renewed lease.
	for i := 80; i < 120; i++ {
		put(i)
	}
	var staleErr error
	start2 := make(chan struct{})
	var wg2 sync.WaitGroup
	wg2.Add(2)
	go func() {
		defer wg2.Done()
		<-start2
		staleErr = l.Release(leaseTok) // stale: lease was renewed in round 1
	}()
	go func() {
		defer wg2.Done()
		<-start2
		l.Truncate()
	}()
	close(start2)
	wg2.Wait()

	if !errors.Is(staleErr, ErrStaleToken) {
		t.Fatalf("Release(stale) = %v, want ErrStaleToken", staleErr)
	}
	ver, ok := l.PinVersion(renewedTok)
	if !ok {
		t.Fatalf("renewed lease %v is gone after stale release", renewedTok)
	}
	if got, want := l.Horizon(), min(ver, mustVer(t, l, snapTok)); got != want {
		t.Fatalf("Horizon = %d, want %d", got, want)
	}
	assertPinReads(t, l, &m)

	// Draining all pins lets reclamation keep only the latest per key.
	if err := l.Release(snapTok); err != nil {
		t.Fatalf("Release(snap): %v", err)
	}
	if err := l.Release(renewedTok); err != nil {
		t.Fatalf("Release(renewed): %v", err)
	}
	l.Truncate()
	if got, want := l.Len(), 11; got != want {
		t.Fatalf("Len = %d, want %d", got, want)
	}
	assertStateAt(t, l, &m, 120)
}

func mustVer(t *testing.T, l *Log, tok Token) uint64 {
	t.Helper()
	ver, ok := l.PinVersion(tok)
	if !ok {
		t.Fatalf("token %v no longer valid", tok)
	}
	return ver
}

// TestConcurrentStressMatchesFullRetention runs one deterministic
// appender against concurrent lease acquire/renew/release, snapshot
// publishing and truncation, then compares every surviving pin against
// the full-retention model.
func TestConcurrentStressMatchesFullRetention(t *testing.T) {
	l := New()
	var m model
	const total = 2000

	start := make(chan struct{})
	done := make(chan struct{})
	var wg sync.WaitGroup

	// Single appender: keeps the model's sequence deterministic.
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		for i := 0; i < total; i++ {
			key := fmt.Sprintf("key-%d", i%23)
			val := fmt.Sprintf("val-%d", i)
			seq := l.Append(key, val)
			m.append(Entry{Seq: seq, Key: key, Value: val})
		}
		close(done)
	}()

	// Active readers: acquire, read at the pinned version, then renew
	// or release. A read at a pinned version must never fail.
	for r := 0; r < 3; r++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			<-start
			name := fmt.Sprintf("reader-%d", id)
			for {
				select {
				case <-done:
					return
				default:
				}
				tok := l.AcquireLease(name)
				ver, ok := l.PinVersion(tok)
				if !ok {
					continue
				}
				if _, err := l.ScanFrom(ver); err != nil {
					t.Errorf("lease %v: ScanFrom(%d): %v", tok, ver, err)
					return
				}
				if _, err := l.StateAt(ver); err != nil {
					t.Errorf("lease %v: StateAt(%d): %v", tok, ver, err)
					return
				}
				if id%2 == 0 {
					_, _ = l.Renew(tok) // keep pinned at a newer version
				} else {
					_ = l.Release(tok)
				}
			}
		}(r)
	}

	// Snapshot publisher: keeps replacing one persistent snapshot.
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		for {
			select {
			case <-done:
				return
			default:
			}
			tok := l.PublishSnapshot("latest")
			if ver, ok := l.PinVersion(tok); ok {
				if _, err := l.StateAt(ver); err != nil {
					t.Errorf("snapshot %v: StateAt(%d): %v", tok, ver, err)
					return
				}
			}
		}
	}()

	// Reclaimer: truncates as aggressively as it can.
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		for {
			select {
			case <-done:
				return
			default:
			}
			l.Truncate()
			runtime.Gosched()
		}
	}()

	close(start)
	wg.Wait()

	// Every surviving pin must read exactly like the full-retention
	// model, and the head state must be intact.
	assertPinReads(t, l, &m)
	assertStateAt(t, l, &m, total)
}
