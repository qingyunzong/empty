package offlineq

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestClaimIncrementsGeneration(t *testing.T) {
	q := New(nil)
	q.Add("t")
	l1, ok := q.Claim("t", "h1", 0, 2)
	if !ok || l1.Generation != 1 || l1.Deadline != 2 {
		t.Fatalf("first claim: %+v ok=%v", l1, ok)
	}
	// Live lease blocks re-claim.
	if _, ok := q.Claim("t", "h2", 1, 2); ok {
		t.Fatal("re-claim while lease is live must fail")
	}
	// After expiry, re-claim bumps the generation.
	l2, ok := q.Claim("t", "h2", 2, 2)
	if !ok || l2.Generation != 2 || l2.Holder != "h2" {
		t.Fatalf("re-claim after expiry: %+v ok=%v", l2, ok)
	}
}

func TestStaleAckRejectedAfterTimeoutReclaim(t *testing.T) {
	q := New(nil)
	q.Add("t")
	l1, _ := q.Claim("t", "h1", 0, 1)
	l2, ok := q.Claim("t", "h2", 1, 5) // l1 expired at now=1
	if !ok {
		t.Fatal("re-claim after expiry should succeed")
	}
	if q.Ack("t", l1.Generation, 1) {
		t.Fatal("stale-generation ack must be rejected")
	}
	if !q.Ack("t", l2.Generation, 2) {
		t.Fatal("current-generation ack must succeed")
	}
	if q.Ack("t", l2.Generation, 2) {
		t.Fatal("double ack must be rejected")
	}
}

func TestDeadlineEqualityMeansExpired(t *testing.T) {
	q := New(nil)
	q.Add("t")
	l, _ := q.Claim("t", "h1", 0, 2) // deadline = 2
	if q.Ack("t", l.Generation, 2) {
		t.Fatal("ack at now == deadline must fail: lease already expired")
	}
	if _, ok := q.CurrentHolder("t", 2); ok {
		t.Fatal("no current holder at now == deadline")
	}
	if _, ok := q.Claim("t", "h2", 2, 1); !ok {
		t.Fatal("task must be claimable again at now == deadline")
	}
	// One tick earlier the lease is still live.
	q2 := New(nil)
	q2.Add("t")
	l2, _ := q2.Claim("t", "h1", 0, 2)
	if !q2.Ack("t", l2.Generation, 1) {
		t.Fatal("ack one tick before deadline must succeed")
	}
}

func TestExtendOnlyCurrentGeneration(t *testing.T) {
	q := New(nil)
	q.Add("t")
	l1, _ := q.Claim("t", "h1", 0, 2)
	l2, _ := q.Claim("t", "h2", 2, 2) // l1 expired, generation now 2
	if q.Extend("t", l1.Generation, 2, 10) {
		t.Fatal("extend with stale generation must fail")
	}
	if q.Extend("t", l2.Generation+1, 2, 10) {
		t.Fatal("extend with unknown generation must fail")
	}
	if q.Extend("t", l2.Generation, 2, 2) {
		t.Fatal("extend to now/past must fail")
	}
	if !q.Extend("t", l2.Generation, 2, 10) {
		t.Fatal("extend with current generation must succeed")
	}
	if !q.Ack("t", l2.Generation, 9) {
		t.Fatal("ack before extended deadline must succeed")
	}
}

func TestExtendOnExpiredLeaseFails(t *testing.T) {
	q := New(nil)
	q.Add("t")
	l, _ := q.Claim("t", "h1", 0, 2)
	if q.Extend("t", l.Generation, 2, 10) { // now == deadline: expired
		t.Fatal("extend of expired lease must fail")
	}
}

func TestEventLogReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.log")
	q, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	q.Add("a")
	q.Add("b")
	la, _ := q.Claim("a", "h1", 0, 2)
	q.Claim("b", "h2", 0, 1)
	q.Extend("a", la.Generation, 1, 5)
	q.Close()

	// Replay must restore generation, holder and extended deadline.
	q2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer q2.Close()
	got, ok := q2.CurrentHolder("a", 4)
	if !ok || got.Holder != "h1" || got.Generation != 1 || got.Deadline != 5 {
		t.Fatalf("replayed holder: %+v ok=%v", got, ok)
	}
	if _, ok := q2.CurrentHolder("b", 1); ok {
		t.Fatal("replayed lease on b must be expired at now=1")
	}
	// Generation survives the restart: next claim on b is 2, not 1.
	lb, ok := q2.Claim("b", "h3", 1, 1)
	if !ok || lb.Generation != 2 {
		t.Fatalf("generation after replay: %+v ok=%v", lb, ok)
	}
	if !q2.Ack("a", 1, 4) {
		t.Fatal("ack with replayed generation must succeed")
	}
}

// --- Small-history enumeration -------------------------------------------

// model is an independent, deliberately simple reference implementation
// used to cross-check the real Queue on every enumerated history.
type model struct {
	tasks map[string]*modelTask
}

type modelTask struct {
	acked, claimed bool
	gen            uint64
	holder         string
	deadline       int64
}

func newModel() *model { return &model{tasks: map[string]*modelTask{"A": {}, "B": {}}} }

func (m *model) valid(t *modelTask, now int64) bool {
	return t.claimed && !t.acked && now < t.deadline
}

func (m *model) claim(id, holder string, now, ttl int64) (Lease, bool) {
	t := m.tasks[id]
	if t.acked || m.valid(t, now) {
		return Lease{}, false
	}
	t.claimed, t.gen, t.holder, t.deadline = true, t.gen+1, holder, now+ttl
	return Lease{id, holder, t.gen, t.deadline}, true
}

func (m *model) ack(id string, gen uint64, now int64) bool {
	t := m.tasks[id]
	if gen != t.gen || !m.valid(t, now) {
		return false
	}
	t.acked = true
	return true
}

func (m *model) extend(id string, gen uint64, now, nd int64) bool {
	t := m.tasks[id]
	if gen != t.gen || !m.valid(t, now) || nd <= now {
		return false
	}
	t.deadline = nd
	return true
}

func (m *model) clone() *model {
	c := &model{tasks: make(map[string]*modelTask, len(m.tasks))}
	for k, v := range m.tasks {
		cp := *v
		c.tasks[k] = &cp
	}
	return c
}

func (q *Queue) clone() *Queue {
	c := &Queue{tasks: make(map[string]*taskState, len(q.tasks))}
	for k, v := range q.tasks {
		cp := *v
		c.tasks[k] = &cp
	}
	return c
}

const ttl = 2

// checkState asserts the queue matches the model and that the core
// invariant holds: each task has at most one current holder, and exactly
// the current generation of a live lease is ackable.
func checkState(t *testing.T, q *Queue, m *model, now int64, hist []string) {
	t.Helper()
	ctx := fmt.Sprintf("now=%d history=%v", now, hist)
	for id, mt := range m.tasks {
		lease, ok := q.CurrentHolder(id, now)
		mvalid := m.valid(mt, now)
		if ok != mvalid {
			t.Fatalf("%s: task %s holder mismatch: queue=%v model=%v", ctx, id, ok, mvalid)
		}
		if ok && (lease.Generation != mt.gen || lease.Holder != mt.holder || lease.Deadline != mt.deadline) {
			t.Fatalf("%s: task %s lease mismatch: queue=%+v model=%+v", ctx, id, lease, mt)
		}
		// Probe ackability on a throwaway clone: at most one generation
		// (the current one, and only while the lease is live) may ack.
		ackable := 0
		for _, g := range []uint64{mt.gen - 1, mt.gen, mt.gen + 1, mt.gen + 2} {
			if q.clone().Ack(id, g, now) {
				ackable++
				if !mvalid || g != mt.gen {
					t.Fatalf("%s: task %s acked with gen %d, model gen=%d valid=%v", ctx, id, g, mt.gen, mvalid)
				}
			}
		}
		if ackable > 1 {
			t.Fatalf("%s: task %s has %d ackable generations (want <= 1)", ctx, id, ackable)
		}
	}
}

// TestEnumerateSmallHistories exhaustively enumerates every operation
// history up to a fixed depth over two tasks and two holders, checking
// after every step that queue and model agree and that no task ever has
// more than one current holder.
func TestEnumerateSmallHistories(t *testing.T) {
	const depth = 6
	type op struct {
		name  string
		apply func(q *Queue, m *model, now int64)
	}
	ops := []op{
		{"claimA1", func(q *Queue, m *model, now int64) {
			ql, qok := q.Claim("A", "h1", now, ttl)
			ml, mok := m.claim("A", "h1", now, ttl)
			if qok != mok || ql != ml {
				t.Fatalf("claim A h1: queue=%+v,%v model=%+v,%v", ql, qok, ml, mok)
			}
		}},
		{"claimA2", func(q *Queue, m *model, now int64) {
			ql, qok := q.Claim("A", "h2", now, ttl)
			ml, mok := m.claim("A", "h2", now, ttl)
			if qok != mok || ql != ml {
				t.Fatalf("claim A h2: queue=%+v,%v model=%+v,%v", ql, qok, ml, mok)
			}
		}},
		{"claimB1", func(q *Queue, m *model, now int64) {
			ql, qok := q.Claim("B", "h1", now, ttl)
			ml, mok := m.claim("B", "h1", now, ttl)
			if qok != mok || ql != ml {
				t.Fatalf("claim B h1: queue=%+v,%v model=%+v,%v", ql, qok, ml, mok)
			}
		}},
		{"ackAcur", func(q *Queue, m *model, now int64) {
			if got, want := q.Ack("A", m.tasks["A"].gen, now), m.ack("A", m.tasks["A"].gen, now); got != want {
				t.Fatalf("ack A cur: queue=%v model=%v", got, want)
			}
		}},
		{"ackAstale", func(q *Queue, m *model, now int64) {
			g := m.tasks["A"].gen - 1
			if got, want := q.Ack("A", g, now), m.ack("A", g, now); got != want {
				t.Fatalf("ack A stale: queue=%v model=%v", got, want)
			}
		}},
		{"ackBcur", func(q *Queue, m *model, now int64) {
			if got, want := q.Ack("B", m.tasks["B"].gen, now), m.ack("B", m.tasks["B"].gen, now); got != want {
				t.Fatalf("ack B cur: queue=%v model=%v", got, want)
			}
		}},
		{"extendAcur", func(q *Queue, m *model, now int64) {
			if got, want := q.Extend("A", m.tasks["A"].gen, now, now+ttl), m.extend("A", m.tasks["A"].gen, now, now+ttl); got != want {
				t.Fatalf("extend A cur: queue=%v model=%v", got, want)
			}
		}},
		{"extendAstale", func(q *Queue, m *model, now int64) {
			g := m.tasks["A"].gen - 1
			if got, want := q.Extend("A", g, now, now+ttl), m.extend("A", g, now, now+ttl); got != want {
				t.Fatalf("extend A stale: queue=%v model=%v", got, want)
			}
		}},
	}

	q0 := New(nil)
	q0.Add("A")
	q0.Add("B")
	var histories int
	var walk func(q *Queue, m *model, now int64, hist []string, d int)
	walk = func(q *Queue, m *model, now int64, hist []string, d int) {
		checkState(t, q, m, now, hist)
		if d == depth {
			histories++
			return
		}
		for _, o := range ops {
			q2, m2 := q.clone(), m.clone()
			o.apply(q2, m2, now)
			walk(q2, m2, now, append(hist, o.name), d+1)
		}
		// Time always advances as an additional branch.
		walk(q, m, now+1, append(hist, "tick"), d+1)
	}
	walk(q0, newModel(), 0, nil, 0)
	t.Logf("enumerated %d complete histories of depth %d over %d ops + tick", histories, depth, len(ops))
}
