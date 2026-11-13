package dataeng

import (
	"fmt"
	"math"
	"sort"
)

// EpsilonForDelta converts a composed RDP curve to an (epsilon, delta) bound
// using the standard RDP-to-approximate-DP conversion
//
//	epsilon(delta) = min over alpha of rdp(alpha) + ln(1/delta) / (alpha - 1)
//
// and returns the tightest (smallest) epsilon across all orders present in
// the curve. It returns an error if delta is not in (0, 1) or the curve is
// empty.
func EpsilonForDelta(rdp map[float64]float64, delta float64) (float64, error) {
	if delta <= 0 || delta >= 1 || math.IsNaN(delta) {
		return 0, fmt.Errorf("%w: target delta must be in (0, 1)", ErrInvalidCost)
	}
	if len(rdp) == 0 {
		return 0, fmt.Errorf("%w: empty RDP curve", ErrInvalidCost)
	}
	if err := validateCurve(rdp); err != nil {
		return 0, err
	}
	logInvDelta := math.Log(1 / delta)
	best := math.Inf(1)
	for alpha, eps := range rdp {
		if candidate := eps + logInvDelta/(alpha-1); candidate < best {
			best = candidate
		}
	}
	return best, nil
}

// Alphas returns the orders of an RDP curve in ascending order, useful for
// deterministic reporting.
func Alphas(rdp map[float64]float64) []float64 {
	alphas := make([]float64, 0, len(rdp))
	for alpha := range rdp {
		alphas = append(alphas, alpha)
	}
	sort.Float64s(alphas)
	return alphas
}
