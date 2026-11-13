package dataeng

import (
	"errors"
	"fmt"
	"math"
)

var (
	ErrNoBudget           = errors.New("privacy: no budget configured for key")
	ErrInsufficientBudget = errors.New("privacy: insufficient privacy budget")
	ErrInvalidCost        = errors.New("privacy: invalid cost")
	ErrInvalidBudget      = errors.New("privacy: invalid budget")
	ErrReservationClosed  = errors.New("privacy: reservation already settled")
	ErrReservationExpired = errors.New("privacy: reservation expired")
)

// Key identifies an independent privacy budget ledger: the triple of
// dataset, user domain, and mechanism.
type Key struct {
	Dataset   string
	Domain    string
	Mechanism string
}

// Cost is the privacy cost of a single query. A query may carry a pure
// (epsilon, delta) cost, an RDP curve (alpha -> RDP epsilon), or both.
type Cost struct {
	Epsilon float64
	Delta   float64
	// RDP maps orders alpha (>1) to the Renyi divergence spent at that order.
	RDP map[float64]float64
}

func validateCurve(curve map[float64]float64) error {
	for alpha, eps := range curve {
		if alpha <= 1 || math.IsNaN(alpha) || math.IsInf(alpha, 0) {
			return fmt.Errorf("%w: RDP order %v must be finite and > 1", ErrInvalidCost, alpha)
		}
		if eps < 0 || math.IsNaN(eps) || math.IsInf(eps, 0) {
			return fmt.Errorf("%w: RDP epsilon at alpha=%v must be finite and >= 0", ErrInvalidCost, alpha)
		}
	}
	return nil
}

func (c Cost) validate() error {
	if c.Epsilon < 0 || math.IsNaN(c.Epsilon) || math.IsInf(c.Epsilon, 0) {
		return fmt.Errorf("%w: epsilon must be finite and >= 0", ErrInvalidCost)
	}
	if c.Delta < 0 || c.Delta > 1 || math.IsNaN(c.Delta) {
		return fmt.Errorf("%w: delta must be in [0, 1]", ErrInvalidCost)
	}
	return validateCurve(c.RDP)
}

func (c Cost) zero() bool {
	return c.Epsilon == 0 && c.Delta == 0 && len(c.RDP) == 0
}

// add returns the composition of two costs: pure DP costs add, and RDP
// curves add pointwise per order.
func add(a, b Cost) Cost {
	out := Cost{Epsilon: a.Epsilon + b.Epsilon, Delta: a.Delta + b.Delta}
	if len(a.RDP) > 0 || len(b.RDP) > 0 {
		out.RDP = make(map[float64]float64, len(a.RDP)+len(b.RDP))
		for alpha, eps := range a.RDP {
			out.RDP[alpha] = eps
		}
		for alpha, eps := range b.RDP {
			out.RDP[alpha] += eps
		}
	}
	return out
}

func (c Cost) clone() Cost {
	out := Cost{Epsilon: c.Epsilon, Delta: c.Delta}
	if len(c.RDP) > 0 {
		out.RDP = make(map[float64]float64, len(c.RDP))
		for alpha, eps := range c.RDP {
			out.RDP[alpha] = eps
		}
	}
	return out
}

// Budget caps the total privacy loss of a ledger. Epsilon and Delta cap the
// accumulated pure DP cost; RDP caps the composed Renyi divergence at each
// order. A zero Budget denies every non-zero spend.
type Budget struct {
	Epsilon float64
	Delta   float64
	// RDP maps orders alpha (>1) to the maximum composed RDP epsilon allowed
	// at that order.
	RDP map[float64]float64
}

func (b Budget) validate() error {
	if b.Epsilon < 0 || math.IsNaN(b.Epsilon) {
		return fmt.Errorf("%w: epsilon must be >= 0", ErrInvalidBudget)
	}
	if b.Delta < 0 || b.Delta > 1 || math.IsNaN(b.Delta) {
		return fmt.Errorf("%w: delta must be in [0, 1]", ErrInvalidBudget)
	}
	if err := validateCurve(b.RDP); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidBudget, err)
	}
	return nil
}

// fits reports whether total stays within the budget on every dimension.
func (b Budget) fits(total Cost) bool {
	if total.Epsilon > b.Epsilon || total.Delta > b.Delta {
		return false
	}
	for alpha, eps := range total.RDP {
		cap, ok := b.RDP[alpha]
		if !ok || eps > cap {
			return false
		}
	}
	return true
}
