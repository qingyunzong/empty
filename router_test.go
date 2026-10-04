package router

import (
	"errors"
	"testing"
	"time"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func TestFreshReadRoutesOnlyToUpToDateReplica(t *testing.T) {
	a := NewLogReplica("a")
	a.Apply(7, "k", "a7")
	a.AdvanceTo(10)
	b := NewLogReplica("b")
	b.Apply(4, "k", "b4")

	rt := &Router{Replicas: []Replica{a, b}, Clock: NewVirtualClock(t0)}
	res, err := rt.Read(ReadRequest{Key: "k", MinSeq: 6})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.ReplicaID != "a" {
		t.Fatalf("served by %q, want up-to-date replica a", res.ReplicaID)
	}
	if res.Stale {
		t.Fatal("fresh read marked stale")
	}
	if res.Value != "a7" || res.Version != 7 {
		t.Fatalf("got (%q, v%d), want (a7, v7)", res.Value, res.Version)
	}
}

func TestTimeoutDoesNotFakeSuccess(t *testing.T) {
	a := NewLogReplica("a")
	a.Apply(3, "k", "a3")

	clock := NewVirtualClock(t0)
	rt := &Router{Replicas: []Replica{a}, Clock: clock, PollInterval: time.Second}
	res, err := rt.Read(ReadRequest{Key: "k", MinSeq: 5, Timeout: 3 * time.Second})
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
	if res != (ReadResult{}) {
		t.Fatalf("timeout returned non-zero result %+v", res)
	}
	if elapsed := clock.Now().Sub(t0); elapsed != 3*time.Second {
		t.Fatalf("clock advanced %v, want 3s", elapsed)
	}
}

func TestReplicaCatchUpBeforeDeadline(t *testing.T) {
	a := NewLogReplica("a")
	a.Apply(2, "k", "a2")

	clock := NewVirtualClock(t0)
	clock.At(t0.Add(2*time.Second), func(time.Time) {
		a.Apply(5, "k", "a5") // replica catches up to seq 5
	})

	rt := &Router{Replicas: []Replica{a}, Clock: clock, PollInterval: time.Second}
	res, err := rt.Read(ReadRequest{Key: "k", MinSeq: 5, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.Stale || res.Value != "a5" || res.Version != 5 {
		t.Fatalf("got %+v, want fresh (a5, v5)", res)
	}
	if elapsed := clock.Now().Sub(t0); elapsed != 2*time.Second {
		t.Fatalf("served after %v, want 2s (first poll after catch-up)", elapsed)
	}
}

func TestStaleReadRequiresExplicitFlag(t *testing.T) {
	newRouter := func() *Router {
		a := NewLogReplica("a")
		a.Apply(3, "k", "a3")
		b := NewLogReplica("b")
		b.Apply(1, "k", "b1")
		return &Router{Replicas: []Replica{a, b}, Clock: NewVirtualClock(t0), PollInterval: time.Second}
	}

	// Without the flag the router waits and then fails honestly.
	if _, err := newRouter().Read(ReadRequest{Key: "k", MinSeq: 5, Timeout: time.Second}); !errors.Is(err, ErrTimeout) {
		t.Fatalf("without AllowStale: err = %v, want ErrTimeout", err)
	}

	// With the flag the read degrades to the freshest replica, marked stale.
	res, err := newRouter().Read(ReadRequest{Key: "k", MinSeq: 5, AllowStale: true, Timeout: time.Second})
	if err != nil {
		t.Fatalf("with AllowStale: %v", err)
	}
	if !res.Stale {
		t.Fatal("degraded read not marked stale")
	}
	if res.ReplicaID != "a" || res.Value != "a3" || res.Version != 3 {
		t.Fatalf("got %+v, want stale (a3, v3) from freshest replica a", res)
	}
	if res.Version >= 5 {
		t.Fatalf("stale result version %d not provably below MinSeq 5", res.Version)
	}
}

func TestStaleFallbackMissingKeyStillTimesOut(t *testing.T) {
	a := NewLogReplica("a")
	a.AdvanceTo(2)
	rt := &Router{Replicas: []Replica{a}, Clock: NewVirtualClock(t0), PollInterval: time.Second}
	if _, err := rt.Read(ReadRequest{Key: "absent", MinSeq: 5, AllowStale: true, Timeout: time.Second}); !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrTimeout", err)
	}
}

// midReadRevoker revokes its own log while a read is in flight, to
// exercise the router's post-read freshness re-verification.
type midReadRevoker struct {
	inner    *LogReplica
	revokeTo uint64
}

func (m midReadRevoker) ID() string         { return m.inner.ID() }
func (m midReadRevoker) AppliedSeq() uint64 { return m.inner.AppliedSeq() }
func (m midReadRevoker) Read(key string) (string, uint64, bool) {
	m.inner.Revoke(m.revokeTo)
	return m.inner.Read(key)
}

func TestRevokedMidReadIsRejected(t *testing.T) {
	a := NewLogReplica("a")
	a.Apply(2, "k", "a2")
	a.Apply(6, "k", "a6") // will be revoked down to seq 3 mid-read
	b := NewLogReplica("b")
	b.Apply(6, "k", "b6")

	rt := &Router{
		Replicas: []Replica{midReadRevoker{inner: a, revokeTo: 3}, b},
		Clock:    NewVirtualClock(t0),
	}
	res, err := rt.Read(ReadRequest{Key: "k", MinSeq: 5})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.ReplicaID != "b" || res.Value != "b6" || res.Version != 6 {
		t.Fatalf("got %+v, want (b6, v6) from b after a's revocation", res)
	}
}

func TestCatchUpThenRevokeIsNotServed(t *testing.T) {
	a := NewLogReplica("a")
	a.Apply(2, "k", "a2")
	b := NewLogReplica("b")
	b.Apply(2, "k", "b2")

	clock := NewVirtualClock(t0)
	// a catches up and is revoked again before the router's next poll.
	clock.At(t0.Add(time.Second), func(time.Time) { a.Apply(6, "k", "a6") })
	clock.At(t0.Add(time.Second), func(time.Time) { a.Revoke(3) })
	// b catches up honestly a little later.
	clock.At(t0.Add(3*time.Second), func(time.Time) { b.Apply(5, "k", "b5") })

	rt := &Router{Replicas: []Replica{a, b}, Clock: clock, PollInterval: time.Second}
	res, err := rt.Read(ReadRequest{Key: "k", MinSeq: 5, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.ReplicaID != "b" || res.Value != "b5" || res.Version != 5 {
		t.Fatalf("got %+v, want (b5, v5) from b", res)
	}
	if a.AppliedSeq() != 3 {
		t.Fatalf("a applied = %d, want revoked to 3", a.AppliedSeq())
	}
}

func TestReturnedVersionIsProvable(t *testing.T) {
	a := NewLogReplica("a")
	a.Apply(4, "k", "a4")
	a.Apply(9, "k", "a9")
	a.AdvanceTo(12)

	rt := &Router{Replicas: []Replica{a}, Clock: NewVirtualClock(t0)}
	res, err := rt.Read(ReadRequest{Key: "k", MinSeq: 10})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	// The returned (value, version) pair must be provable against the
	// serving replica's own log.
	value, version, ok := a.Read("k")
	if !ok || value != res.Value || version != res.Version {
		t.Fatalf("result (%q, v%d) not provable: replica log has (%q, v%d)",
			res.Value, res.Version, value, version)
	}
	if res.Version > a.AppliedSeq() {
		t.Fatalf("version %d beyond replica applied seq %d", res.Version, a.AppliedSeq())
	}
}

func TestNoReplicas(t *testing.T) {
	rt := &Router{}
	if _, err := rt.Read(ReadRequest{Key: "k"}); !errors.Is(err, ErrNoReplicas) {
		t.Fatalf("err = %v, want ErrNoReplicas", err)
	}
}
