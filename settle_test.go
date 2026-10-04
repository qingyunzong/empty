package settle

import (
	"encoding/json"
	"strings"
	"testing"
)

func disc(kind DiscountKind, v string) Discount {
	return Discount{Kind: kind, Value: MustParse(v)}
}

func TestDiscountExplicitOrder(t *testing.T) {
	// Slice order is AmountOff first, but the explicit kind order applies
	// PercentOff first: 100 * 0.9 - 20 = 70 (not (100-20)*0.9 = 72).
	o := Order{
		Lines: []Line{{
			ID: "A", UnitPrice: MustParse("100"), Qty: FracFromInt64(1),
			Discounts: []Discount{disc(AmountOff, "20"), disc(PercentOff, "10")},
		}},
		Rate:  FracFromInt64(1),
		Scale: 2,
	}
	res := Settle(o)
	if res.Total != "70.00" {
		t.Fatalf("total = %s, want 70.00", res.Total)
	}
	if res.Lines[0].SourceN != "70" || res.Lines[0].SourceD != "1" {
		t.Fatalf("source = %s/%s, want 70/1", res.Lines[0].SourceN, res.Lines[0].SourceD)
	}
}

func TestOrderLevelAllocation(t *testing.T) {
	// Order-level AmountOff 25 split proportionally over 30 and 70:
	// 30*0.75 = 22.5, 70*0.75 = 52.5.
	o := Order{
		Lines: []Line{
			{ID: "A", UnitPrice: MustParse("30"), Qty: FracFromInt64(1)},
			{ID: "B", UnitPrice: MustParse("70"), Qty: FracFromInt64(1)},
		},
		Discounts: []Discount{disc(AmountOff, "25")},
		Rate:      FracFromInt64(1),
		Scale:     2,
	}
	res := Settle(o)
	if res.Lines[0].SourceN+"/"+res.Lines[0].SourceD != "45/2" {
		t.Fatalf("line A source = %s/%s, want 45/2", res.Lines[0].SourceN, res.Lines[0].SourceD)
	}
	if res.Lines[1].SourceN+"/"+res.Lines[1].SourceD != "105/2" {
		t.Fatalf("line B source = %s/%s, want 105/2", res.Lines[1].SourceN, res.Lines[1].SourceD)
	}
	if res.Total != "75.00" {
		t.Fatalf("total = %s, want 75.00", res.Total)
	}
}

func TestSettleGolden(t *testing.T) {
	// Rate 3/2, scale 2. A: 19.99*2 = 39.98 -> 59.97 exact.
	// B: 5.005 -> 7.5075 -> half-even up -> 7.51. Total 67.48.
	o := Order{
		Lines: []Line{
			{ID: "A", UnitPrice: MustParse("19.99"), Qty: FracFromInt64(2)},
			{ID: "B", UnitPrice: MustParse("5.005"), Qty: FracFromInt64(1)},
		},
		Rate:  MustParse("3/2"),
		Scale: 2,
	}
	res := Settle(o)
	if res.Lines[0].Rounded != "59.97" || res.Lines[0].Rounding.Rule != RuleExact {
		t.Fatalf("line A = %+v", res.Lines[0])
	}
	if res.Lines[1].Rounded != "7.51" || res.Lines[1].Rounding.Rule != RuleUp {
		t.Fatalf("line B = %+v", res.Lines[1])
	}
	if res.Lines[1].ConvertedN+"/"+res.Lines[1].ConvertedD != "3003/400" {
		t.Fatalf("line B converted = %s/%s", res.Lines[1].ConvertedN, res.Lines[1].ConvertedD)
	}
	if res.Total != "67.48" {
		t.Fatalf("total = %s, want 67.48", res.Total)
	}
	if res.TotalN != "1687" || res.TotalD != "25" {
		t.Fatalf("total frac = %s/%s, want 1687/25", res.TotalN, res.TotalD)
	}
}

func TestRefundRecomputesRemaining(t *testing.T) {
	// A: 0.005 rounds to 0.00 inside the original total. Refunding A
	// recomputes the remaining order, so the refund is exactly 0.00.
	o := Order{
		Lines: []Line{
			{ID: "A", UnitPrice: MustParse("0.005"), Qty: FracFromInt64(1)},
			{ID: "B", UnitPrice: MustParse("1.00"), Qty: FracFromInt64(1)},
		},
		Rate:  FracFromInt64(1),
		Scale: 2,
	}
	rr, err := Refund(o, map[string]Frac{"A": FracFromInt64(1)})
	if err != nil {
		t.Fatal(err)
	}
	if rr.Original.Total != "1.00" || rr.Remaining.Total != "1.00" || rr.Refund != "0.00" {
		t.Fatalf("orig=%s rem=%s refund=%s, want 1.00/1.00/0.00",
			rr.Original.Total, rr.Remaining.Total, rr.Refund)
	}

	// Partial quantity refund with a rate conversion.
	o2 := Order{
		Lines: []Line{
			{ID: "A", UnitPrice: MustParse("10.00"), Qty: FracFromInt64(3)},
		},
		Rate:  MustParse("7/3"),
		Scale: 2,
	}
	rr2, err := Refund(o2, map[string]Frac{"A": FracFromInt64(1)})
	if err != nil {
		t.Fatal(err)
	}
	// Original: 30 * 7/3 = 70.00. Remaining: 20 * 7/3 = 46.666.. -> 46.67.
	if rr2.Original.Total != "70.00" || rr2.Remaining.Total != "46.67" || rr2.Refund != "23.33" {
		t.Fatalf("orig=%s rem=%s refund=%s, want 70.00/46.67/23.33",
			rr2.Original.Total, rr2.Remaining.Total, rr2.Refund)
	}
}

func TestRefundErrors(t *testing.T) {
	o := Order{
		Lines: []Line{{ID: "A", UnitPrice: MustParse("1"), Qty: FracFromInt64(1)}},
		Rate:  FracFromInt64(1),
		Scale: 2,
	}
	if _, err := Refund(o, map[string]Frac{"B": FracFromInt64(1)}); err == nil {
		t.Error("expected error for unknown line")
	}
	if _, err := Refund(o, map[string]Frac{"A": FracFromInt64(2)}); err == nil {
		t.Error("expected error for excessive qty")
	}
}

func TestEvidenceJSON(t *testing.T) {
	o := Order{
		Lines: []Line{{ID: "A", UnitPrice: MustParse("0.125"), Qty: FracFromInt64(1)}},
		Rate:  FracFromInt64(1),
		Scale: 2,
	}
	res := Settle(o)
	b, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, key := range []string{
		`"exact_num":"1"`, `"exact_den":"8"`,
		`"scaled_num":"25"`, `"scaled_den":"2"`,
		`"quotient":"12"`, `"remainder_num":"1"`, `"remainder_den":"2"`,
		`"half_cmp":0`, `"rule":"tie-to-even"`,
		`"rounded_num":"12"`, `"total_num":"3"`, `"total_den":"25"`,
	} {
		if !strings.Contains(s, key) {
			t.Errorf("evidence JSON missing %s\n%s", key, s)
		}
	}
}
