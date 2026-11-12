package dataeng

import (
	"math/big"
	"testing"
)

const (
	toyExpBits       = 3
	toyFracBits      = 2
	toyBias          = 3
	toyMaxFiniteBits = uint64((1<<toyExpBits-2)<<toyFracBits | (1<<toyFracBits - 1))
)

var toyFormat = binaryFormat{expBits: toyExpBits, fracBits: toyFracBits, bias: toyBias}
var toySearch = searchConfig{maxDigits: 4, qMin: -8, qMax: 8}

func toyValue(bits uint64) *big.Rat {
	e := (bits >> toyFracBits) & (1<<toyExpBits - 1)
	f := bits & (1<<toyFracBits - 1)
	var m *big.Int
	var exponent int
	if e == 0 {
		m = new(big.Int).SetUint64(f)
		exponent = 1 - toyBias - toyFracBits
	} else {
		m = new(big.Int).Lsh(big.NewInt(1), toyFracBits)
		m.Add(m, new(big.Int).SetUint64(f))
		exponent = int(e) - toyBias - toyFracBits
	}
	if exponent >= 0 {
		return new(big.Rat).SetInt(new(big.Int).Lsh(m, uint(exponent)))
	}
	return new(big.Rat).SetFrac(m, new(big.Int).Lsh(big.NewInt(1), uint(-exponent)))
}

func toyInterval(bits uint64) internalInterval {
	v := toyValue(bits)
	prev := new(big.Rat)
	if bits != 1 {
		prev = toyValue(bits - 1)
	}
	next := new(big.Rat)
	if bits == toyMaxFiniteBits {
		// The max finite toy encoding has exponent field 6, bias 3, and two
		// fraction bits: its virtual successor is 2^(6-3+1).
		next = new(big.Rat).SetInt(new(big.Int).Lsh(big.NewInt(1), 4))
	} else {
		next = toyValue(bits + 1)
	}
	lower := new(big.Rat).Add(v, prev)
	lower.Quo(lower, big.NewRat(2, 1))
	upper := new(big.Rat).Add(v, next)
	upper.Quo(upper, big.NewRat(2, 1))

	e := (bits >> toyFracBits) & (1<<toyExpBits - 1)
	f := bits & (1<<toyFracBits - 1)
	var m *big.Int
	if e == 0 {
		m = new(big.Int).SetUint64(f)
	} else {
		m = new(big.Int).Lsh(big.NewInt(1), toyFracBits)
		m.Add(m, new(big.Int).SetUint64(f))
	}
	even := m.Bit(0) == 0
	return internalInterval{
		lower:       lower,
		upper:       upper,
		lowerClosed: even,
		upperClosed: even && bits != toyMaxFiniteBits,
	}
}

type toyChoice struct {
	c    *big.Int
	q    int
	x    *big.Rat
	dist *big.Rat
}

func toyDecimalValue(c int64, q int) *big.Rat {
	p := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(absInt(q))), nil)
	if q >= 0 {
		return new(big.Rat).SetInt(new(big.Int).Mul(big.NewInt(c), p))
	}
	return new(big.Rat).SetFrac(big.NewInt(c), p)
}

func toyBetter(a, b toyChoice) bool {
	if cmp := a.dist.Cmp(b.dist); cmp != 0 {
		return cmp < 0
	}
	aEven := a.c.Bit(0) == 0
	bEven := b.c.Bit(0) == 0
	if aEven != bEven {
		return aEven
	}
	return a.x.Cmp(b.x) < 0
}

func toyContains(iv internalInterval, x *big.Rat) bool {
	lowerCmp := x.Cmp(iv.lower)
	if lowerCmp < 0 || (lowerCmp == 0 && !iv.lowerClosed) {
		return false
	}
	upperCmp := x.Cmp(iv.upper)
	return upperCmp < 0 || (upperCmp == 0 && iv.upperClosed)
}

// bruteForceToy enumerates every finite coefficient and exponent in the toy
// search domain. It deliberately does not use the production search helpers.
func bruteForceToy(bits uint64) (c *big.Int, q int, ok bool) {
	v := toyValue(bits)
	iv := toyInterval(bits)
	for n := 1; n <= toySearch.maxDigits; n++ {
		minC := int64(1)
		for i := 1; i < n; i++ {
			minC *= 10
		}
		maxC := minC*10 - 1
		var best toyChoice
		have := false
		for ci := minC; ci <= maxC; ci++ {
			if ci%10 == 0 {
				continue
			}
			for q := toySearch.qMin; q <= toySearch.qMax; q++ {
				x := toyDecimalValue(ci, q)
				if !toyContains(iv, x) {
					continue
				}
				dist := new(big.Rat).Sub(x, v)
				dist.Abs(dist)
				choice := toyChoice{
					c:    big.NewInt(ci),
					q:    q,
					x:    x,
					dist: dist,
				}
				if !have || toyBetter(choice, best) {
					best = choice
					have = true
				}
			}
		}
		if have {
			return best.c, best.q, true
		}
	}
	return nil, 0, false
}

func TestExhaustiveToyFormat(t *testing.T) {
	for bits := uint64(1); bits <= toyMaxFiniteBits; bits++ {
		wantC, wantQ, wantOK := bruteForceToy(bits)
		gotC, gotQ, gotIV, err := selectShortest(bits, toyFormat, toySearch)
		if (err == nil) != wantOK {
			t.Fatalf("bits %d: production ok=%v brute ok=%v err=%v", bits, err == nil, wantOK, err)
		}
		if !wantOK {
			continue
		}
		if gotC.Cmp(wantC) != 0 || gotQ != wantQ {
			t.Fatalf("bits %d: production c=%v q=%d; brute best c=%v q=%d", bits, gotC, gotQ, wantC, wantQ)
		}

		wantIV := toyInterval(bits)
		if gotIV.lower.Cmp(wantIV.lower) != 0 || gotIV.upper.Cmp(wantIV.upper) != 0 ||
			gotIV.lowerClosed != wantIV.lowerClosed || gotIV.upperClosed != wantIV.upperClosed {
			t.Fatalf("bits %d: interval mismatch", bits)
		}
		if !toyContains(wantIV, toyDecimalValue(wantC.Int64(), wantQ)) {
			t.Fatalf("bits %d: independently selected candidate is outside interval", bits)
		}
	}
}

func TestToyTieBreakExercisesEvenAndClosestRules(t *testing.T) {
	// This test checks the toy brute-force comparison itself against a
	// hand-built halfway case: 0.5 is equidistant from 0.4 and 0.6.
	a := toyChoice{
		c:    big.NewInt(4),
		q:    -1,
		x:    big.NewRat(4, 10),
		dist: big.NewRat(1, 10),
	}
	b := toyChoice{
		c:    big.NewInt(6),
		q:    -1,
		x:    big.NewRat(6, 10),
		dist: big.NewRat(1, 10),
	}
	if !toyBetter(a, b) {
		t.Fatal("even coefficient 4 should win a distance tie over 6")
	}

	c := toyChoice{
		c:    big.NewInt(5),
		q:    -1,
		x:    big.NewRat(5, 10),
		dist: big.NewRat(0, 1),
	}
	if !toyBetter(c, a) {
		t.Fatal("closer candidate should win before parity")
	}
}
