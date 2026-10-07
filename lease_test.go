package forward

import "testing"

func TestUnreleasedLeasePreventsReuse(t *testing.T) {
	p := NewPool()
	c := p.Get(8)
	id := c.ID()

	// Two destinations share the original block.
	l1 := c.Lease()
	l2 := c.Lease()

	// Publisher and one destination release; one lease is still out.
	c.Release()
	l1.Release()
	if got := p.InUse(); got != 1 {
		t.Fatalf("InUse = %d, want 1 while a lease is outstanding", got)
	}

	// The pool must not hand the same block back.
	c2 := p.Get(8)
	if c2.ID() == id {
		t.Fatalf("block %d recycled while a lease was still held", id)
	}
	c2.Release()

	// Dropping the final lease makes the block recyclable again.
	l2.Release()
	if got := p.InUse(); got != 0 {
		t.Fatalf("InUse = %d, want 0 after all leases released", got)
	}
	c3 := p.Get(4)
	if c3.ID() != id && c3.ID() != c2.ID() {
		t.Fatalf("expected a recycled block, got new id %d", c3.ID())
	}
	c3.Release()
}

func TestLeaseDataSharedAcrossHolders(t *testing.T) {
	p := NewPool()
	c := p.Get(3)
	copy(c.Data, "abc")
	l := c.Lease()
	if string(l.Data) != "abc" || l.ID() != c.ID() {
		t.Fatalf("lease does not share the original block")
	}
	c.Release()
	l.Release()
}
