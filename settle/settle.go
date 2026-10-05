package settle

import (
	"fmt"
	"math/big"
)

// Line 是订单的一行。金额均为源币种的精确有理数。
type Line struct {
	ID string
	// Qty 数量，UnitPrice 单价（源币种）。
	Qty       Frac
	UnitPrice Frac
	// PercentOff 百分比折扣，如 1/10 表示九折（减 10%）。可为零值 Frac{} 表示无折扣。
	percentOffSet bool
	PercentOff    Frac
	// AmountOff 固定金额减免（源币种），在百分比折扣之后应用。
	amountOffSet bool
	AmountOff    Frac
}

// NewLine 构造一行；percentOff 与 amountOff 可为 nil 表示无该项优惠。
func NewLine(id string, qty, unitPrice, percentOff, amountOff *Frac) Line {
	l := Line{ID: id, Qty: *qty, UnitPrice: *unitPrice}
	if percentOff != nil {
		l.PercentOff = *percentOff
		l.percentOffSet = true
	}
	if amountOff != nil {
		l.AmountOff = *amountOff
		l.amountOffSet = true
	}
	return l
}

// DiscountOrder 文档化优惠应用顺序。
const DiscountOrder = "1) percent-off, 2) fixed-amount-off (per line, source currency), then 3) FX conversion, then 4) half-even rounding"

// NetAmount 返回该行优惠后的精确金额（源币种，未换算未舍入）：
// qty*unitPrice 先乘 (1 - PercentOff)，再减 AmountOff。
func (l Line) NetAmount() Frac {
	gross := l.Qty.Mul(l.UnitPrice)
	if l.percentOffSet {
		one := FracFromInt(1)
		gross = gross.Mul(one.Sub(l.PercentOff))
	}
	if l.amountOffSet {
		gross = gross.Sub(l.AmountOff)
	}
	return gross
}

// LineResult 是一行的结算结果与证据。
type LineResult struct {
	LineID string
	// NetSource 是优惠后的源币种精确金额。
	NetSource Frac
	// Converted 是乘以汇率后的目标币种精确金额（舍入前）。
	Converted Frac
	// MinorUnits 是半偶舍入后的目标币种最小单位整数。
	MinorUnits *big.Int
	// Evidence 是舍入证据。
	Evidence RoundEvidence
}

// Result 是一次结算的完整结果。
type Result struct {
	// Rate 是使用的汇率（目标币种/源币种）。
	Rate Frac
	// Scale 是目标币种小数位。
	Scale int
	Lines []LineResult
	// Total 是各行 MinorUnits 之和。
	Total *big.Int
}

// Settle 按固定流程结算：逐行优惠 → 乘汇率 → 逐行半偶舍入 → 合计。
func Settle(lines []Line, rate Frac, scale int) Result {
	res := Result{Rate: rate, Scale: scale, Total: big.NewInt(0)}
	for _, l := range lines {
		net := l.NetAmount()
		conv := net.Mul(rate)
		minor, ev := RoundHalfEven(conv, scale)
		res.Lines = append(res.Lines, LineResult{
			LineID:     l.ID,
			NetSource:  net,
			Converted:  conv,
			MinorUnits: minor,
			Evidence:   ev,
		})
		res.Total.Add(res.Total, minor)
	}
	return res
}

// RefundResult 是退款计算结果。
type RefundResult struct {
	// Original 是原订单完整结算结果。
	Original Result
	// Remaining 是剔除退款行后剩余项的重新结算结果。
	Remaining Result
	// RefundMinorUnits = Original.Total − Remaining.Total。
	RefundMinorUnits *big.Int
	// RefundedLineIDs 被退掉的行。
	RefundedLineIDs []string
}

// Refund 计算退款：对原订单剩余（未退）行重新完整结算，退款额为两者合计之差。
// refundedIDs 为要退掉的行 ID 集合。
func Refund(lines []Line, rate Frac, scale int, refundedIDs map[string]bool) (RefundResult, error) {
	seen := map[string]bool{}
	for _, l := range lines {
		if seen[l.ID] {
			return RefundResult{}, fmt.Errorf("settle: duplicate line id %q", l.ID)
		}
		seen[l.ID] = true
	}
	for id := range refundedIDs {
		if !seen[id] {
			return RefundResult{}, fmt.Errorf("settle: refunded line id %q not in order", id)
		}
	}
	original := Settle(lines, rate, scale)
	var remainingLines []Line
	var refunded []string
	for _, l := range lines {
		if refundedIDs[l.ID] {
			refunded = append(refunded, l.ID)
			continue
		}
		remainingLines = append(remainingLines, l)
	}
	remaining := Settle(remainingLines, rate, scale)
	return RefundResult{
		Original:         original,
		Remaining:        remaining,
		RefundMinorUnits: new(big.Int).Sub(original.Total, remaining.Total),
		RefundedLineIDs:  refunded,
	}, nil
}
