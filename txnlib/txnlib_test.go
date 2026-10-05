package txnlib

import (
	"strings"
	"testing"
)

func TestBasicCommitAccepted(t *testing.T) {
	s := NewStore()
	t1 := s.Begin()
	t1.Write("a")
	if ev, err := s.Commit(t1); err != nil || ev != nil {
		t.Fatalf("T1 commit: ev=%v err=%v", ev, err)
	}
	t2 := s.Begin()
	t2.Read("a")
	t2.Write("b")
	if ev, err := s.Commit(t2); err != nil || ev != nil {
		t.Fatalf("T2 commit: ev=%v err=%v", ev, err)
	}
	if got := len(s.History()); got != 2 {
		t.Fatalf("history len = %d, want 2", got)
	}
	// T2 read a after T1 committed: one wr edge T1->T2.
	edges := s.Edges()
	if len(edges) != 1 || edges[0].Kind != WR || edges[0].From != t1.ID || edges[0].To != t2.ID {
		t.Fatalf("edges = %v, want one wr edge T1->T2", edges)
	}
}

func TestAntiDependencyCycleAbortsNewestRequester(t *testing.T) {
	s := NewStore()
	t1 := s.Begin()
	t2 := s.Begin()
	t1.Read("x")
	t1.Write("y")
	t2.Read("y")
	t2.Write("x")

	if _, err := s.Commit(t2); err != nil {
		t.Fatalf("T2 commit: %v", err)
	}
	ev, err := s.Commit(t1)
	if err != ErrAborted {
		t.Fatalf("T1 commit err = %v, want ErrAborted", err)
	}
	if ev == nil {
		t.Fatal("expected cycle evidence")
	}
	if ev.Victim != t1.ID {
		t.Fatalf("victim = T%d, want T%d (newest requester)", ev.Victim, t1.ID)
	}
	if t1.Status != Aborted {
		t.Fatalf("T1 status = %v, want Aborted", t1.Status)
	}
	if len(ev.Txns) != 2 || len(ev.Edges) != 2 {
		t.Fatalf("evidence txns=%v edges=%v, want 2 and 2", ev.Txns, ev.Edges)
	}
	for _, e := range ev.Edges {
		if e.Kind != RW {
			t.Fatalf("edge %v: kind = %v, want rw anti-dependency", e, e.Kind)
		}
	}
	t.Logf("evidence: %s", ev)
	// Only T2 remains in the accepted history.
	h := s.History()
	if len(h) != 1 || h[0].ID != t2.ID {
		t.Fatalf("history = %v, want only T2", h)
	}
}

func TestRangePhantomFormsEdge(t *testing.T) {
	s := NewStore()
	t1 := s.Begin()
	t1.Scan("a", "m") // range read, no point reads
	t2 := s.Begin()
	t2.Write("g") // falls inside [a,m): phantom

	if _, err := s.Commit(t2); err != nil {
		t.Fatalf("T2 commit: %v", err)
	}
	if _, err := s.Commit(t1); err != nil {
		t.Fatalf("T1 commit: %v", err)
	}
	edges := s.Edges()
	if len(edges) != 1 {
		t.Fatalf("edges = %v, want exactly one phantom edge", edges)
	}
	e := edges[0]
	if e.Kind != RW || !e.Phantom || e.From != t1.ID || e.To != t2.ID || e.Key != "g" {
		t.Fatalf("edge = %v, want phantom rw edge T1->T2 on key g", e)
	}
}

func TestPhantomCycleAborts(t *testing.T) {
	s := NewStore()
	t1 := s.Begin()
	t2 := s.Begin()
	t1.Scan("a", "m")
	t1.Write("z")
	t2.Read("z")
	t2.Write("g") // phantom against T1's range

	if _, err := s.Commit(t2); err != nil {
		t.Fatalf("T2 commit: %v", err)
	}
	ev, err := s.Commit(t1)
	if err != ErrAborted {
		t.Fatalf("T1 commit err = %v, want ErrAborted", err)
	}
	var sawPhantom bool
	for _, e := range ev.Edges {
		if e.Phantom {
			sawPhantom = true
		}
	}
	if !sawPhantom {
		t.Fatalf("cycle evidence lacks a phantom edge: %s", ev)
	}
	t.Logf("evidence: %s", ev)
}

func TestHistoryCappedAtTwelve(t *testing.T) {
	s := NewStore()
	const total = 15
	for i := 1; i <= total; i++ {
		tx := s.Begin()
		key := string(rune('a' + i - 1))
		if i > 1 {
			tx.Read(string(rune('a' + i - 2))) // wr edge from previous txn
		}
		tx.Write(key)
		if _, err := s.Commit(tx); err != nil {
			t.Fatalf("commit %d: %v", i, err)
		}
	}
	h := s.History()
	if len(h) != MaxHistory {
		t.Fatalf("history len = %d, want %d", len(h), MaxHistory)
	}
	if h[0].ID != total-MaxHistory+1 {
		t.Fatalf("oldest retained = T%d, want T%d", h[0].ID, total-MaxHistory+1)
	}
	// Edges referencing evicted transactions must be pruned: only
	// MaxHistory-1 wr edges remain among the retained window.
	edges := s.Edges()
	if len(edges) != MaxHistory-1 {
		t.Fatalf("edges = %d, want %d", len(edges), MaxHistory-1)
	}
	for _, e := range edges {
		if e.From < h[0].ID || e.To < h[0].ID {
			t.Fatalf("edge %v references an evicted transaction", e)
		}
	}
}

func TestVerifySerializableAcceptedHistory(t *testing.T) {
	s := NewStore()
	// A workload mixing accepted and aborted commits.
	mk := func(ops func(tx *Txn)) *Txn {
		tx := s.Begin()
		ops(tx)
		return tx
	}
	a := mk(func(tx *Txn) { tx.Write("p") })
	b := mk(func(tx *Txn) { tx.Read("p"); tx.Write("q") })
	c := mk(func(tx *Txn) { tx.Scan("a", "z"); tx.Write("r") })
	d := mk(func(tx *Txn) { tx.Read("r"); tx.Write("p") }) // conflicts with c's scan and a's write

	for _, tx := range []*Txn{a, b, c} {
		if _, err := s.Commit(tx); err != nil {
			t.Fatalf("commit T%d: %v", tx.ID, err)
		}
	}
	// d read r before c committed? No: d began after c committed only if
	// begun later; here all began up front, so d may abort.
	s.Commit(d)

	order, ok := VerifySerializable(s.History())
	if !ok {
		t.Fatalf("accepted history is not serializable; edges: %v", DeriveEdges(s.History()))
	}
	// The witnessing serial order must respect every derived edge.
	pos := map[int]int{}
	for i, id := range order {
		pos[id] = i
	}
	for _, e := range DeriveEdges(s.History()) {
		if pos[e.From] >= pos[e.To] {
			t.Fatalf("order %v violates edge %v", order, e)
		}
	}
	t.Logf("serial order: %v", order)
}

func TestVerifySerializableRejectsCyclicHistory(t *testing.T) {
	// Hand-crafted cycle: A reads x / writes y, B reads y / writes x,
	// both concurrent (BeginSeq 0), A committed first.
	a := &Txn{ID: 1, BeginSeq: 0, CommitSeq: 1,
		ReadKeys: map[string]struct{}{"x": {}}, Writes: map[string]struct{}{"y": {}}}
	b := &Txn{ID: 2, BeginSeq: 0, CommitSeq: 2,
		ReadKeys: map[string]struct{}{"y": {}}, Writes: map[string]struct{}{"x": {}}}
	if order, ok := VerifySerializable([]*Txn{a, b}); ok {
		t.Fatalf("cyclic history reported serializable with order %v", order)
	}
}

func TestNewestRequesterChosenAsVictim(t *testing.T) {
	nodes := []*Txn{
		{ID: 5, CommitSeq: 10},
		{ID: 2, CommitSeq: 7},
		{ID: 9, CommitSeq: 42},
	}
	if got := newestRequester(nodes, []int{5, 2, 9}); got != 9 {
		t.Fatalf("victim = T%d, want T9 (largest commit-request seq)", got)
	}
}

func TestEvidenceStringMentionsKeys(t *testing.T) {
	s := NewStore()
	t1 := s.Begin()
	t2 := s.Begin()
	t1.Read("alpha")
	t1.Write("beta")
	t2.Read("beta")
	t2.Write("alpha")
	s.Commit(t2)
	ev, err := s.Commit(t1)
	if err != ErrAborted {
		t.Fatalf("err = %v, want ErrAborted", err)
	}
	str := ev.String()
	if !strings.Contains(str, "alpha") || !strings.Contains(str, "beta") {
		t.Fatalf("evidence string missing keys: %q", str)
	}
}
