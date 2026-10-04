package main

// bitset is a fixed-length set of element indices backed by uint64 words.
type bitset struct {
	w []uint64
}

func newBitset(n int) bitset {
	return bitset{w: make([]uint64, (n+63)/64)}
}

func (b bitset) set(i int) {
	b.w[i>>6] |= 1 << (uint(i) & 63)
}

func (b bitset) test(i int) bool {
	return b.w[i>>6]&(1<<(uint(i)&63)) != 0
}

// or unions o into b in place.
func (b bitset) or(o bitset) {
	for i := range b.w {
		b.w[i] |= o.w[i]
	}
}

// andNot returns a new bitset with elements of b that are not in o.
func (b bitset) andNot(o bitset) bitset {
	r := newBitset(len(b.w) * 64)
	for i := range b.w {
		r.w[i] = b.w[i] &^ o.w[i]
	}
	return r
}

func (b bitset) count() int {
	n := 0
	for _, w := range b.w {
		for w != 0 {
			w &= w - 1
			n++
		}
	}
	return n
}

// covers reports whether b is a superset of o.
func (b bitset) covers(o bitset) bool {
	for i := range b.w {
		if o.w[i]&^b.w[i] != 0 {
			return false
		}
	}
	return true
}

func (b bitset) empty() bool {
	for _, w := range b.w {
		if w != 0 {
			return false
		}
	}
	return true
}

func (b bitset) clone() bitset {
	r := newBitset(len(b.w) * 64)
	copy(r.w, b.w)
	return r
}

// indices returns the set bit positions in ascending order.
func (b bitset) indices() []int {
	var out []int
	for i := range b.w {
		w := b.w[i]
		for w != 0 {
			t := w & (-w)
			out = append(out, i*64+bitLenMinus1(t))
			w ^= t
		}
	}
	return out
}

func bitLenMinus1(v uint64) int {
	// position of the single set bit in v
	n := 0
	for v > 1 {
		v >>= 1
		n++
	}
	return n
}
