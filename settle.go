package settle

import (
	"fmt"
)

// DiscountKind selects the discount type.
type DiscountKind int

const (
	// PercentOff subtracts Value percent (e.g. Value=10 means 10% off).
	PercentOff DiscountKind = iota
	// AmountOff subtracts a fixed amount in source currency.
	AmountOff
)

// Discount is a single price reduction.
type Discount struct {
	Kind  DiscountKind
	Value Frac
}

// Line is one order line in source currency.
type Line struct {
	ID        string
	UnitPrice Frac
	Qty       Frac
	Discounts []Discount // line-level
}

// Order is a full settlement request.
type Order struct {
	Lines     []Line
	Discounts []Discount // order-level
	Rate      Frac       // target currency units per 1 source unit
	Scale     int        // target currency decimal places
}

// Discount application order (explicit and fixed):
//
//  1. line-level PercentOff, in slice order
//  2. line-level AmountOff, in slice order, clamped at zero
//  3. order-level PercentOff, in slice order, applied to every line
//  4. order-level AmountOff, in slice order, allocated to lines
//     proportionally to their current amounts (exact rational split)
//
// Only after all discounts is the amount converted by Rate and rounded
// half-even at Scale; rounded lines are then summed.
func applyLineDiscounts(amount Frac, ds []Discount) Frac {
	for _, kind := range []DiscountKind{PercentOff, AmountOff} {
		for _, d := range ds {
			if d.Kind != kind {
				continue
			}
			amount = applyOne(amount, d)
		}
	}
	return amount
}

func applyOne(amount Frac, d Discount) Frac {
	switch d.Kind {
	case PercentOff:
		factor := Quo(Sub(FracFromInt64(100), d.Value), FracFromInt64(100))
		return Mul(amount, factor)
	case AmountOff:
		if Cmp(amount, d.Value) <= 0 {
			return Zero()
		}
		return Sub(amount, d.Value)
	}
	panic("settle: unknown discount kind")
}

// lineAmounts computes each line's exact post-discount source amount.
func lineAmounts(o Order) []Frac {
	amounts := make([]Frac, len(o.Lines))
	for i, l := range o.Lines {
		amounts[i] = applyLineDiscounts(Mul(l.UnitPrice, l.Qty), l.Discounts)
	}
	for _, kind := range []DiscountKind{PercentOff, AmountOff} {
		for _, d := range o.Discounts {
			if d.Kind != kind {
				continue
			}
			if kind == PercentOff {
				for i := range amounts {
					amounts[i] = applyOne(amounts[i], d)
				}
				continue
			}
			// AmountOff: exact proportional allocation over current amounts.
			sum := Zero()
			for _, a := range amounts {
				sum = Add(sum, a)
			}
			if sum.IsZero() {
				break
			}
			cut := d.Value
			if Cmp(cut, sum) > 0 {
				cut = sum
			}
			keep := Quo(Sub(sum, cut), sum) // exact factor (sum-cut)/sum
			for i := range amounts {
				amounts[i] = Mul(amounts[i], keep)
			}
		}
	}
	return amounts
}

// LineResult carries one line's amounts and rounding evidence.
type LineResult struct {
	LineID     string        `json:"line_id"`
	SourceN    string        `json:"source_num"` // post-discount source amount
	SourceD    string        `json:"source_den"`
	ConvertedN string        `json:"converted_num"` // exact converted amount
	ConvertedD string        `json:"converted_den"`
	Rounding   RoundEvidence `json:"rounding"`
	RoundedN   string        `json:"rounded_num"` // rounded line = RoundedN / 10^Scale
	RoundedD   string        `json:"rounded_den"`
	Rounded    string        `json:"rounded"` // decimal rendering
}

// Result is a settled order: per-line evidence plus the rounded total.
type Result struct {
	Scale  int          `json:"scale"`
	Lines  []LineResult `json:"lines"`
	TotalN string       `json:"total_num"` // sum of rounded lines
	TotalD string       `json:"total_den"`
	Total  string       `json:"total"` // decimal rendering at Scale
}

// Settle converts and rounds every line, then sums the rounded values.
func Settle(o Order) Result {
	amounts := lineAmounts(o)
	res := Result{Scale: o.Scale, Lines: make([]LineResult, len(o.Lines))}
	total := Zero()
	for i, a := range amounts {
		conv := Mul(a, o.Rate)
		rounded, ev := RoundHalfEven(conv, o.Scale)
		res.Lines[i] = LineResult{
			LineID:     o.Lines[i].ID,
			SourceN:    a.Num().String(),
			SourceD:    a.Den().String(),
			ConvertedN: conv.Num().String(),
			ConvertedD: conv.Den().String(),
			Rounding:   ev,
			RoundedN:   rounded.Num().String(),
			RoundedD:   rounded.Den().String(),
			Rounded:    rounded.Decimal(o.Scale),
		}
		total = Add(total, rounded)
	}
	res.TotalN = total.Num().String()
	res.TotalD = total.Den().String()
	res.Total = total.Decimal(o.Scale)
	return res
}

// RefundResult reports a refund as original total minus remaining total.
type RefundResult struct {
	Original  Result `json:"original"`
	Remaining Result `json:"remaining"`
	RefundN   string `json:"refund_num"`
	RefundD   string `json:"refund_den"`
	Refund    string `json:"refund"`
}

// RemainingOrder returns the order with the returned quantities removed.
// Returned quantities are keyed by line ID and must not exceed the
// original quantities.
func RemainingOrder(o Order, returned map[string]Frac) (Order, error) {
	rem := o
	rem.Lines = make([]Line, len(o.Lines))
	copy(rem.Lines, o.Lines)
	for id, q := range returned {
		if q.Sign() < 0 {
			return Order{}, fmt.Errorf("settle: negative returned qty for line %q", id)
		}
		found := false
		for i := range rem.Lines {
			if rem.Lines[i].ID == id {
				if Cmp(q, rem.Lines[i].Qty) > 0 {
					return Order{}, fmt.Errorf("settle: returned qty %s exceeds line %q qty %s", q.String(), id, rem.Lines[i].Qty.String())
				}
				rem.Lines[i].Qty = Sub(rem.Lines[i].Qty, q)
				found = true
			}
		}
		if !found {
			return Order{}, fmt.Errorf("settle: unknown line %q in refund", id)
		}
	}
	return rem, nil
}

// Refund recomputes the settlement of the remaining items with the same
// rate, scale and discounts, and returns the difference against the
// original settlement.
func Refund(original Order, returned map[string]Frac) (RefundResult, error) {
	rem, err := RemainingOrder(original, returned)
	if err != nil {
		return RefundResult{}, err
	}
	origRes := Settle(original)
	remRes := Settle(rem)
	refund := Sub(MustParse(origRes.TotalN+"/"+origRes.TotalD), MustParse(remRes.TotalN+"/"+remRes.TotalD))
	return RefundResult{
		Original:  origRes,
		Remaining: remRes,
		RefundN:   refund.Num().String(),
		RefundD:   refund.Den().String(),
		Refund:    refund.Decimal(original.Scale),
	}, nil
}
