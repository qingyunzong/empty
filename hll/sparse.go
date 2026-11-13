package hll

import (
	"math/bits"
	"sort"
)

// Sparse encoding (HLL++): values are 32-bit words derived from the top
// sparsePrecision (25) bits of the hash.
//
//   - If any of the low (sparsePrecision - p) bits of the 25-bit index is
//     set, the value is idx<<1 and rho at precision p is recoverable from
//     those bits alone.
//   - Otherwise the value is idx<<7 | rhoW<<1 | 1, where rhoW is the rho of
//     the remaining 64-25 hash bits.

// encodeHash encodes a 64-bit hash as a sparse value valid at precision p.
func encodeHash(h uint64, p uint8) uint32 {
	idx := uint32(h >> (64 - sparsePrecision))
	k := uint8(sparsePrecision - p)
	if idx&(1<<k-1) != 0 {
		return idx << 1
	}
	rhoW := uint8(bits.LeadingZeros64((h<<sparsePrecision)|(1<<(sparsePrecision-1))) + 1)
	return idx<<7 | uint32(rhoW)<<1 | 1
}

// decodeValue resolves a sparse value to its register index and rho at
// precision p.
func decodeValue(v uint32, p uint8) (uint32, uint8) {
	k := uint8(sparsePrecision - p)
	if v&1 == 0 {
		idx := v >> 1
		extra := idx & (1<<k - 1)
		return idx >> k, k - uint8(bits.Len32(extra)) + 1
	}
	idx := v >> 7
	rhoW := uint8((v >> 1) & 0x3F)
	return idx >> k, uint8(k) + rhoW
}

// reencode rewrites a sparse value so it stays valid at the lower precision
// p2. The widened extra-bit window can turn a flagged value (all extra bits
// zero at the old precision) into an unflagged one when a folded bit is set;
// values never collide because only flagged values change form.
func reencode(v uint32, p2 uint8) uint32 {
	if v&1 == 0 {
		return v
	}
	idx := v >> 7
	rhoW := uint32((v >> 1) & 0x3F)
	k2 := uint8(sparsePrecision - p2)
	if idx&(1<<k2-1) != 0 {
		return idx << 1
	}
	return idx<<7 | rhoW<<1 | 1
}

// sparseList is a sorted, deduplicated list of encoded sparse values.
type sparseList struct {
	vals []uint32
}

func newSparseList() *sparseList { return &sparseList{} }

func (l *sparseList) len() int { return len(l.vals) }

func (l *sparseList) add(v uint32) {
	i := sort.Search(len(l.vals), func(i int) bool { return l.vals[i] >= v })
	if i < len(l.vals) && l.vals[i] == v {
		return
	}
	l.vals = append(l.vals, 0)
	copy(l.vals[i+1:], l.vals[i:])
	l.vals[i] = v
}

// merge unions other into l; both lists must be sorted. The result is
// order-independent, which keeps Merge commutative and associative.
func (l *sparseList) merge(other *sparseList) {
	if len(other.vals) == 0 {
		return
	}
	merged := make([]uint32, 0, len(l.vals)+len(other.vals))
	i, j := 0, 0
	for i < len(l.vals) && j < len(other.vals) {
		a, b := l.vals[i], other.vals[j]
		switch {
		case a < b:
			merged = append(merged, a)
			i++
		case a > b:
			merged = append(merged, b)
			j++
		default:
			merged = append(merged, a)
			i++
			j++
		}
	}
	merged = append(merged, l.vals[i:]...)
	merged = append(merged, other.vals[j:]...)
	l.vals = merged
}

func (l *sparseList) clone() *sparseList {
	out := &sparseList{vals: make([]uint32, len(l.vals))}
	copy(out.vals, l.vals)
	return out
}

// decodeTo folds the sparse values into dense registers at precision p.
func (l *sparseList) decodeTo(p uint8, regs []uint8) {
	for _, v := range l.vals {
		idx, rho := decodeValue(v, p)
		if rho > regs[idx] {
			regs[idx] = rho
		}
	}
}
