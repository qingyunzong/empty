package interval

import (
	"fmt"
	"math/big"
	"strings"
)

// MaxVars is the maximum number of variables supported by grid
// enumeration.
const MaxVars = 6

// Certificate records the exact extrema of an expression over a finite
// grid, together with the witnessing assignments, so the result can be
// checked independently with Check or VerifyBounds.
type Certificate struct {
	Min, Max     *big.Rat   // extrema over defined points; nil if none
	MinAt, MaxAt []*big.Rat // assignments attaining Min and Max
	Defined      int        // grid points where the expression is defined
	Undefined    int        // grid points where it is undefined
}

// Total returns the number of enumerated grid points.
func (c Certificate) Total() int { return c.Defined + c.Undefined }

// AllUndef reports whether every grid point evaluated to undefined.
func (c Certificate) AllUndef() bool { return c.Defined == 0 }

func (c Certificate) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "points=%d defined=%d undefined=%d", c.Total(), c.Defined, c.Undefined)
	if !c.AllUndef() {
		fmt.Fprintf(&b, " min=%s at %s max=%s at %s",
			c.Min.RatString(), assignString(c.MinAt),
			c.Max.RatString(), assignString(c.MaxAt))
	}
	return b.String()
}

func assignString(env []*big.Rat) string {
	parts := make([]string, len(env))
	for i, r := range env {
		parts[i] = fmt.Sprintf("x%d=%s", i, r.RatString())
	}
	return "(" + strings.Join(parts, ", ") + ")"
}

// Enumerate evaluates e at every point of the cartesian product of
// grids and returns a certificate with the exact extrema. Because all
// points share the same assignment, shared-variable dependencies are
// respected, unlike in plain interval evaluation. At most MaxVars
// variables are supported.
func Enumerate(e Expr, grids [][]*big.Rat) (Certificate, error) {
	if len(grids) > MaxVars {
		return Certificate{}, fmt.Errorf("interval: at most %d variables, got %d", MaxVars, len(grids))
	}
	if n := NumVars(e); n > len(grids) {
		return Certificate{}, fmt.Errorf("interval: expression uses %d variables but %d grids given", n, len(grids))
	}
	for i, g := range grids {
		if len(g) == 0 {
			return Certificate{}, fmt.Errorf("interval: grid for variable %d is empty", i)
		}
	}
	var c Certificate
	env := make([]*big.Rat, len(grids))
	var rec func(k int)
	rec = func(k int) {
		if k == len(grids) {
			r, ok := Eval(e, env)
			if !ok {
				c.Undefined++
				return
			}
			c.Defined++
			if c.Min == nil || r.Cmp(c.Min) < 0 {
				c.Min = new(big.Rat).Set(r)
				c.MinAt = snapshot(env)
			}
			if c.Max == nil || r.Cmp(c.Max) > 0 {
				c.Max = new(big.Rat).Set(r)
				c.MaxAt = snapshot(env)
			}
			return
		}
		for _, p := range grids[k] {
			env[k] = p
			rec(k + 1)
		}
	}
	rec(0)
	return c, nil
}

func snapshot(env []*big.Rat) []*big.Rat {
	out := make([]*big.Rat, len(env))
	for i, r := range env {
		out[i] = new(big.Rat).Set(r)
	}
	return out
}

// Check re-enumerates e over grids and verifies that c matches the
// recomputed extrema, counts, and witnessing assignments exactly.
func (c Certificate) Check(e Expr, grids [][]*big.Rat) error {
	got, err := Enumerate(e, grids)
	if err != nil {
		return err
	}
	if c.Defined != got.Defined || c.Undefined != got.Undefined {
		return fmt.Errorf("interval: count mismatch: cert defined=%d undefined=%d, recomputed defined=%d undefined=%d",
			c.Defined, c.Undefined, got.Defined, got.Undefined)
	}
	if err := checkExtremum("min", c.Min, got.Min); err != nil {
		return err
	}
	if err := checkExtremum("max", c.Max, got.Max); err != nil {
		return err
	}
	if err := checkAssign("min", c.MinAt, got.MinAt); err != nil {
		return err
	}
	return checkAssign("max", c.MaxAt, got.MaxAt)
}

func checkExtremum(name string, cv, gv *big.Rat) error {
	switch {
	case cv == nil && gv == nil:
		return nil
	case cv == nil || gv == nil:
		return fmt.Errorf("interval: %s mismatch: cert %v, recomputed %v", name, cv, gv)
	case cv.Cmp(gv) != 0:
		return fmt.Errorf("interval: %s mismatch: cert %s, recomputed %s",
			name, cv.RatString(), gv.RatString())
	}
	return nil
}

func checkAssign(name string, ca, ga []*big.Rat) error {
	if len(ca) != len(ga) {
		return fmt.Errorf("interval: %s witness has %d coordinates, expected %d", name, len(ca), len(ga))
	}
	for i := range ca {
		if ca[i].Cmp(ga[i]) != 0 {
			return fmt.Errorf("interval: %s witness coordinate %d mismatch: cert %s, recomputed %s",
				name, i, ca[i].RatString(), ga[i].RatString())
		}
	}
	return nil
}

// VerifyBounds checks that every defined grid point of e lies within
// [lo, hi]. It returns an error describing the first violation found,
// which makes a claimed bound independently checkable.
func VerifyBounds(e Expr, grids [][]*big.Rat, lo, hi *big.Rat) error {
	c, err := Enumerate(e, grids)
	if err != nil {
		return err
	}
	if c.AllUndef() {
		return fmt.Errorf("interval: expression is undefined on every grid point")
	}
	if c.Min.Cmp(lo) < 0 {
		return fmt.Errorf("interval: lower bound violated: min %s at %s < %s",
			c.Min.RatString(), assignString(c.MinAt), lo.RatString())
	}
	if c.Max.Cmp(hi) > 0 {
		return fmt.Errorf("interval: upper bound violated: max %s at %s > %s",
			c.Max.RatString(), assignString(c.MaxAt), hi.RatString())
	}
	return nil
}
