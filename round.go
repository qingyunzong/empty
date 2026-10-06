package main

import (
	"fmt"
	"math/big"
	"sync"
)

var (
	pow10Mu    sync.Mutex
	pow10Cache = map[int]*big.Int{0: big.NewInt(1)}
)

// pow10 returns 10^n for n >= 0.
func pow10(n int) *big.Int {
	pow10Mu.Lock()
	defer pow10Mu.Unlock()
	if p, ok := pow10Cache[n]; ok {
		return new(big.Int).Set(p)
	}
	max := 0
	for k := range pow10Cache {
		if k <= n && k > max {
			max = k
		}
	}
	p := new(big.Int).Set(pow10Cache[max])
	ten := big.NewInt(10)
	for i := max; i < n; i++ {
		p.Mul(p, ten)
	}
	pow10Cache[n] = new(big.Int).Set(p)
	return p
}

// RoundHalfEvenRat rounds an exact rational to the nearest integer,
// ties to even. This is the reference implementation used both by the
// column logic and by tests cross-checking Dec.Quantize.
func RoundHalfEvenRat(r *big.Rat) *big.Int {
	num := r.Num()
	neg := num.Sign() < 0
	a := new(big.Int).Abs(num)
	q := roundHalfEvenQuotient(a, r.Denom())
	if neg {
		q.Neg(q)
	}
	return q
}

// QuantizeRat returns round-half-even of r * 10^scale as an integer.
func QuantizeRat(r *big.Rat, scale int) *big.Int {
	scaled := new(big.Rat).Set(r)
	if scale >= 0 {
		scaled.Mul(scaled, new(big.Rat).SetInt(pow10(scale)))
	} else {
		scaled.Quo(scaled, new(big.Rat).SetInt(pow10(-scale)))
	}
	return RoundHalfEvenRat(scaled)
}

// PosError ties a conversion failure to its input position.
type PosError struct {
	Index int
	Err   error
}

func (e PosError) Error() string { return fmt.Sprintf("index %d: %v", e.Index, e.Err) }

// ConvertAll parses and quantizes every literal. Elements that fail are
// reported as PosErrors carrying their original position; no position is
// ever dropped or renumbered.
func ConvertAll(literals []string, scale int) ([]*big.Int, []PosError) {
	out := make([]*big.Int, len(literals))
	var errs []PosError
	for i, lit := range literals {
		d, err := Parse(lit)
		if err != nil {
			errs = append(errs, PosError{Index: i, Err: err})
			continue
		}
		out[i] = d.Quantize(scale)
	}
	return out, errs
}
