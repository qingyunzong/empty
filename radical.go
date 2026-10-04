package statmatch

import "math/big"

// Radical is an exact real number of the form Num·√Sqr/Den with
// Den > 0, Sqr ≥ 1 squarefree (see splitSquare), and
// gcd(|Num|, Den) = 1. Sqr == 1 means the value is rational.
type Radical struct {
	Num *big.Int
	Den *big.Int
	Sqr *big.Int
}

func (r Radical) String() string {
	if r.Num == nil || r.Num.Sign() == 0 {
		return "0"
	}
	one := big.NewInt(1)
	num := r.Num.String()
	if r.Sqr.Cmp(one) == 0 {
		if r.Den.Cmp(one) == 0 {
			return num
		}
		return num + "/" + r.Den.String()
	}
	coeff := num
	switch num {
	case "1":
		coeff = ""
	case "-1":
		coeff = "-"
	}
	body := coeff + "√" + r.Sqr.String()
	if r.Den.Cmp(one) == 0 {
		return body
	}
	return body + "/" + r.Den.String()
}

func radicalEqual(p, q Radical) bool {
	return p.Num.Cmp(q.Num) == 0 && p.Den.Cmp(q.Den) == 0 && p.Sqr.Cmp(q.Sqr) == 0
}

// correlation returns the exact Pearson correlation
// cov/√(varX·varY) in simplified radical form. varX and varY must be
// positive.
func correlation(cov, varX, varY *big.Int) Radical {
	if cov.Sign() == 0 {
		return Radical{big.NewInt(0), big.NewInt(1), big.NewInt(1)}
	}
	p := new(big.Int).Mul(varX, varY)
	s, d := splitSquare(p)
	// cov/(s·√d) = cov·√d/(s·d)
	den := new(big.Int).Mul(s, d)
	num := new(big.Int).Set(cov)
	g := new(big.Int).GCD(nil, nil, new(big.Int).Abs(new(big.Int).Set(num)), den)
	num.Quo(num, g)
	den.Quo(den, g)
	return Radical{num, den, d}
}

// factorBound is the trial-division bound used by splitSquare.
const factorBound = 1_000_000

var primes = sieve(factorBound)

func sieve(n int) []int64 {
	composite := make([]bool, n+1)
	var ps []int64
	for i := 2; i <= n; i++ {
		if composite[i] {
			continue
		}
		ps = append(ps, int64(i))
		for j := 2 * i; j <= n; j += i {
			composite[j] = true
		}
	}
	return ps
}

// splitSquare writes p > 0 as s²·d with d squarefree. Square factors
// composed of primes up to factorBound are extracted exactly, as is any
// perfect-square cofactor; a remaining cofactor whose prime factors all
// exceed factorBound is treated as squarefree.
func splitSquare(p *big.Int) (s, d *big.Int) {
	s = big.NewInt(1)
	d = new(big.Int).Set(p)
	bp := new(big.Int)
	q, r := new(big.Int), new(big.Int)
	one := big.NewInt(1)
	for _, pr := range primes {
		if d.Cmp(one) == 0 {
			break
		}
		bp.SetInt64(pr)
		if bp.Cmp(d) > 0 {
			break
		}
		e := 0
		for {
			q.QuoRem(d, bp, r)
			if r.Sign() != 0 {
				break
			}
			d.Set(q)
			e++
		}
		if e == 0 {
			continue
		}
		if e%2 == 1 {
			d.Mul(d, bp)
		}
		if h := e / 2; h > 0 {
			s.Mul(s, new(big.Int).Exp(bp, big.NewInt(int64(h)), nil))
		}
	}
	// Extract a perfect-square cofactor exactly.
	sqrt := new(big.Int).Sqrt(d)
	if new(big.Int).Mul(sqrt, sqrt).Cmp(d) == 0 {
		s.Mul(s, sqrt)
		d.SetInt64(1)
	}
	return s, d
}
