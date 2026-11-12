package dataeng

// tri is the three-valued-logic truth value of a boolean expression:
// triFalse, triTrue, or triUnknown (the result of comparing a null).
type tri uint8

const (
	triFalse tri = iota
	triTrue
	triUnknown
)

// triVec stores a per-row three-valued result as two packed bitmaps.
// A row is triUnknown when the unknown bit is set; otherwise it is
// triTrue exactly when the true bit is set, and triFalse when it is not.
type triVec struct {
	trueBits    []uint64
	unknownBits []uint64
	rows        int
}

func newTriVec(rows int) *triVec {
	words := (rows + 63) / 64
	return &triVec{
		trueBits:    make([]uint64, words),
		unknownBits: make([]uint64, words),
		rows:        rows,
	}
}

func (v *triVec) set(row int, value tri) {
	word := uint(row) >> 6
	mask := uint64(1) << (uint(row) & 63)
	// Write the full state: a row's truth value can change as more operators
	// are applied, so stale true/unknown bits must be cleared first.
	v.trueBits[word] &^= mask
	v.unknownBits[word] &^= mask
	switch value {
	case triTrue:
		v.trueBits[word] |= mask
	case triUnknown:
		v.unknownBits[word] |= mask
	}
}

func (v *triVec) get(row int) tri {
	word := uint(row) >> 6
	mask := uint64(1) << (uint(row) & 63)
	if v.unknownBits[word]&mask != 0 {
		return triUnknown
	}
	if v.trueBits[word]&mask != 0 {
		return triTrue
	}
	return triFalse
}

// and3 and or3 implement Kleene three-valued logic. False dominates AND and
// true dominates OR; null participates as triUnknown.
func and3(a, b tri) tri {
	switch {
	case a == triFalse || b == triFalse:
		return triFalse
	case a == triUnknown || b == triUnknown:
		return triUnknown
	default:
		return triTrue
	}
}

func or3(a, b tri) tri {
	switch {
	case a == triTrue || b == triTrue:
		return triTrue
	case a == triUnknown || b == triUnknown:
		return triUnknown
	default:
		return triFalse
	}
}

func not3(a tri) tri {
	switch a {
	case triTrue:
		return triFalse
	case triFalse:
		return triTrue
	default:
		return triUnknown
	}
}
