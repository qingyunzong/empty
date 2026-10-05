package readroute

import (
	"context"
	"errors"
	"testing"
	"time"
)

type readOutcome struct {
	res Result
	err error
}

// pendingRead is a background Router.Read; done is closed when it finishes
// and ch then holds exactly one outcome.
type pendingRead struct {
	ch   chan readOutcome
	done chan struct{}
}

func runRead(r *Router, req Request) *pendingRead {
	p := &pendingRead{ch: make(chan readOutcome, 1), done: make(chan struct{})}
	go func() {
		res, err := r.Read(context.Background(), req)
		p.ch <- readOutcome{res, err}
		close(p.done)
	}()
	return p
}

func (p *pendingRead) finished() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

// advanceUntil steps the virtual clock until cond reports true or a real-time
// guard expires, simulating the passage of time without long real sleeps.
func advanceUntil(c *VirtualClock, step time.Duration, cond func() bool) {
	deadline := time.Now().Add(5 * time.Second)
	for !cond() && time.Now().Before(deadline) {
		c.Advance(step)
		time.Sleep(time.Millisecond)
	}
}

func await(t *testing.T, p *pendingRead) readOutcome {
	t.Helper()
	select {
	case out := <-p.ch:
		return out
	case <-time.After(5 * time.Second):
		t.Fatal("read did not complete")
		return readOutcome{}
	}
}

func newTestRouter(c Clock) *Router {
	return NewRouter(
		WithClock(c),
		WithTimeout(2*time.Second),
		WithPollInterval(100*time.Millisecond),
	)
}

// A read naming a confirmed sequence must be served by a replica whose
// applied sequence is at least that high, and the returned version must
// provably satisfy the request.
func TestReadServedOnlyByFreshReplica(t *testing.T) {
	r := newTestRouter(RealClock{})
	stale := NewMemReplica("stale")
	stale.Apply(3, "k", []byte("old"))
	fresh := NewMemReplica("fresh")
	fresh.Apply(10, "k", []byte("new"))
	r.Register(stale)
	r.Register(fresh)

	res, err := r.Read(context.Background(), Request{Key: "k", MinSeq: 7})
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}
	if res.ReplicaID != "fresh" {
		t.Fatalf("read served by %q, want the fresh replica", res.ReplicaID)
	}
	if res.Seq < 7 {
		t.Fatalf("returned version %d is below the requested confirmed seq 7", res.Seq)
	}
	if res.Stale {
		t.Fatal("fresh read must not be marked stale")
	}
	if string(res.Value) != "new" {
		t.Fatalf("got value %q, want %q", res.Value, "new")
	}
}

// The virtual clock drives time forward while a replica catches up; once its
// applied sequence reaches the confirmed one, the pending read succeeds with
// a verifiable version.
func TestReadWaitsForReplicaCatchUp(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1000, 0))
	r := newTestRouter(clock)
	rep := NewMemReplica("r1")
	rep.Apply(3, "k", []byte("old"))
	rep.SetOnChange(r.NotifyUpdate)
	r.Register(rep)

	p := runRead(r, Request{Key: "k", MinSeq: 7})

	// Let some virtual time pass: the read must still be waiting.
	advanceUntil(clock, 100*time.Millisecond, func() bool {
		return clock.Now().After(time.Unix(1000, 0).Add(500 * time.Millisecond))
	})
	if p.finished() {
		o := await(t, p)
		t.Fatalf("read completed before catch-up: %+v err=%v", o.res, o.err)
	}

	// The replica catches up to seq 7; the read must now succeed.
	rep.Apply(7, "k", []byte("caught-up"))
	o := await(t, p)
	if o.err != nil {
		t.Fatalf("read failed after catch-up: %v", o.err)
	}
	if o.res.Seq != 7 || string(o.res.Value) != "caught-up" {
		t.Fatalf("got version %d value %q, want version 7 %q", o.res.Seq, o.res.Value, "caught-up")
	}
	if o.res.Stale {
		t.Fatal("read satisfied at the confirmed seq must not be stale")
	}
	if !clock.Now().Before(time.Unix(1000, 0).Add(2 * time.Second)) {
		t.Fatal("read should have completed before the timeout")
	}
}

// When no replica ever reaches the confirmed sequence, the read times out
// with ErrTimeout and a zero result — it must not fake a success.
func TestTimeoutNeverFakesSuccess(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1000, 0))
	r := newTestRouter(clock)
	rep := NewMemReplica("r1")
	rep.Apply(3, "k", []byte("old"))
	r.Register(rep)

	p := runRead(r, Request{Key: "k", MinSeq: 7})
	advanceUntil(clock, 100*time.Millisecond, p.finished)

	o := await(t, p)
	if !errors.Is(o.err, ErrTimeout) {
		t.Fatalf("got err %v, want ErrTimeout", o.err)
	}
	if o.res.Value != nil || o.res.Seq != 0 || o.res.ReplicaID != "" || o.res.Stale {
		t.Fatalf("timed-out read returned a value: %+v", o.res)
	}
}

// A stale read happens only with the explicit AllowStale flag, and the
// returned version is the replica's actual, verifiable version.
func TestStaleReadRequiresExplicitFlag(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1000, 0))
	r := newTestRouter(clock)
	rep := NewMemReplica("r1")
	rep.Apply(3, "k", []byte("old"))
	r.Register(rep)

	// Without the flag the read waits and times out instead of going stale.
	p := runRead(r, Request{Key: "k", MinSeq: 7})
	advanceUntil(clock, 100*time.Millisecond, p.finished)
	if o := await(t, p); !errors.Is(o.err, ErrTimeout) {
		t.Fatalf("read without AllowStale: got err %v, want ErrTimeout", o.err)
	}

	// With the flag the same read degrades, explicitly marked stale.
	res, err := r.Read(context.Background(), Request{Key: "k", MinSeq: 7, AllowStale: true})
	if err != nil {
		t.Fatalf("stale read failed: %v", err)
	}
	if !res.Stale {
		t.Fatal("degraded read must be marked stale")
	}
	if res.Seq != 3 || string(res.Value) != "old" {
		t.Fatalf("stale read returned version %d value %q, want version 3 %q", res.Seq, res.Value, "old")
	}
}

// Revoking a replica removes it from routing: a read that it alone could
// satisfy must time out rather than silently fall back to a stale replica.
func TestRevokedReplicaStopsServing(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1000, 0))
	r := newTestRouter(clock)
	stale := NewMemReplica("stale")
	stale.Apply(3, "k", []byte("old"))
	fresh := NewMemReplica("fresh")
	fresh.Apply(10, "k", []byte("new"))
	r.Register(stale)
	r.Register(fresh)

	res, err := r.Read(context.Background(), Request{Key: "k", MinSeq: 7})
	if err != nil || res.ReplicaID != "fresh" {
		t.Fatalf("pre-revocation read: res=%+v err=%v", res, err)
	}

	r.Unregister("fresh")

	// The confirmed seq 7 is now unreachable; the read must time out.
	p := runRead(r, Request{Key: "k", MinSeq: 7})
	advanceUntil(clock, 100*time.Millisecond, p.finished)
	if o := await(t, p); !errors.Is(o.err, ErrTimeout) {
		t.Fatalf("read after revocation: got err %v, want ErrTimeout", o.err)
	}

	// Degradation is still possible, but only via the explicit flag.
	res, err = r.Read(context.Background(), Request{Key: "k", MinSeq: 7, AllowStale: true})
	if err != nil {
		t.Fatalf("stale read after revocation failed: %v", err)
	}
	if res.ReplicaID != "stale" || !res.Stale || res.Seq != 3 {
		t.Fatalf("stale read after revocation: %+v", res)
	}
}

// A revoked replica must not serve even when it is the only one left.
func TestReadWithNoReplicasTimesOut(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1000, 0))
	r := newTestRouter(clock)
	rep := NewMemReplica("r1")
	rep.Apply(10, "k", []byte("v"))
	r.Register(rep)
	r.Unregister("r1")

	p := runRead(r, Request{Key: "k", MinSeq: 1, AllowStale: true})
	advanceUntil(clock, 100*time.Millisecond, p.finished)
	o := await(t, p)
	if !errors.Is(o.err, ErrTimeout) {
		t.Fatalf("got err %v, want ErrTimeout", o.err)
	}
	if o.res.Value != nil || o.res.Seq != 0 || o.res.ReplicaID != "" || o.res.Stale {
		t.Fatalf("read with no replicas returned a value: %+v", o.res)
	}
}

// Cancelling the context aborts the wait and reports the context error.
func TestContextCancelAbortsRead(t *testing.T) {
	r := newTestRouter(RealClock{})
	rep := NewMemReplica("r1")
	rep.Apply(3, "k", []byte("old"))
	r.Register(rep)

	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan error, 1)
	go func() {
		_, err := r.Read(ctx, Request{Key: "k", MinSeq: 7})
		ch <- err
	}()
	cancel()
	select {
	case err := <-ch:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got err %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("read did not abort on cancel")
	}
}

// A replica that reports a high applied sequence but serves an older value
// must not have that value passed off as a fresh read.
func TestRegressedVersionIsNotServedAsFresh(t *testing.T) {
	clock := NewVirtualClock(time.Unix(1000, 0))
	r := newTestRouter(clock)
	rep := NewMemReplica("r1")
	// Key written at seq 3, but the replica later applied unrelated entries
	// up to seq 10, so its applied seq is high while the value is old.
	rep.Apply(3, "k", []byte("old"))
	rep.Apply(10, "other", []byte("x"))
	r.Register(rep)

	p := runRead(r, Request{Key: "k", MinSeq: 7})
	advanceUntil(clock, 100*time.Millisecond, p.finished)
	o := await(t, p)
	if !errors.Is(o.err, ErrTimeout) {
		t.Fatalf("got err %v, want ErrTimeout (old value must not pass as fresh)", o.err)
	}
}
