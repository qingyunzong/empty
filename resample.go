// Package resample resamples a stream of (time, value) points with rational
// timestamps and values onto a fixed-interval grid anchored at an explicit
// origin, using piecewise linear interpolation.
//
// Contract:
//   - The output grid is origin, origin+step, origin+2*step, ... with a
//     positive rational step. All arithmetic is exact (math/big.Rat).
//   - Consecutive points form segments; grid times inside a segment are
//     linearly interpolated. A grid time equal to a known point yields that
//     point's exact value.
//   - Break ends the current run: the gap to the next run is a missing
//     segment and is never interpolated across.
//   - There is no extrapolation: nothing is emitted before the first point
//     or after the last point of a run. End signals the end of input; the
//     tail without a right endpoint stays empty even after End.
//   - Input times must be strictly increasing across the whole stream,
//     including across breaks. Add after End panics.
package resample

import (
	"fmt"
	"math/big"
)

// Point is an input sample with rational time and value.
type Point struct {
	T *big.Rat
	V *big.Rat
}

// Sample is an output grid point with rational time and interpolated value.
type Sample struct {
	T *big.Rat
	V *big.Rat
}

// Resampler is a streaming resampler. It is not safe for concurrent use.
type Resampler struct {
	origin *big.Rat
	step   *big.Rat
	gcur   *big.Rat // time of the next unresolved grid point

	open  bool     // current run has a pending last point
	lastT *big.Rat // last point of the current run
	lastV *big.Rat
	maxT  *big.Rat // greatest accepted time so far, nil before first Add
	ended bool
}

// New returns a Resampler emitting grid points origin, origin+step, ....
// It panics if origin or step is nil or step is not positive.
func New(origin, step *big.Rat) *Resampler {
	if origin == nil || step == nil {
		panic("resample: nil origin or step")
	}
	if step.Sign() <= 0 {
		panic("resample: step must be positive")
	}
	return &Resampler{
		origin: new(big.Rat).Set(origin),
		step:   new(big.Rat).Set(step),
		gcur:   new(big.Rat).Set(origin),
	}
}

// Add feeds one point and returns the grid samples that become determined
// by it, in increasing time order. It panics on nil arguments, on a time
// not strictly greater than every previously added time, or after End.
func (r *Resampler) Add(t, v *big.Rat) []Sample {
	if r.ended {
		panic("resample: Add after End")
	}
	if t == nil || v == nil {
		panic("resample: nil time or value")
	}
	if r.maxT != nil && t.Cmp(r.maxT) <= 0 {
		panic(fmt.Sprintf("resample: non-increasing time %s after %s", t.RatString(), r.maxT.RatString()))
	}
	t = new(big.Rat).Set(t)
	v = new(big.Rat).Set(v)

	var out []Sample
	if !r.open {
		// First point ever, or first point of a run after a break: grid
		// times before t are missing (no head extrapolation, no
		// interpolation across a gap) and are skipped.
		r.skipBefore(t)
		if r.gcur.Cmp(t) == 0 {
			out = append(out, Sample{new(big.Rat).Set(t), new(big.Rat).Set(v)})
			r.advance()
		}
	} else {
		// Segment [lastT, t]: emit every unresolved grid time up to t.
		for r.gcur.Cmp(t) <= 0 {
			out = append(out, Sample{
				T: new(big.Rat).Set(r.gcur),
				V: interp(r.lastT, r.lastV, t, v, r.gcur),
			})
			r.advance()
		}
	}
	r.open = true
	r.lastT, r.lastV = t, v
	r.maxT = t
	return out
}

// AddAll feeds a batch of points and returns all samples they determine.
// Feeding the same points in different chunkings yields the same output.
func (r *Resampler) AddAll(pts []Point) []Sample {
	var out []Sample
	for _, p := range pts {
		out = append(out, r.Add(p.T, p.V)...)
	}
	return out
}

// Break ends the current run. The gap until the next run's first point is
// a missing segment: no grid samples are produced inside it.
func (r *Resampler) Break() {
	if r.ended {
		panic("resample: Break after End")
	}
	r.open = false
}

// End signals the end of input. The tail beyond the last point has no
// right endpoint and is not extrapolated, so End produces no samples.
func (r *Resampler) End() {
	r.ended = true
	r.open = false
}

// skipBefore advances the grid cursor past all grid times strictly
// before t, in O(1) exact rational arithmetic.
func (r *Resampler) skipBefore(t *big.Rat) {
	if r.gcur.Cmp(t) >= 0 {
		return
	}
	// Smallest k >= 0 with origin + k*step >= t; here t > gcur >= origin.
	d := new(big.Rat).Sub(t, r.origin)
	q := new(big.Rat).Quo(d, r.step)
	k, rem := new(big.Int).QuoRem(q.Num(), q.Denom(), new(big.Int))
	if rem.Sign() != 0 {
		k.Add(k, big.NewInt(1))
	}
	r.gcur.Add(r.origin, new(big.Rat).Mul(r.step, new(big.Rat).SetInt(k)))
}

func (r *Resampler) advance() {
	r.gcur.Add(r.gcur, r.step)
}

// interp evaluates the line through (t1,v1)-(t2,v2) at g, exactly.
func interp(t1, v1, t2, v2, g *big.Rat) *big.Rat {
	frac := new(big.Rat).Quo(new(big.Rat).Sub(g, t1), new(big.Rat).Sub(t2, t1))
	dv := new(big.Rat).Sub(v2, v1)
	return new(big.Rat).Add(v1, dv.Mul(dv, frac))
}
