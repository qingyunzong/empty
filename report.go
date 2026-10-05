package fefo

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// OrderLine 是每单批次来源报表中的一行。
type OrderLine struct {
	Date    time.Time
	BatchID string
	Expiry  time.Time
	Qty     int // 正=出库，负=退货
	Note    string
}

// OrderReport 汇总一个订单跨日期的全部批次来源与退货去向。
type OrderReport struct {
	OrderID string
	SKU     string
	Lines   []OrderLine
	Shipped int // 净出库
}

// OrderReport 生成指定订单的批次来源报表。
func (e *Engine) OrderReport(orderID string) OrderReport {
	rep := OrderReport{OrderID: orderID}
	for _, a := range e.Allocs {
		if a.OrderID != orderID {
			continue
		}
		rep.SKU = a.SKU
		rep.Lines = append(rep.Lines, OrderLine{
			Date: a.Date, BatchID: a.BatchID,
			Expiry: e.Batches[a.BatchID].Expiry, Qty: a.Qty,
		})
	}
	for _, r := range e.Returns {
		if r.OrderID != orderID {
			continue
		}
		note := "退货恢复原批"
		if !r.Restored {
			note = "退货已过期归报废"
		}
		rep.Lines = append(rep.Lines, OrderLine{
			Date: r.Date, BatchID: r.BatchID,
			Expiry: e.Batches[r.BatchID].Expiry, Qty: -r.Qty, Note: note,
		})
	}
	sort.SliceStable(rep.Lines, func(i, j int) bool {
		return rep.Lines[i].Date.Before(rep.Lines[j].Date)
	})
	rep.Shipped = e.shipped[orderID]
	return rep
}

// String 渲染报表为对齐文本。
func (r OrderReport) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "订单 %s SKU %s 净出库 %d\n", r.OrderID, r.SKU, r.Shipped)
	fmt.Fprintf(&b, "%-10s  %-8s  %-10s  %5s  %s\n", "日期", "批次", "到期日", "数量", "备注")
	for _, l := range r.Lines {
		fmt.Fprintf(&b, "%-10s  %-8s  %-10s  %+5d  %s\n",
			l.Date.Format("2006-01-02"), l.BatchID, l.Expiry.Format("2006-01-02"), l.Qty, l.Note)
	}
	return b.String()
}
