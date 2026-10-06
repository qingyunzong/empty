// Package cumround implements column-level cumulative rounding.
//
// For a column of exact rational amounts, the per-row output deltas satisfy:
// the sum of the first k deltas equals round-half-even of the exact sum of
// the first k amounts at the given scale. Each row's output is the
// difference of adjacent rounded cumulative sums.
package cumround

import (
	"math/big"

	"jsonnum/decimal"
)

// State carries the running exact sum and the last rounded cumulative
// value, enabling chunked and incremental processing.
type State struct {
	scale int
	cum   *big.Rat
	prev  *big.Int
}

// NewState returns a State for the given decimal scale.
func NewState(scale int) *State {
	return &State{scale: scale, cum: new(big.Rat), prev: new(big.Int)}
}

// Append adds one amount and returns its delta: the difference between the
// rounded cumulative sums after and before the append.
func (s *State) Append(a *big.Rat) *big.Int {
	s.cum.Add(s.cum, a)
	cur := decimal.RoundRatHalfEven(s.cum, s.scale)
	d := new(big.Int).Sub(cur, s.prev)
	s.prev = cur
	return d
}

// Cum returns the rounded cumulative sum so far.
func (s *State) Cum() *big.Int { return new(big.Int).Set(s.prev) }

// Deltas computes the per-row deltas for a full column in one pass.
func Deltas(amounts []*big.Rat, scale int) []*big.Int {
	st := NewState(scale)
	out := make([]*big.Int, len(amounts))
	for i, a := range amounts {
		out[i] = st.Append(a)
	}
	return out
}

// Withdraw removes row i from the column and recomputes the deltas of all
// subsequent rows; deltas of rows before i are kept unchanged. It returns
// the remaining amounts and the full new delta slice.
func Withdraw(amounts []*big.Rat, deltas []*big.Int, scale, i int) ([]*big.Rat, []*big.Int) {
	rest := make([]*big.Rat, 0, len(amounts)-1)
	rest = append(rest, amounts[:i]...)
	rest = append(rest, amounts[i+1:]...)

	out := make([]*big.Int, len(rest))
	copy(out, deltas[:i])

	// Rebuild the exact cumulative sum of the kept prefix, then recompute
	// only the suffix deltas.
	st := NewState(scale)
	for _, a := range amounts[:i] {
		st.Append(a)
	}
	for j := i; j < len(rest); j++ {
		out[j] = st.Append(rest[j])
	}
	return rest, out
}
