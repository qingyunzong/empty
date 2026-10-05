package fefo

import (
	"fmt"
	"sort"
	"time"
)

// DayBalance 是逐日库存模型中某 SKU 某日的结存行。
type DayBalance struct {
	Date  time.Time
	SKU   string
	Begin int
	In    int
	Out   int
	Ret   int
	Scrap int
	End   int
}

// DailyModel 独立于批次状态，仅由流量逐日滚动结存：
// End = Begin + In - Out + Ret，次日 Begin 承接前日 End。
// Scrap 是备忘列：过期退货本已出库、不再回到在库，故不扣减结存，
// 只在全局守恒式中体现（入库 = 在库 + 净出库 + 报废）。
func DailyModel(flows []Flow) []DayBalance {
	fs := append([]Flow(nil), flows...)
	sort.Slice(fs, func(i, j int) bool {
		if !fs[i].Date.Equal(fs[j].Date) {
			return fs[i].Date.Before(fs[j].Date)
		}
		return fs[i].SKU < fs[j].SKU
	})
	type key struct {
		Date time.Time
		SKU  string
	}
	agg := map[key]*Flow{}
	var order []key
	for _, f := range fs {
		k := key{f.Date, f.SKU}
		a, ok := agg[k]
		if !ok {
			a = &Flow{Date: f.Date, SKU: f.SKU}
			agg[k] = a
			order = append(order, k)
		}
		a.In += f.In
		a.Out += f.Out
		a.Ret += f.Ret
		a.Scrap += f.Scrap
	}
	carry := map[string]int{}
	var rows []DayBalance
	for _, k := range order {
		a := agg[k]
		begin := carry[k.SKU]
		end := begin + a.In - a.Out + a.Ret
		rows = append(rows, DayBalance{
			Date: k.Date, SKU: k.SKU,
			Begin: begin, In: a.In, Out: a.Out, Ret: a.Ret, Scrap: a.Scrap, End: end,
		})
		carry[k.SKU] = end
	}
	return rows
}

// Reconcile 核对引擎批次状态与逐日库存模型守恒：
//  1. 每日每 SKU：End = Begin + In - Out + Ret - Scrap；
//  2. 末日每 SKU 结存 = 引擎批次在库之和；
//  3. 全局：累计入库 = 在库 + 净出库 + 报废。
func Reconcile(e *Engine) error {
	rows := DailyModel(e.Flows)
	lastEnd := map[string]int{}
	for _, r := range rows {
		if r.End != r.Begin+r.In-r.Out+r.Ret {
			return fmt.Errorf("守恒破坏: %s %s 日结 %d != %d+%d-%d+%d",
				r.Date.Format("2006-01-02"), r.SKU, r.End, r.Begin, r.In, r.Out, r.Ret)
		}
		if r.End < 0 {
			return fmt.Errorf("守恒破坏: %s %s 日结为负 %d",
				r.Date.Format("2006-01-02"), r.SKU, r.End)
		}
		lastEnd[r.SKU] = r.End
	}
	onHand := map[string]int{}
	for _, b := range e.Batches {
		onHand[b.SKU] += b.OnHand
	}
	for sku, end := range lastEnd {
		if onHand[sku] != end {
			return fmt.Errorf("守恒破坏: SKU %s 模型结存 %d != 批次在库 %d", sku, end, onHand[sku])
		}
	}
	in, oh, shipped, scrap := e.Totals()
	if in != oh+shipped+scrap {
		return fmt.Errorf("守恒破坏: 入库 %d != 在库 %d + 净出库 %d + 报废 %d", in, oh, shipped, scrap)
	}
	return nil
}
