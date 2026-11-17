package formal

// VClock is a version vector (vector clock) keyed by replica node ID.
// Each entry counts the writes originating from that node.
type VClock map[string]int64

// Get returns the counter for node, or zero when absent.
func (c VClock) Get(node string) int64 { return c[node] }

// Copy returns an independent copy of the clock.
func (c VClock) Copy() VClock {
	out := make(VClock, len(c))
	for node, tick := range c {
		out[node] = tick
	}
	return out
}

// Increment returns a new clock with node's counter advanced by one.
func (c VClock) Increment(node string) VClock {
	out := c.Copy()
	out[node] = out[node] + 1
	return out
}

// MergeClocks returns the component-wise maximum of a and b.
func MergeClocks(a, b VClock) VClock {
	out := a.Copy()
	for node, tick := range b {
		if tick > out[node] {
			out[node] = tick
		}
	}
	return out
}

// Descends reports whether a causally dominates or equals b (a >= b on
// every component). A nil clock only descends another nil/empty clock.
func Descends(a, b VClock) bool {
	for node, tick := range b {
		if a[node] < tick {
			return false
		}
	}
	return true
}

// EqualClocks reports whether two clocks carry the same counters.
func EqualClocks(a, b VClock) bool {
	return Descends(a, b) && Descends(b, a)
}

// Concurrent reports whether neither clock causally dominates the other,
// i.e. the two events happened in parallel.
func Concurrent(a, b VClock) bool {
	return !Descends(a, b) && !Descends(b, a)
}
