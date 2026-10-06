package main

import (
	"math/big"
)

// DefaultBlock is the default chunk size used by Column.
const DefaultBlock = 64

// Column maintains per-row rounding deltas for a column of exact decimal
// amounts. The invariant is: for every k, the sum of the first k deltas
// equals round-half-even of the exact sum of the first k amounts (scaled
// by 10^scale). Each row's delta is the difference of adjacent rounded
// cumulative sums.
//
// Values are stored in fixed-size blocks with cached exact block sums, so
// that after Append/Withdraw only the affected suffix is recomputed and
// the prefix base is rebuilt from block sums instead of rescanning every
// row from zero.
type Column struct {
	scale  int
	block  int
	vals   []*big.Rat // exact row values
	sums   []*big.Rat // sums[b] = exact sum of rows in block b
	deltas []*big.Int // cached deltas
	valid  int        // deltas[:valid] are up to date
}

// NewColumn creates an empty column with the given decimal scale.
func NewColumn(scale int) *Column {
	return &Column{scale: scale, block: DefaultBlock}
}

// Len returns the number of rows.
func (c *Column) Len() int { return len(c.vals) }

// Append adds a row with the exact value of d.
func (c *Column) Append(d Dec) {
	c.vals = append(c.vals, d.Rat())
	need := (len(c.vals) + c.block - 1) / c.block
	for len(c.sums) < need {
		c.sums = append(c.sums, new(big.Rat))
	}
	c.sums[need-1].Add(c.sums[need-1], c.vals[len(c.vals)-1])
	if c.valid > len(c.deltas) {
		c.valid = len(c.deltas)
	}
}

// Withdraw removes row i. All deltas from position i onward are
// invalidated and lazily recomputed on the next Deltas call.
func (c *Column) Withdraw(i int) {
	if i < 0 || i >= len(c.vals) {
		panic("column: withdraw index out of range")
	}
	c.vals = append(c.vals[:i], c.vals[i+1:]...)
	need := (len(c.vals) + c.block - 1) / c.block
	c.sums = c.sums[:need]
	// Membership of blocks from i's block onward shifted; rebuild their sums.
	for b := i / c.block; b < need; b++ {
		c.sums[b] = new(big.Rat)
		lo, hi := b*c.block, (b+1)*c.block
		if hi > len(c.vals) {
			hi = len(c.vals)
		}
		for k := lo; k < hi; k++ {
			c.sums[b].Add(c.sums[b], c.vals[k])
		}
	}
	if len(c.deltas) > len(c.vals) {
		c.deltas = c.deltas[:len(c.vals)]
	}
	if c.valid > i {
		c.valid = i
	}
}

// Deltas returns the per-row deltas. The result is a fresh slice; the
// returned integers must not be mutated by the caller.
func (c *Column) Deltas() []*big.Int {
	start := c.valid
	// Rebuild the exact prefix sum before `start` from cached block sums.
	base := new(big.Rat)
	fullBlocks := start / c.block
	for b := 0; b < fullBlocks; b++ {
		base.Add(base, c.sums[b])
	}
	for k := fullBlocks * c.block; k < start; k++ {
		base.Add(base, c.vals[k])
	}
	prev := QuantizeRat(base, c.scale)
	for k := start; k < len(c.vals); k++ {
		base.Add(base, c.vals[k])
		cur := QuantizeRat(base, c.scale)
		d := new(big.Int).Sub(cur, prev)
		if k < len(c.deltas) {
			c.deltas[k] = d
		} else {
			c.deltas = append(c.deltas, d)
		}
		prev = cur
	}
	c.valid = len(c.vals)
	out := make([]*big.Int, len(c.deltas))
	copy(out, c.deltas)
	return out
}

// NaiveDeltas is the straightforward reference: accumulate the exact
// rational running total and emit differences of adjacent rounded totals.
func NaiveDeltas(vals []Dec, scale int) []*big.Int {
	sum := new(big.Rat)
	prev := big.NewInt(0)
	out := make([]*big.Int, 0, len(vals))
	for _, v := range vals {
		sum.Add(sum, v.Rat())
		cur := QuantizeRat(sum, scale)
		out = append(out, new(big.Int).Sub(cur, prev))
		prev = cur
	}
	return out
}
