package txnlib

import (
	"fmt"
	"strings"
	"testing"
)

func mustBegin(t *testing.T, m *Manager) *Txn {
	t.Helper()
	tx, err := m.Begin()
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	return tx
}

func mustRead(t *testing.T, m *Manager, tx *Txn, lo, hi string) map[string]string {
	t.Helper()
	vals, err := m.Read(tx, Predicate{Lo: lo, Hi: hi})
	if err != nil {
		t.Fatalf("Read(%s,%s): %v", lo, hi, err)
	}
	return vals
}

func mustWrite(t *testing.T, m *Manager, tx *Txn, key, value string) {
	t.Helper()
	if err := m.Write(tx, key, value); err != nil {
		t.Fatalf("Write(%s): %v", key, err)
	}
}

func mustCommit(t *testing.T, m *Manager, tx *Txn) {
	t.Helper()
	if err := m.Commit(tx); err != nil {
		t.Fatalf("Commit(T%d): %v", tx.ID, err)
	}
}

func TestReadFromAndWriteWriteAccepted(t *testing.T) {
	m := NewManager()
	t1 := mustBegin(t, m)
	mustWrite(t, m, t1, "x", "1")
	mustCommit(t, m, t1)

	t2 := mustBegin(t, m)
	if got := mustRead(t, m, t2, "x", "x"); got["x"] != "1" {
		t.Fatalf("read x = %v, want 1", got["x"])
	}
	mustWrite(t, m, t2, "x", "2")
	mustCommit(t, m, t2)

	if got := m.Data()["x"]; got != "2" {
		t.Fatalf("store x = %q, want 2", got)
	}

	edges := buildEdges(m.Committed())
	var hasWR, hasWW bool
	for _, e := range edges {
		if e.From == t1.ID && e.To == t2.ID && e.Kind == EdgeWR {
			hasWR = true
		}
		if e.From == t1.ID && e.To == t2.ID && e.Kind == EdgeWW {
			hasWW = true
		}
	}
	if !hasWR || !hasWW {
		t.Fatalf("want wr and ww edges T1->T2, got %v", edges)
	}

	ok, order := VerifySerializable(m.Committed())
	if !ok {
		t.Fatal("accepted history rejected by verifier")
	}
	if len(order) != 2 || order[0] != t1.ID || order[1] != t2.ID {
		t.Fatalf("serial order = %v, want [T%d T%d]", order, t1.ID, t2.ID)
	}
}

func TestAntiDependencyCycleAbortsNewestRequester(t *testing.T) {
	m := NewManager()
	t1 := mustBegin(t, m)
	t2 := mustBegin(t, m)
	mustRead(t, m, t1, "x", "x") // observes nothing
	mustRead(t, m, t2, "y", "y") // observes nothing
	mustWrite(t, m, t1, "y", "1")
	mustWrite(t, m, t2, "x", "1")

	mustCommit(t, m, t1)
	err := m.Commit(t2)
	ce, ok := err.(*CommitError)
	if !ok {
		t.Fatalf("Commit(T%d) = %v, want *CommitError", t2.ID, err)
	}
	if ce.Victim != t2.ID {
		t.Fatalf("victim = T%d, want newest requester T%d", ce.Victim, t2.ID)
	}
	if len(ce.Cycle) != 2 {
		t.Fatalf("cycle = %v, want 2 transactions", ce.Cycle)
	}
	if !strings.Contains(ce.Evidence(), "rw") {
		t.Fatalf("evidence lacks rw edge: %s", ce.Evidence())
	}
	t.Logf("cycle evidence: %s", ce.Evidence())

	if t1.State() != "committed" || t2.State() != "aborted" {
		t.Fatalf("states: T%d=%s T%d=%s", t1.ID, t1.State(), t2.ID, t2.State())
	}
	if _, leaked := m.Data()["x"]; leaked {
		t.Fatal("aborted write to x leaked into store")
	}
	if m.Data()["y"] != "1" {
		t.Fatal("committed write to y missing")
	}
	if ok, _ := VerifySerializable(m.Committed()); !ok {
		t.Fatal("accepted history rejected by verifier")
	}
}

func TestRangePhantomFormsEdge(t *testing.T) {
	m := NewManager()
	t1 := mustBegin(t, m)
	t2 := mustBegin(t, m)
	mustRead(t, m, t1, "a", "z") // range scan, empty
	mustRead(t, m, t2, "q", "q") // observes nothing
	mustWrite(t, m, t1, "q", "9")
	mustWrite(t, m, t2, "m", "1") // phantom insert into [a,z]

	mustCommit(t, m, t1)
	err := m.Commit(t2)
	ce, ok := err.(*CommitError)
	if !ok {
		t.Fatalf("Commit(T%d) = %v, want *CommitError", t2.ID, err)
	}
	if ce.Victim != t2.ID {
		t.Fatalf("victim = T%d, want T%d", ce.Victim, t2.ID)
	}
	var phantom Edge
	found := false
	for _, e := range ce.Edges {
		if e.From == t1.ID && e.To == t2.ID && e.Kind == EdgeRW && e.Key == "m" && e.Phantom {
			phantom, found = e, true
		}
	}
	if !found {
		t.Fatalf("no phantom edge T%d->T%d on m in evidence: %s", t1.ID, t2.ID, ce.Evidence())
	}
	t.Logf("phantom edge: %s; full cycle: %s", phantom, ce.Evidence())
	if ok, _ := VerifySerializable(m.Committed()); !ok {
		t.Fatal("accepted history rejected by verifier")
	}
}

func TestVictimIsNewestCommitRequester(t *testing.T) {
	m := NewManager()
	late := mustBegin(t, m) // begins first, commits last
	mustRead(t, m, late, "d", "d")

	ta := mustBegin(t, m)
	mustWrite(t, m, ta, "a", "1")
	mustWrite(t, m, ta, "d", "1") // overwrites key late read -> rw late->ta
	mustCommit(t, m, ta)

	tb := mustBegin(t, m)
	if got := mustRead(t, m, tb, "a", "a"); got["a"] != "1" { // wr ta->tb
		t.Fatalf("read a = %v, want 1", got["a"])
	}
	mustWrite(t, m, tb, "b", "1")
	mustCommit(t, m, tb)

	mustRead(t, m, late, "b", "b") // wr tb->late, closing the cycle
	mustWrite(t, m, late, "x", "1")

	err := m.Commit(late)
	ce, ok := err.(*CommitError)
	if !ok {
		t.Fatalf("Commit(T%d) = %v, want *CommitError", late.ID, err)
	}
	if ce.Victim != late.ID {
		t.Fatalf("victim = T%d, want newest requester T%d", ce.Victim, late.ID)
	}
	if len(ce.Cycle) != 3 {
		t.Fatalf("cycle = %v, want 3 transactions", ce.Cycle)
	}
	t.Logf("cycle evidence: %s", ce.Evidence())
	if ta.State() != "committed" || tb.State() != "committed" {
		t.Fatal("earlier committed transactions must survive")
	}
	if ok, order := VerifySerializable(m.Committed()); !ok || len(order) != 2 {
		t.Fatalf("verifier = %v %v, want serializable 2-transaction history", ok, order)
	}
}

func TestHistoryLimitAndTwelveTransactionHistory(t *testing.T) {
	m := NewManager()
	txns := make([]*Txn, 0, MaxTransactions)
	for i := 0; i < MaxTransactions; i++ {
		tx := mustBegin(t, m)
		mustWrite(t, m, tx, fmt.Sprintf("k%02d", i), "v")
		txns = append(txns, tx)
	}
	if _, err := m.Begin(); err == nil {
		t.Fatal("13th Begin succeeded, want limit error")
	}
	for _, tx := range txns {
		mustCommit(t, m, tx)
	}
	ok, order := VerifySerializable(m.Committed())
	if !ok {
		t.Fatal("12-transaction history rejected by verifier")
	}
	if len(order) != MaxTransactions {
		t.Fatalf("serial order covers %d transactions, want %d", len(order), MaxTransactions)
	}
	if len(m.Data()) != MaxTransactions {
		t.Fatalf("store has %d keys, want %d", len(m.Data()), MaxTransactions)
	}
}

func TestVerifierRejectsNonSerializableHistory(t *testing.T) {
	t1 := &Txn{
		ID:     1,
		Reads:  []ReadOp{{Seq: 1, Pred: Predicate{Lo: "x", Hi: "x"}, Values: map[string]string{}}},
		Writes: []WriteOp{{Seq: 3, Key: "y", Value: "1"}},
	}
	t2 := &Txn{
		ID:     2,
		Reads:  []ReadOp{{Seq: 2, Pred: Predicate{Lo: "y", Hi: "y"}, Values: map[string]string{}}},
		Writes: []WriteOp{{Seq: 4, Key: "x", Value: "1"}},
	}
	if ok, order := VerifySerializable([]*Txn{t1, t2}); ok {
		t.Fatalf("cyclic history accepted, order = %v", order)
	}
}
