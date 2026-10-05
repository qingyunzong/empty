package fefo

import (
	"strings"
	"testing"
	"time"
)

func d(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func replay(t *testing.T, j *Journal) *Engine {
	t.Helper()
	e, err := Replay(j.Resolve())
	if err != nil {
		t.Fatalf("重放失败: %v", err)
	}
	return e
}

// FEFO：跨日期订单按最早到期日优先分配，过期批次被跳过。
func TestFEFOAllocationAcrossDates(t *testing.T) {
	var j Journal
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 10, BatchID: "B1", Expiry: d("2026-10-20")})
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 5, BatchID: "B2", Expiry: d("2026-10-05")})
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 8, BatchID: "B3", Expiry: d("2026-10-03")})
	// 第一天：先吃 B3(10-03) 再 B2(10-05)
	j.Append(Event{Date: d("2026-10-02"), Kind: KindOrder, SKU: "A", Qty: 10, OrderID: "O1"})
	// 跨日期：同一订单第二天继续履约；B3 已过期(10-03 < 10-04)不可用
	j.Append(Event{Date: d("2026-10-04"), Kind: KindOrder, SKU: "A", Qty: 3, OrderID: "O1"})

	e := replay(t, &j)
	rep := e.OrderReport("O1")
	want := []struct {
		batch string
		qty   int
	}{
		{"B3", 8}, {"B2", 2}, // 10-02
		{"B2", 3}, // 10-04，B3 已过期被跳过
	}
	if len(rep.Lines) != len(want) {
		t.Fatalf("来源行数 = %d, 期望 %d\n%s", len(rep.Lines), len(want), rep)
	}
	for i, w := range want {
		if rep.Lines[i].BatchID != w.batch || rep.Lines[i].Qty != w.qty {
			t.Errorf("第 %d 行 = %+v, 期望批次 %s 数量 %d", i, rep.Lines[i], w.batch, w.qty)
		}
	}
	if rep.Shipped != 13 {
		t.Errorf("净出库 = %d, 期望 13", rep.Shipped)
	}
	if got := e.Batches["B3"].OnHand; got != 0 {
		t.Errorf("B3 在库 = %d, 期望 0（剩余已过期但不可配）", got)
	}
	if err := Reconcile(e); err != nil {
		t.Fatal(err)
	}
}

// 退货：未到期恢复原批，已过期归报废。
func TestReturnRestoresOrScraps(t *testing.T) {
	var j Journal
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 10, BatchID: "B1", Expiry: d("2026-10-10")})
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 10, BatchID: "B2", Expiry: d("2026-10-03")})
	j.Append(Event{Date: d("2026-10-02"), Kind: KindOrder, SKU: "A", Qty: 12, OrderID: "O1"}) // B2x10 + B1x2
	// 退货日批次 B2 已过期(10-03 < 10-05) -> 报废；B1 未到期 -> 恢复
	j.Append(Event{Date: d("2026-10-05"), Kind: KindReturn, SKU: "A", Qty: 4, OrderID: "O1", BatchID: "B2"})
	j.Append(Event{Date: d("2026-10-05"), Kind: KindReturn, SKU: "A", Qty: 2, OrderID: "O1", BatchID: "B1"})

	e := replay(t, &j)
	if got := e.Batches["B1"].OnHand; got != 10 {
		t.Errorf("B1 在库 = %d, 期望 10（8+退货恢复2）", got)
	}
	if got := e.Batches["B2"].OnHand; got != 0 {
		t.Errorf("B2 在库 = %d, 期望 0（过期退货不得恢复）", got)
	}
	in, oh, shipped, scrap := e.Totals()
	if in != 20 || oh != 10 || shipped != 6 || scrap != 4 {
		t.Errorf("守恒量 = 入%d 库%d 出%d 废%d, 期望 20/10/6/4", in, oh, shipped, scrap)
	}
	var restored, scrapped int
	for _, r := range e.Returns {
		if r.Restored {
			restored += r.Qty
		} else {
			scrapped += r.Qty
		}
	}
	if restored != 2 || scrapped != 4 {
		t.Errorf("退货去向 = 恢复%d 报废%d, 期望 2/4", restored, scrapped)
	}
	if err := Reconcile(e); err != nil {
		t.Fatal(err)
	}
}

// 更正：替换历史收货的到期日后重放，下游分配随之改变；作废订单后库存回滚。
func TestCorrectionReplay(t *testing.T) {
	var j Journal
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 5, BatchID: "B1", Expiry: d("2026-10-08")})
	rcpt2 := j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 5, BatchID: "B2", Expiry: d("2026-10-06")})
	ord := j.Append(Event{Date: d("2026-10-02"), Kind: KindOrder, SKU: "A", Qty: 5, OrderID: "O1"})

	e := replay(t, &j)
	if e.Allocs[0].BatchID != "B2" {
		t.Fatalf("更正前应从 B2 分配, 实际 %s", e.Allocs[0].BatchID)
	}

	// 更正收货：B2 到期日改晚 -> FEFO 改从 B1 分配
	j.Append(Event{Date: d("2026-10-03"), Kind: KindCorrect, TargetID: rcpt2,
		Replace: &Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 5, BatchID: "B2", Expiry: d("2026-10-09")}})
	e = replay(t, &j)
	if e.Allocs[0].BatchID != "B1" {
		t.Fatalf("更正后应从 B1 分配, 实际 %s", e.Allocs[0].BatchID)
	}
	if err := Reconcile(e); err != nil {
		t.Fatal(err)
	}

	// 作废订单 -> 全部库存回滚
	j.Append(Event{Date: d("2026-10-04"), Kind: KindCorrect, TargetID: ord})
	e = replay(t, &j)
	if len(e.Allocs) != 0 {
		t.Fatalf("作废后不应有分配, 实际 %v", e.Allocs)
	}
	if e.Batches["B1"].OnHand != 5 || e.Batches["B2"].OnHand != 5 {
		t.Errorf("作废后在库应为 5/5, 实际 %d/%d", e.Batches["B1"].OnHand, e.Batches["B2"].OnHand)
	}
	if err := Reconcile(e); err != nil {
		t.Fatal(err)
	}
}

// 非法事件：超量分配、退错批次、超量退货、重复批次。
func TestInvalidEvents(t *testing.T) {
	var j Journal
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 5, BatchID: "B1", Expiry: d("2026-10-10")})
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 5, BatchID: "B1", Expiry: d("2026-10-10")})
	if _, err := Replay(j.Resolve()); err == nil || !strings.Contains(err.Error(), "重复入库") {
		t.Errorf("重复批次应报错, 实际 %v", err)
	}

	j = Journal{}
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 5, BatchID: "B1", Expiry: d("2026-10-10")})
	j.Append(Event{Date: d("2026-10-02"), Kind: KindOrder, SKU: "A", Qty: 6, OrderID: "O1"})
	if _, err := Replay(j.Resolve()); err == nil || !strings.Contains(err.Error(), "可用未到期库存仅") {
		t.Errorf("超量分配应报错, 实际 %v", err)
	}

	j = Journal{}
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 5, BatchID: "B1", Expiry: d("2026-10-10")})
	j.Append(Event{Date: d("2026-10-02"), Kind: KindOrder, SKU: "A", Qty: 3, OrderID: "O1"})
	j.Append(Event{Date: d("2026-10-03"), Kind: KindReturn, SKU: "A", Qty: 4, OrderID: "O1", BatchID: "B1"})
	if _, err := Replay(j.Resolve()); err == nil || !strings.Contains(err.Error(), "不足以退货") {
		t.Errorf("超量退货应报错, 实际 %v", err)
	}

	j = Journal{}
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 5, BatchID: "B1", Expiry: d("2026-10-10")})
	j.Append(Event{Date: d("2026-10-02"), Kind: KindOrder, SKU: "A", Qty: 3, OrderID: "O1"})
	j.Append(Event{Date: d("2026-10-03"), Kind: KindReturn, SKU: "A", Qty: 1, OrderID: "O1", BatchID: "B9"})
	if _, err := Replay(j.Resolve()); err == nil || !strings.Contains(err.Error(), "不存在") {
		t.Errorf("退错批次应报错, 实际 %v", err)
	}
}

// 综合场景：多 SKU、跨日期、退货、更正，逐日模型与批次状态守恒。
func TestConservationComprehensive(t *testing.T) {
	var j Journal
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 20, BatchID: "A1", Expiry: d("2026-10-04")})
	j.Append(Event{Date: d("2026-10-01"), Kind: KindReceipt, SKU: "A", Qty: 20, BatchID: "A2", Expiry: d("2026-10-12")})
	j.Append(Event{Date: d("2026-10-02"), Kind: KindReceipt, SKU: "B", Qty: 15, BatchID: "B1", Expiry: d("2026-10-06")})
	j.Append(Event{Date: d("2026-10-02"), Kind: KindOrder, SKU: "A", Qty: 25, OrderID: "O1"})
	j.Append(Event{Date: d("2026-10-03"), Kind: KindOrder, SKU: "B", Qty: 10, OrderID: "O2"})
	j.Append(Event{Date: d("2026-10-05"), Kind: KindOrder, SKU: "A", Qty: 5, OrderID: "O1"})                 // 跨日期，A1 已过期
	j.Append(Event{Date: d("2026-10-06"), Kind: KindReturn, SKU: "A", Qty: 3, OrderID: "O1", BatchID: "A1"}) // 已过期 -> 报废
	j.Append(Event{Date: d("2026-10-06"), Kind: KindReturn, SKU: "A", Qty: 2, OrderID: "O1", BatchID: "A2"}) // 未到期 -> 恢复
	j.Append(Event{Date: d("2026-10-07"), Kind: KindReturn, SKU: "B", Qty: 4, OrderID: "O2", BatchID: "B1"}) // 到期日当天未过期 -> 恢复

	e := replay(t, &j)
	if err := Reconcile(e); err != nil {
		t.Fatal(err)
	}
	// 逐日核对 SKU A 的结存
	wantEnd := map[string]int{
		"2026-10-01": 40, "2026-10-02": 15, "2026-10-05": 10, "2026-10-06": 12,
	}
	for _, r := range DailyModel(e.Flows) {
		if r.SKU != "A" {
			continue
		}
		key := r.Date.Format("2006-01-02")
		if w, ok := wantEnd[key]; ok && r.End != w {
			t.Errorf("SKU A %s 日结 = %d, 期望 %d", key, r.End, w)
		}
		delete(wantEnd, key)
	}
	if len(wantEnd) != 0 {
		t.Errorf("缺少日结行: %v", wantEnd)
	}
	// 每单批次来源报表包含跨日期来源与退货去向
	rep := e.OrderReport("O1").String()
	for _, s := range []string{"A1", "A2", "退货已过期归报废", "退货恢复原批"} {
		if !strings.Contains(rep, s) {
			t.Errorf("报表缺少 %q:\n%s", s, rep)
		}
	}
}
