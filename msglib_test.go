package msglib

import (
	"errors"
	"reflect"
	"testing"
)

func payload(n int) []byte { return make([]byte, n) }

func TestPayloadByteAccounting(t *testing.T) {
	a := NewNode(0, 2, 100)
	b := NewNode(1, 2, 100)

	m1 := a.Send(payload(4))
	m2 := a.Send(payload(6))

	delivered, err := b.Receive(m2) // blocked: missing m1
	if err != nil || len(delivered) != 0 {
		t.Fatalf("Receive(m2) = %v, %v; want blocked, no error", delivered, err)
	}
	if got := b.Used(); got != 6 {
		t.Fatalf("Used after blocked m2 = %d, want 6", got)
	}

	delivered, err = b.Receive(m1)
	if err != nil {
		t.Fatalf("Receive(m1) error: %v", err)
	}
	if len(delivered) != 2 || delivered[0].ID != m1.ID || delivered[1].ID != m2.ID {
		t.Fatalf("delivered = %v, want [%v %v] in causal order", delivered, m1.ID, m2.ID)
	}
	if got := b.Used(); got != 0 {
		t.Fatalf("Used after delivery = %d, want 0", got)
	}
	if want := (Vector{2, 0}); !reflect.DeepEqual(b.Vector(), want) {
		t.Fatalf("Vector = %v, want %v", b.Vector(), want)
	}
}

func TestBlockedItemsConsumeBudget(t *testing.T) {
	a := NewNode(0, 2, 0)
	b := NewNode(1, 2, 10)

	m1 := a.Send(payload(4))
	m2 := a.Send(payload(6))
	m3 := a.Send(payload(5))

	if _, err := b.Receive(m2); err != nil {
		t.Fatalf("Receive(m2) error: %v", err)
	}
	if got := b.Used(); got != 6 {
		t.Fatalf("blocked m2 should consume budget: Used = %d, want 6", got)
	}

	if _, err := b.Receive(m3); !errors.Is(err, ErrOverBudget) {
		t.Fatalf("Receive(m3) = %v, want ErrOverBudget (6+5 > 10)", err)
	}

	delivered, err := b.Receive(m1) // 6+4 = 10 fits exactly
	if err != nil {
		t.Fatalf("Receive(m1) error: %v", err)
	}
	if len(delivered) != 2 {
		t.Fatalf("delivered = %v, want m1 and m2", delivered)
	}
	if got := b.Used(); got != 0 {
		t.Fatalf("Used after drain = %d, want 0", got)
	}
	if want := (Vector{2, 0}); !reflect.DeepEqual(b.Vector(), want) {
		t.Fatalf("Vector = %v, want %v", b.Vector(), want)
	}
}

func TestRejectionLeavesVectorAndMemoryUntouched(t *testing.T) {
	a := NewNode(0, 2, 0)
	b := NewNode(1, 2, 8)

	m1 := a.Send(payload(3))
	m2 := a.Send(payload(6))

	if _, err := b.Receive(m2); err != nil {
		t.Fatalf("Receive(m2) error: %v", err)
	}
	beforeVec := b.Vector()
	beforeUsed := b.Used()

	_, err := b.Receive(m1) // 6+3 = 9 > 8
	if !errors.Is(err, ErrOverBudget) {
		t.Fatalf("Receive(m1) = %v, want ErrOverBudget", err)
	}
	var obe *OverBudgetError
	if !errors.As(err, &obe) {
		t.Fatalf("error %T is not *OverBudgetError", err)
	}
	if obe.Used != 6 || obe.Limit != 8 || obe.Need != 3 {
		t.Fatalf("OverBudgetError = %+v, want {Used:6 Limit:8 Need:3}", obe)
	}
	if !reflect.DeepEqual(b.Vector(), beforeVec) {
		t.Fatalf("receive vector advanced on rejection: %v -> %v", beforeVec, b.Vector())
	}
	if b.Used() != beforeUsed {
		t.Fatalf("Used changed on rejection: %d -> %d", beforeUsed, b.Used())
	}
	if got := b.Pending(); len(got) != 1 || got[0] != m2.ID {
		t.Fatalf("Pending = %v, want [%v]", got, m2.ID)
	}
}

func TestReleaseAfterDelivery(t *testing.T) {
	a := NewNode(0, 2, 0)
	b := NewNode(1, 2, 100)

	msgs := make([]Message, 5)
	for i := range msgs {
		msgs[i] = a.Send(payload(10))
	}
	// Buffer m2..m5 out of order: all blocked on m1.
	for i := 4; i >= 1; i-- {
		if _, err := b.Receive(msgs[i]); err != nil {
			t.Fatalf("Receive(%v) error: %v", msgs[i].ID, err)
		}
	}
	if got := b.Used(); got != 40 {
		t.Fatalf("Used = %d, want 40", got)
	}

	delivered, err := b.Receive(msgs[0])
	if err != nil {
		t.Fatalf("Receive(m1) error: %v", err)
	}
	if len(delivered) != 5 {
		t.Fatalf("delivered %d messages, want 5", len(delivered))
	}
	for i, d := range delivered {
		if d.ID != msgs[i].ID {
			t.Fatalf("delivered[%d] = %v, want %v (causal order)", i, d.ID, msgs[i].ID)
		}
	}
	if got := b.Used(); got != 0 {
		t.Fatalf("Used after full delivery = %d, want 0 (all bytes released)", got)
	}
}

func TestDuplicateReceiveIsFree(t *testing.T) {
	a := NewNode(0, 2, 0)
	b := NewNode(1, 2, 10)

	m1 := a.Send(payload(4))
	m2 := a.Send(payload(4))

	for i := 0; i < 3; i++ {
		if _, err := b.Receive(m2); err != nil {
			t.Fatalf("duplicate Receive(m2) error: %v", err)
		}
	}
	if got := b.Used(); got != 4 {
		t.Fatalf("duplicates counted multiple times: Used = %d, want 4", got)
	}
	if _, err := b.Receive(m1); err != nil {
		t.Fatalf("Receive(m1) error: %v", err)
	}
	for i := 0; i < 2; i++ {
		delivered, err := b.Receive(m1)
		if err != nil || len(delivered) != 0 {
			t.Fatalf("re-Receive(m1) = %v, %v; want no-op", delivered, err)
		}
	}
	if got := b.Used(); got != 0 {
		t.Fatalf("Used = %d, want 0", got)
	}
}

func TestMissingChainReport(t *testing.T) {
	a := NewNode(0, 3, 100)
	b := NewNode(1, 3, 100)
	c := NewNode(2, 3, 100)

	a1 := a.Send(payload(1))
	a2 := a.Send(payload(1))
	a3 := a.Send(payload(1))

	// b sees a1, then broadcasts b1 depending on it.
	if _, err := b.Receive(a1); err != nil {
		t.Fatalf("b.Receive(a1) error: %v", err)
	}
	b1 := b.Send(payload(1))

	// c receives a3 and a2 (a1 absent) and b1 (depends on a1).
	for _, m := range []Message{a3, a2, b1} {
		if _, err := c.Receive(m); err != nil {
			t.Fatalf("c.Receive(%v) error: %v", m.ID, err)
		}
	}

	// Direct gaps for a3: only a1 is absent; a2 is pending.
	gaps, ok := c.Missing(a3.ID)
	if !ok {
		t.Fatal("Missing(a3) not found")
	}
	if want := []Gap{{Sender: 0, From: 1, To: 2}}; !reflect.DeepEqual(gaps, want) {
		t.Fatalf("Missing(a3) = %v, want %v", gaps, want)
	}

	// Complete chain from a3: a1 is absent, a2 is pending and itself
	// reports a1 absent.
	chain, ok := c.Report(a3.ID)
	if !ok {
		t.Fatal("Report(a3) not found")
	}
	if want := []Gap{{Sender: 0, From: 1, To: 1}}; !reflect.DeepEqual(chain.Absent, want) {
		t.Fatalf("a3.Absent = %v, want %v", chain.Absent, want)
	}
	if want := []MessageID{a2.ID}; !reflect.DeepEqual(chain.Pending, want) {
		t.Fatalf("a3.Pending = %v, want %v", chain.Pending, want)
	}
	if len(chain.Children) != 1 || chain.Children[0].ID != a2.ID {
		t.Fatalf("a3.Children = %+v, want chain through a2", chain.Children)
	}
	if want := []Gap{{Sender: 0, From: 1, To: 1}}; !reflect.DeepEqual(chain.Children[0].Absent, want) {
		t.Fatalf("a2.Absent = %v, want %v", chain.Children[0].Absent, want)
	}

	// b1 is blocked only on the absent a1 (cross-sender dependency).
	bchain, ok := c.Report(b1.ID)
	if !ok {
		t.Fatal("Report(b1) not found")
	}
	if want := []Gap{{Sender: 0, From: 1, To: 1}}; !reflect.DeepEqual(bchain.Absent, want) {
		t.Fatalf("b1.Absent = %v, want %v", bchain.Absent, want)
	}
	if len(bchain.Pending) != 0 {
		t.Fatalf("b1.Pending = %v, want none", bchain.Pending)
	}

	// Unknown IDs report as not pending.
	if _, ok := c.Missing(a1.ID); ok {
		t.Fatal("Missing(a1) should be false: a1 never received")
	}
	if _, ok := c.Report(a1.ID); ok {
		t.Fatal("Report(a1) should be false: a1 never received")
	}

	// Delivering a1 unblocks the whole chain.
	delivered, err := c.Receive(a1)
	if err != nil {
		t.Fatalf("c.Receive(a1) error: %v", err)
	}
	if len(delivered) != 4 {
		t.Fatalf("delivered %d messages, want 4", len(delivered))
	}
	if got := c.Used(); got != 0 {
		t.Fatalf("Used after chain unblocked = %d, want 0", got)
	}
}
