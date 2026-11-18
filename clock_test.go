package formal

import (
	"testing"
	"time"
)

// TestTTLAndExpiry exercises deadline extension and expiry under a manually
// advanced clock through the public API.
func TestTTLAndExpiry(t *testing.T) {
	clock, now := freshClock()
	sink := NewFencingStore()
	m := NewManager(sink, WithClock(clock), WithTTL(time.Minute))

	a, err := m.Acquire("o", "A")
	if err != nil {
		t.Fatal(err)
	}
	original := a.Deadline

	*now = now.Add(30 * time.Second)
	a2, err := m.Renew(a)
	if err != nil {
		t.Fatalf("renew before expiry: %v", err)
	}
	if !a2.Deadline.After(original) {
		t.Fatalf("renew did not extend deadline: %v vs %v", a2.Deadline, original)
	}

	// Past the renewed deadline: renewals and flushes are refused, steal wins.
	*now = a2.Deadline.Add(time.Second)
	if _, err := m.Renew(a2); err != ErrNotHeld {
		t.Fatalf("expired renew err = %v, want ErrNotHeld", err)
	}
	b, err := m.Steal("o", "B")
	if err != nil {
		t.Fatalf("steal after expiry: %v", err)
	}
	if b.Epoch <= a2.Epoch || b.Holder != "B" {
		t.Fatalf("steal lease = %+v", b)
	}
	if _, err := m.Renew(a2); err != ErrStaleToken {
		t.Fatalf("old receipt after steal err = %v", err)
	}
}
