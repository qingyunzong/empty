// Package settle converts order line amounts by rational exchange rates,
// rounds each line with half-even rounding before summing, recomputes
// remaining items for refunds, and applies discounts in an explicit order.
package settle

import (
	"fmt"
	"math/big"
	"strings"
)

// Frac is an exact rational number n/d with d > 0, normalized by gcd.
type Frac struct {
	n *big.Int
	d *big.Int
}

// NewFrac builds a normalized Frac from numerator and denominator.
// It panics on a zero denominator.
func NewFrac(n, d *big.Int) Frac {
	if d.Sign() == 0 {
		panic("settle: zero denominator")
	}
	nn := new(big.Int).Set(n)
	dd := new(big.Int).Set(d)
	if dd.Sign() < 0 {
		nn.Neg(nn)
		dd.Neg(dd)
	}
	g := new(big.Int).GCD(nil, nil, new(big.Int).Abs(nn), dd)
	nn.Quo(nn, g)
	dd.Quo(dd, g)
	return Frac{n: nn, d: dd}
}

// FracFromInt64 builds a Frac from an integer.
func FracFromInt64(v int64) Frac {
	return NewFrac(big.NewInt(v), big.NewInt(1))
}

// Zero returns the zero Frac.
func Zero() Frac { return Frac{n: new(big.Int), d: big.NewInt(1)} }

// ParseFrac parses "n/d" or a finite decimal like "-12.345" into a Frac.
func ParseFrac(s string) (Frac, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return Frac{}, fmt.Errorf("settle: empty number")
	}
	if i := strings.IndexByte(s, '/'); i >= 0 {
		n, ok1 := new(big.Int).SetString(strings.TrimSpace(s[:i]), 10)
		d, ok2 := new(big.Int).SetString(strings.TrimSpace(s[i+1:]), 10)
		if !ok1 || !ok2 {
			return Frac{}, fmt.Errorf("settle: invalid fraction %q", s)
		}
		return NewFrac(n, d), nil
	}
	neg := false
	if strings.HasPrefix(s, "-") {
		neg = true
		s = s[1:]
	} else if strings.HasPrefix(s, "+") {
		s = s[1:]
	}
	intPart, fracPart := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart, fracPart = s[:i], s[i+1:]
	}
	if intPart == "" {
		intPart = "0"
	}
	for _, c := range intPart + fracPart {
		if c < '0' || c > '9' {
			return Frac{}, fmt.Errorf("settle: invalid decimal %q", s)
		}
	}
	n, ok := new(big.Int).SetString(intPart+fracPart, 10)
	if !ok {
		return Frac{}, fmt.Errorf("settle: invalid decimal %q", s)
	}
	d := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(len(fracPart))), nil)
	if neg {
		n.Neg(n)
	}
	return NewFrac(n, d), nil
}

// MustParse is ParseFrac that panics on error; for tests and literals.
func MustParse(s string) Frac {
	f, err := ParseFrac(s)
	if err != nil {
		panic(err)
	}
	return f
}

// Num returns a copy of the normalized numerator.
func (f Frac) Num() *big.Int { return new(big.Int).Set(f.n) }

// Den returns a copy of the normalized denominator (always positive).
func (f Frac) Den() *big.Int { return new(big.Int).Set(f.d) }

// Sign returns -1, 0 or +1.
func (f Frac) Sign() int { return f.n.Sign() }

// IsZero reports whether f == 0.
func (f Frac) IsZero() bool { return f.n.Sign() == 0 }

// Add returns a+b.
func Add(a, b Frac) Frac {
	n := new(big.Int).Add(new(big.Int).Mul(a.n, b.d), new(big.Int).Mul(b.n, a.d))
	d := new(big.Int).Mul(a.d, b.d)
	return NewFrac(n, d)
}

// Sub returns a-b.
func Sub(a, b Frac) Frac { return Add(a, Neg(b)) }

// Mul returns a*b.
func Mul(a, b Frac) Frac {
	return NewFrac(new(big.Int).Mul(a.n, b.n), new(big.Int).Mul(a.d, b.d))
}

// Quo returns a/b. It panics if b is zero.
func Quo(a, b Frac) Frac {
	if b.IsZero() {
		panic("settle: division by zero")
	}
	return NewFrac(new(big.Int).Mul(a.n, b.d), new(big.Int).Mul(a.d, b.n))
}

// Neg returns -a.
func Neg(a Frac) Frac {
	return Frac{n: new(big.Int).Neg(a.n), d: new(big.Int).Set(a.d)}
}

// Cmp returns -1, 0 or +1 comparing a to b.
func Cmp(a, b Frac) int {
	l := new(big.Int).Mul(a.n, b.d)
	r := new(big.Int).Mul(b.n, a.d)
	return l.Cmp(r)
}

// String returns the normalized "n/d" form.
func (f Frac) String() string {
	if f.d.Cmp(big.NewInt(1)) == 0 {
		return f.n.String()
	}
	return f.n.String() + "/" + f.d.String()
}

// Decimal renders f with exactly scale fractional digits. It requires the
// value to be exactly representable at that scale and panics otherwise.
func (f Frac) Decimal(scale int) string {
	pow := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)
	num := new(big.Int).Mul(f.n, pow)
	q, r := new(big.Int).QuoRem(num, f.d, new(big.Int))
	if r.Sign() != 0 {
		panic(fmt.Sprintf("settle: %s not representable at scale %d", f.String(), scale))
	}
	neg := q.Sign() < 0
	digits := new(big.Int).Abs(q).String()
	if scale > 0 {
		for len(digits) <= scale {
			digits = "0" + digits
		}
		digits = digits[:len(digits)-scale] + "." + digits[len(digits)-scale:]
	}
	if neg {
		return "-" + digits
	}
	return digits
}

// RoundRule names the half-even decision taken for a line.
type RoundRule string

const (
	RuleExact     RoundRule = "exact"       // nothing discarded
	RuleDown      RoundRule = "down"        // discarded fraction below half
	RuleUp        RoundRule = "up"          // discarded fraction above half
	RuleTieToEven RoundRule = "tie-to-even" // exact half, rounded to even neighbor
)

// RoundEvidence documents one half-even rounding step.
type RoundEvidence struct {
	Scale        int       `json:"scale"`
	ExactN       string    `json:"exact_num"`     // normalized exact value
	ExactD       string    `json:"exact_den"`     //
	ScaledN      string    `json:"scaled_num"`    // exact * 10^scale, normalized
	ScaledD      string    `json:"scaled_den"`    //
	Quotient     string    `json:"quotient"`      // scaled value truncated toward zero
	RemainderN   string    `json:"remainder_num"` // scaled - quotient, sign follows value
	RemainderD   string    `json:"remainder_den"` //
	HalfCmp      int       `json:"half_cmp"`      // cmp(2*|remainder|, 1): -1, 0, +1
	Rule         RoundRule `json:"rule"`          // decision taken
	RoundedN     string    `json:"rounded_num"`   // result as RoundedN / 10^scale
	RoundedScale int       `json:"rounded_scale"` // == Scale
}

// RoundHalfEven rounds f to the given decimal scale using banker's
// (half-even) rounding and returns the rounded value plus full evidence.
// The returned Frac keeps denominator 10^scale (unnormalized on purpose).
func RoundHalfEven(f Frac, scale int) (Frac, RoundEvidence) {
	if scale < 0 {
		panic("settle: negative scale")
	}
	pow := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)

	sn := new(big.Int).Mul(f.n, pow)
	sd := new(big.Int).Set(f.d)
	g := new(big.Int).GCD(nil, nil, new(big.Int).Abs(sn), sd)
	sn.Quo(sn, g)
	sd.Quo(sd, g)

	q, r := new(big.Int).QuoRem(sn, sd, new(big.Int)) // truncates toward zero
	halfCmp := new(big.Int).Mul(new(big.Int).Abs(r), big.NewInt(2)).Cmp(sd)

	rule := RuleExact
	switch {
	case r.Sign() == 0:
		// exact, q unchanged
	case halfCmp > 0:
		q.Add(q, big.NewInt(int64(sn.Sign())))
		rule = RuleUp
	case halfCmp < 0:
		rule = RuleDown
	default: // exact tie: pick the even neighbor
		rule = RuleTieToEven
		if new(big.Int).And(q, big.NewInt(1)).Sign() != 0 {
			q.Add(q, big.NewInt(int64(sn.Sign())))
		}
	}

	ev := RoundEvidence{
		Scale:        scale,
		ExactN:       f.n.String(),
		ExactD:       f.d.String(),
		ScaledN:      sn.String(),
		ScaledD:      sd.String(),
		Quotient:     new(big.Int).Quo(sn, sd).String(),
		RemainderN:   r.String(),
		RemainderD:   sd.String(),
		HalfCmp:      halfCmp,
		Rule:         rule,
		RoundedN:     q.String(),
		RoundedScale: scale,
	}
	return Frac{n: q, d: pow}, ev
}
