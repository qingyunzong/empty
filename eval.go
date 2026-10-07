package poly

import "math/big"

// Eval evaluates p at the given integer point, returning an exact rational.
func (p *Poly) Eval(vals [MaxVars]*big.Int) *big.Rat {
	acc := new(big.Rat)
	pow := new(big.Int)
	e := new(big.Int)
	for m, c := range p.terms {
		term := new(big.Rat).Set(c)
		for i, exp := range m {
			if exp == 0 {
				continue
			}
			pow.Exp(vals[i], e.SetInt64(int64(exp)), nil)
			term.Mul(term, new(big.Rat).SetInt(pow))
		}
		acc.Add(acc, term)
	}
	return acc
}

// EvalInts is a convenience wrapper around Eval for int64 values.
func (p *Poly) EvalInts(vals ...int64) *big.Rat {
	var pt [MaxVars]*big.Int
	for i := range pt {
		pt[i] = new(big.Int)
	}
	for i, v := range vals {
		pt[i].SetInt64(v)
	}
	return p.Eval(pt)
}
