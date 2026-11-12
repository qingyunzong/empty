package dataeng

import (
	"errors"
	"fmt"
	"math/bits"
)

// ErrNotFound is returned by Select when the value is valid for the bit
// domain but does not occur (enough times) in the column.
var ErrNotFound = errors.New("wavelet: not found")

// ErrOutOfBounds is returned when an index, end, or range leaves [0, n].
var ErrOutOfBounds = errors.New("wavelet: out of bounds")

// ErrEmptyRange is returned when a quantile is requested over an empty range.
var ErrEmptyRange = errors.New("wavelet: empty range")

const wordBits = 64

// level is one bit layer of the wavelet matrix. Levels are ordered from the
// most significant bit (level 0) down to the least significant bit.
type level struct {
	bits  []uint64 // bitmap of the layer's bit over the current sequence
	ones  []int    // ones[w] = number of 1-bits in words [0, w)
	zeros int      // number of 0-bits in this layer
}

func (lv *level) bit(i int) int {
	return int((lv.bits[i/wordBits] >> uint(i%wordBits)) & 1)
}

// rank1 returns the number of 1-bits in positions [0, pos).
func (lv *level) rank1(pos int) int {
	if pos == 0 {
		return 0
	}
	w := pos / wordBits
	off := uint(pos % wordBits)
	return lv.ones[w] + bits.OnesCount64(lv.bits[w]&((uint64(1)<<off)-1))
}

// rank0 returns the number of 0-bits in positions [0, pos).
func (lv *level) rank0(pos int) int {
	return pos - lv.rank1(pos)
}

// select1 returns the position of the t-th 1-bit (t is 1-based).
func (lv *level) select1(t int) int {
	w := 0
	for w+1 < len(lv.ones) && lv.ones[w+1] < t {
		w++
	}
	rem := t - lv.ones[w]
	word := lv.bits[w]
	for i := 0; i < wordBits; i++ {
		if (word>>uint(i))&1 == 1 {
			rem--
			if rem == 0 {
				return w*wordBits + i
			}
		}
	}
	return -1
}

// select0 returns the position of the t-th 0-bit (t is 1-based).
func (lv *level) select0(t int) int {
	w := 0
	for w+1 < len(lv.ones) && (w+1)*wordBits-lv.ones[w+1] < t {
		w++
	}
	rem := t - (w*wordBits - lv.ones[w])
	word := ^lv.bits[w]
	for i := 0; i < wordBits; i++ {
		if (word>>uint(i))&1 == 1 {
			rem--
			if rem == 0 {
				return w*wordBits + i
			}
		}
	}
	return -1
}

// WaveletMatrix is a wavelet matrix over a column of b-bit unsigned integers.
// It answers access/rank/select/range-quantile queries purely by navigating
// the per-level bitmaps; the original column is not retained.
type WaveletMatrix struct {
	b      int
	n      int
	levels []level
}

// NewWaveletMatrix builds the index over values, each of which must fit in b
// bits (1 <= b <= 32).
func NewWaveletMatrix(values []uint64, b int) (*WaveletMatrix, error) {
	if b < 1 || b > 32 {
		return nil, fmt.Errorf("wavelet: bit width %d out of [1, 32]", b)
	}
	var limit uint64 = 1 << uint(b)
	for i, v := range values {
		if v >= limit {
			return nil, fmt.Errorf("wavelet: value %d at row %d exceeds %d-bit domain", v, i, b)
		}
	}
	wm := &WaveletMatrix{b: b, n: len(values), levels: make([]level, b)}
	cur := make([]uint64, len(values))
	copy(cur, values)
	next := make([]uint64, len(values))
	for d := 0; d < b; d++ {
		shift := uint(b - 1 - d)
		nw := (len(values) + wordBits - 1) / wordBits
		lv := level{bits: make([]uint64, nw), ones: make([]int, nw+1)}
		zeroCount := 0
		for i, v := range cur {
			if (v>>shift)&1 == 1 {
				lv.bits[i/wordBits] |= uint64(1) << uint(i%wordBits)
			} else {
				zeroCount++
			}
		}
		for w := 0; w < nw; w++ {
			lv.ones[w+1] = lv.ones[w] + bits.OnesCount64(lv.bits[w])
		}
		lv.zeros = zeroCount
		zi, oi := 0, zeroCount
		for _, v := range cur {
			if (v>>shift)&1 == 1 {
				next[oi] = v
				oi++
			} else {
				next[zi] = v
				zi++
			}
		}
		cur, next = next, cur
		wm.levels[d] = lv
	}
	return wm, nil
}

// Len returns the number of rows in the column.
func (wm *WaveletMatrix) Len() int { return wm.n }

// NumLevels returns the bit width b, i.e. the number of bitmap layers.
func (wm *WaveletMatrix) NumLevels() int { return wm.b }

// Zeros returns the number of 0-bits recorded at the given layer.
func (wm *WaveletMatrix) Zeros(lv int) int { return wm.levels[lv].zeros }

// Bit returns the bitmap bit (0 or 1) at position i of the given layer.
func (wm *WaveletMatrix) Bit(lv, i int) int { return wm.levels[lv].bit(i) }

// TotalBits returns the total number of bitmap bits across all layers.
func (wm *WaveletMatrix) TotalBits() int { return wm.b * wm.n }

func (wm *WaveletMatrix) outOfDomain(v uint64) bool {
	return wm.b < 64 && v >= (uint64(1)<<uint(wm.b))
}

// At returns the value stored at original row i.
func (wm *WaveletMatrix) At(i int) (uint64, error) {
	if i < 0 || i >= wm.n {
		return 0, ErrOutOfBounds
	}
	pos := i
	var v uint64
	for d := 0; d < wm.b; d++ {
		lv := &wm.levels[d]
		if lv.bit(pos) == 1 {
			v |= uint64(1) << uint(wm.b-1-d)
			pos = lv.zeros + lv.rank1(pos)
		} else {
			pos = lv.rank0(pos)
		}
	}
	return v, nil
}

// Rank returns how many of the first end original rows equal value. A value
// outside the b-bit domain yields 0.
func (wm *WaveletMatrix) Rank(value uint64, end int) (int, error) {
	if end < 0 || end > wm.n {
		return 0, ErrOutOfBounds
	}
	if wm.outOfDomain(value) {
		return 0, nil
	}
	l, r := 0, end
	for d := 0; d < wm.b; d++ {
		lv := &wm.levels[d]
		if (value>>uint(wm.b-1-d))&1 == 1 {
			l = lv.zeros + lv.rank1(l)
			r = lv.zeros + lv.rank1(r)
		} else {
			l = lv.rank0(l)
			r = lv.rank0(r)
		}
	}
	return r - l, nil
}

// Select returns the original row of the k-th (0-based) occurrence of value.
// It returns ErrNotFound for values outside the b-bit domain and for valid
// values occurring at most k times.
func (wm *WaveletMatrix) Select(value uint64, k int) (int, error) {
	if k < 0 {
		return 0, ErrOutOfBounds
	}
	if wm.outOfDomain(value) {
		return 0, ErrNotFound
	}
	l, r := 0, wm.n
	for d := 0; d < wm.b; d++ {
		lv := &wm.levels[d]
		if (value>>uint(wm.b-1-d))&1 == 1 {
			l = lv.zeros + lv.rank1(l)
			r = lv.zeros + lv.rank1(r)
		} else {
			l = lv.rank0(l)
			r = lv.rank0(r)
		}
	}
	if k >= r-l {
		return 0, ErrNotFound
	}
	pos := l + k
	for d := wm.b - 1; d >= 0; d-- {
		lv := &wm.levels[d]
		if (value>>uint(wm.b-1-d))&1 == 1 {
			pos = lv.select1(pos - lv.zeros + 1)
		} else {
			pos = lv.select0(pos + 1)
		}
	}
	return pos, nil
}

// RangeKth returns the k-th (0-based) smallest value among original rows
// [l, r).
func (wm *WaveletMatrix) RangeKth(l, r, k int) (uint64, error) {
	if l < 0 || r > wm.n || l > r {
		return 0, ErrOutOfBounds
	}
	if l == r {
		return 0, ErrEmptyRange
	}
	if k < 0 || k >= r-l {
		return 0, ErrOutOfBounds
	}
	var v uint64
	for d := 0; d < wm.b; d++ {
		lv := &wm.levels[d]
		zl, zr := lv.rank0(l), lv.rank0(r)
		if k < zr-zl {
			l, r = zl, zr
		} else {
			k -= zr - zl
			v |= uint64(1) << uint(wm.b-1-d)
			l = lv.zeros + (l - zl)
			r = lv.zeros + (r - zr)
		}
	}
	return v, nil
}
