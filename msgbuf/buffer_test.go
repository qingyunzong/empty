package msgbuf

import (
	"errors"
	"reflect"
	"testing"
)

func msg(from string, seq uint64, deps map[string]uint64, size int) Message {
	return Message{From: from, Seq: seq, Deps: deps, Payload: make([]byte, size)}
}

func keys(k ...Key) []Key { return k }

func TestImmediateDeliveryAdvancesVector(t *testing.T) {
	b := New(100)
	rep, err := b.Receive(msg("a", 1, nil, 10))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rep.Outcome != Delivered {
		t.Fatalf("outcome = %v, want Delivered", rep.Outcome)
	}
	if len(rep.Now) != 1 || rep.Now[0].ID() != (Key{"a", 1}) {
		t.Fatalf("delivered = %v, want [a#1]", rep.Now)
	}
	if got := b.Vector()["a"]; got != 1 {
		t.Fatalf("vector[a] = %d, want 1", got)
	}
	if b.Used() != 0 {
		t.Fatalf("used = %d, want 0 after immediate delivery", b.Used())
	}
}

func TestBlockedOccupiesBudgetAndCascadeReleases(t *testing.T) {
	b := New(100)
	m1 := msg("a", 1, nil, 10)
	m2 := msg("b", 1, map[string]uint64{"a": 1}, 30)

	rep, err := b.Receive(m2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rep.Outcome != Blocked {
		t.Fatalf("outcome = %v, want Blocked", rep.Outcome)
	}
	if b.Used() != 30 {
		t.Fatalf("used = %d, want 30 while blocked", b.Used())
	}
	if got := b.Vector()["b"]; got != 0 {
		t.Fatalf("vector[b] = %d, want 0 (blocked must not advance vector)", got)
	}
	if !reflect.DeepEqual(rep.Missing, keys(Key{"a", 1})) {
		t.Fatalf("missing = %v, want [a#1]", rep.Missing)
	}

	rep, err = b.Receive(m1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rep.Outcome != Delivered {
		t.Fatalf("outcome = %v, want Delivered", rep.Outcome)
	}
	wantOrder := []Key{{"a", 1}, {"b", 1}}
	var gotOrder []Key
	for _, m := range rep.Now {
		gotOrder = append(gotOrder, m.ID())
	}
	if !reflect.DeepEqual(gotOrder, wantOrder) {
		t.Fatalf("delivery order = %v, want %v", gotOrder, wantOrder)
	}
	if b.Used() != 0 || b.Pending() != 0 {
		t.Fatalf("used=%d pending=%d, want 0/0 after cascade release", b.Used(), b.Pending())
	}
	if got := b.Vector()["b"]; got != 1 {
		t.Fatalf("vector[b] = %d, want 1 after cascade", got)
	}
}

func TestBudgetRejectKeepsStateAndVector(t *testing.T) {
	b := New(30) // fits exactly one blocked 30-byte message
	m1 := msg("a", 1, nil, 5)
	m2 := msg("b", 1, map[string]uint64{"a": 1}, 30)
	m3 := msg("c", 1, map[string]uint64{"a": 1}, 1)

	if _, err := b.Receive(m2); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	vecBefore := b.Vector()
	usedBefore := b.Used()

	rep, err := b.Receive(m3)
	var be *BudgetError
	if !errors.As(err, &be) {
		t.Fatalf("err = %v, want *BudgetError", err)
	}
	if rep.Outcome != Blocked {
		t.Fatalf("outcome = %v, want Blocked", rep.Outcome)
	}
	if be.Used != 30 || be.Need != 1 || be.Budget != 30 {
		t.Fatalf("BudgetError = %+v, want used=30 need=1 budget=30", be)
	}
	if !reflect.DeepEqual(b.Vector(), vecBefore) {
		t.Fatalf("vector changed after rejection: %v -> %v", vecBefore, b.Vector())
	}
	if b.Used() != usedBefore || b.Pending() != 1 {
		t.Fatalf("state changed after rejection: used=%d pending=%d", b.Used(), b.Pending())
	}

	// Delivering the dependency frees the budget; the rejected message
	// is accepted on retry.
	if _, err := b.Receive(m1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if b.Used() != 0 {
		t.Fatalf("used = %d, want 0 after cascade", b.Used())
	}
	rep, err = b.Receive(m3)
	if err != nil {
		t.Fatalf("retry after release failed: %v", err)
	}
	if rep.Outcome != Delivered {
		t.Fatalf("outcome = %v, want Delivered (deps now satisfied)", rep.Outcome)
	}
}

func TestMissingChainIsTransitive(t *testing.T) {
	b := New(1000)
	// Chain: c#1 depends on b#1, b#1 depends on a#1. Buffer c#1 first,
	// then b#1; asking for a message depending on c#1 must report the
	// complete chain down to the never-received a#1.
	if _, err := b.Receive(msg("c", 1, map[string]uint64{"b": 1}, 1)); err != nil {
		t.Fatal(err)
	}
	rep, err := b.Receive(msg("d", 1, map[string]uint64{"c": 1}, 1))
	if err != nil {
		t.Fatal(err)
	}
	// Direct missing is c#1 (buffered); the chain must include c#1's own
	// missing deps b#1, and b#1 is not buffered so the chain stops there.
	want := keys(Key{"b", 1}, Key{"c", 1})
	if !reflect.DeepEqual(rep.Missing, want) {
		t.Fatalf("missing chain = %v, want %v", rep.Missing, want)
	}

	// Now buffer b#1 as well and re-check through a fresh receiver path:
	// a rejection must also carry the full chain.
	small := New(3) // used=2 after the two 1-byte blocked messages above? no: fresh buffer
	_ = small
	b2 := New(2)
	if _, err := b2.Receive(msg("c", 1, map[string]uint64{"b": 1}, 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := b2.Receive(msg("d", 1, map[string]uint64{"c": 1}, 1)); err != nil {
		t.Fatal(err)
	}
	// Budget full (2/2). A third blocked message must be rejected with the
	// complete transitive chain.
	_, err = b2.Receive(msg("e", 1, map[string]uint64{"d": 1}, 1))
	var be *BudgetError
	if !errors.As(err, &be) {
		t.Fatalf("err = %v, want *BudgetError", err)
	}
	want = keys(Key{"b", 1}, Key{"c", 1}, Key{"d", 1})
	if !reflect.DeepEqual(be.Missing, want) {
		t.Fatalf("rejection chain = %v, want %v", be.Missing, want)
	}
}

func TestDuplicateIsNoop(t *testing.T) {
	b := New(100)
	m1 := msg("a", 1, nil, 10)
	m2 := msg("b", 1, map[string]uint64{"a": 1}, 20)

	if _, err := b.Receive(m2); err != nil { // blocked
		t.Fatal(err)
	}
	rep, err := b.Receive(m2) // duplicate of buffered
	if err != nil || rep.Outcome != Duplicate {
		t.Fatalf("outcome=%v err=%v, want Duplicate", rep.Outcome, err)
	}
	if b.Used() != 20 || b.Pending() != 1 {
		t.Fatalf("duplicate consumed budget: used=%d pending=%d", b.Used(), b.Pending())
	}
	if _, err := b.Receive(m1); err != nil { // delivers both
		t.Fatal(err)
	}
	rep, err = b.Receive(m1) // duplicate of delivered
	if err != nil || rep.Outcome != Duplicate {
		t.Fatalf("outcome=%v err=%v, want Duplicate", rep.Outcome, err)
	}
	if b.Used() != 0 || b.Pending() != 0 {
		t.Fatalf("duplicate changed state: used=%d pending=%d", b.Used(), b.Pending())
	}
}

func TestSelfSequenceGapBlocks(t *testing.T) {
	b := New(100)
	rep, err := b.Receive(msg("a", 3, nil, 5))
	if err != nil {
		t.Fatal(err)
	}
	if rep.Outcome != Blocked {
		t.Fatalf("outcome = %v, want Blocked", rep.Outcome)
	}
	want := keys(Key{"a", 1}, Key{"a", 2})
	if !reflect.DeepEqual(rep.Missing, want) {
		t.Fatalf("missing = %v, want %v", rep.Missing, want)
	}
	if got := b.Vector()["a"]; got != 0 {
		t.Fatalf("vector[a] = %d, want 0", got)
	}
	for _, s := range []uint64{1, 2} {
		if _, err := b.Receive(msg("a", s, nil, 5)); err != nil {
			t.Fatal(err)
		}
	}
	if got := b.Vector()["a"]; got != 3 {
		t.Fatalf("vector[a] = %d, want 3 after gap filled", got)
	}
	if b.Used() != 0 {
		t.Fatalf("used = %d, want 0", b.Used())
	}
}

func TestUnlimitedBudget(t *testing.T) {
	b := New(-1)
	for i := 0; i < 100; i++ {
		if _, err := b.Receive(msg("a", uint64(i+2), nil, 1<<20)); err != nil {
			t.Fatalf("unlimited buffer rejected: %v", err)
		}
	}
	if b.Pending() != 100 {
		t.Fatalf("pending = %d, want 100", b.Pending())
	}
}

func TestExactBudgetBoundary(t *testing.T) {
	b := New(10)
	if _, err := b.Receive(msg("a", 2, nil, 10)); err != nil { // exactly fits
		t.Fatalf("exact-fit message rejected: %v", err)
	}
	if _, err := b.Receive(msg("b", 2, nil, 1)); err == nil { // one byte over
		t.Fatal("over-budget message accepted")
	}
	if b.Used() != 10 {
		t.Fatalf("used = %d, want 10", b.Used())
	}
}
