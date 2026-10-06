package srx

import "testing"

// With modulus 8 the window must be < 4, so every live sequence number
// stays within +-3 of the reference and resolution is unambiguous.
func TestResolveSeq(t *testing.T) {
	const m = 8
	cases := []struct{ wire, ref, want int }{
		{0, 0, 0}, {3, 0, 3}, {7, 0, -1}, {6, 0, -2}, {5, 0, -3},
		{5, 6, 5}, {7, 6, 7}, {0, 6, 8}, {1, 6, 9}, {2, 6, 10}, {4, 6, 4},
		{1, 254, 257}, {5, 254, 253}, {7, 254, 255},
	}
	for _, c := range cases {
		if got := resolveSeq(c.wire, c.ref, m); got != c.want {
			t.Errorf("resolveSeq(%d, %d, %d) = %d, want %d", c.wire, c.ref, m, got, c.want)
		}
	}
}

func TestWindowValidation(t *testing.T) {
	if _, err := NewSender(8, 4, 1, 1); err == nil {
		t.Error("window == modulus/2 must be rejected")
	}
	if _, err := NewSender(8, 5, 1, 1); err == nil {
		t.Error("window > modulus/2 must be rejected")
	}
	if _, err := NewSender(8, 0, 1, 1); err == nil {
		t.Error("window 0 must be rejected")
	}
	if _, err := NewSender(8, 3, 1, 1); err != nil {
		t.Errorf("window 3 with modulus 8 must be accepted: %v", err)
	}
	if _, err := NewReceiver(9, 4); err != nil {
		t.Errorf("window 4 with modulus 9 must be accepted: %v", err)
	}
	if _, err := NewReceiver(7, 4); err == nil {
		t.Error("window 4 with modulus 7 must be rejected")
	}
}
