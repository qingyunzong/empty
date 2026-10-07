package inventory

import (
	"errors"
	"testing"
	"time"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func at(days int) time.Time { return t0.AddDate(0, 0, days) }

func mustInbound(t *testing.T, w *Warehouse, sku, batch string, qty int, expires time.Time) {
	t.Helper()
	if err := w.Inbound(sku, batch, qty, expires, t0); err != nil {
		t.Fatalf("inbound %s: %v", batch, err)
	}
}

func mustVerify(t *testing.T, w *Warehouse) {
	t.Helper()
	if err := w.Verify(); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

// 出库顺序：最早到期优先，到期相同按批次 ID 升序。
func TestOutboundFEFOThenBatchID(t *testing.T) {
	w := NewWarehouse()
	mustInbound(t, w, "A", "b-late", 5, at(30))
	mustInbound(t, w, "A", "b-early-2", 5, at(10))
	mustInbound(t, w, "A", "b-early-1", 5, at(10)) // 与 b-early-2 同期，ID 更小

	allocs, err := w.Outbound("A", 8, t0)
	if err != nil {
		t.Fatalf("outbound: %v", err)
	}
	want := []Allocation{
		{BatchID: "b-early-1", Quantity: 5},
		{BatchID: "b-early-2", Quantity: 3},
	}
	if len(allocs) != len(want) {
		t.Fatalf("allocs = %v, want %v", allocs, want)
	}
	for i := range want {
		if allocs[i] != want[i] {
			t.Fatalf("allocs[%d] = %+v, want %+v", i, allocs[i], want[i])
		}
	}
	if got := w.StockOf("A"); got != 7 {
		t.Fatalf("stock = %d, want 7", got)
	}
	mustVerify(t, w)
}

// 过期时刻先清退再出库：过期件入报废，不参与消耗。
func TestExpiredClearedBeforeOutbound(t *testing.T) {
	w := NewWarehouse()
	mustInbound(t, w, "A", "b-exp", 4, at(5))
	mustInbound(t, w, "A", "b-ok", 6, at(50))

	now := at(10) // b-exp 已过期
	allocs, err := w.Outbound("A", 6, now)
	if err != nil {
		t.Fatalf("outbound: %v", err)
	}
	if len(allocs) != 1 || allocs[0] != (Allocation{BatchID: "b-ok", Quantity: 6}) {
		t.Fatalf("allocs = %v, want only b-ok x6", allocs)
	}
	if got := w.BatchStock("b-exp"); got != 0 {
		t.Fatalf("expired batch stock = %d, want 0", got)
	}
	_, _, consumed, scrapped := w.Totals()
	if consumed != 6 || scrapped != 4 {
		t.Fatalf("consumed=%d scrapped=%d, want 6/4", consumed, scrapped)
	}
	mustVerify(t, w)
}

// 到期时刻当天即视为过期。
func TestExpiryBoundary(t *testing.T) {
	w := NewWarehouse()
	mustInbound(t, w, "A", "b1", 3, at(5))
	if cleared := w.ClearExpired(at(4)); cleared != 0 {
		t.Fatalf("cleared before expiry = %d, want 0", cleared)
	}
	if cleared := w.ClearExpired(at(5)); cleared != 3 {
		t.Fatalf("cleared at expiry = %d, want 3", cleared)
	}
	mustVerify(t, w)
}

// 质检冻结批次不参与消耗；解冻后恢复。
func TestFrozenBatchSkipped(t *testing.T) {
	w := NewWarehouse()
	mustInbound(t, w, "A", "b-frozen", 5, at(10)) // 更早到期但冻结
	mustInbound(t, w, "A", "b-normal", 5, at(20))
	if err := w.SetFrozen("b-frozen", true); err != nil {
		t.Fatal(err)
	}

	allocs, err := w.Outbound("A", 3, t0)
	if err != nil {
		t.Fatalf("outbound: %v", err)
	}
	if len(allocs) != 1 || allocs[0].BatchID != "b-normal" {
		t.Fatalf("allocs = %v, want only b-normal", allocs)
	}
	if got := w.BatchStock("b-frozen"); got != 5 {
		t.Fatalf("frozen batch stock = %d, want 5 (untouched)", got)
	}

	// 解冻后按 FEFO 优先消耗。
	if err := w.SetFrozen("b-frozen", false); err != nil {
		t.Fatal(err)
	}
	allocs, err = w.Outbound("A", 2, t0)
	if err != nil {
		t.Fatalf("outbound after unfreeze: %v", err)
	}
	if len(allocs) != 1 || allocs[0].BatchID != "b-frozen" {
		t.Fatalf("allocs after unfreeze = %v, want b-frozen", allocs)
	}
	mustVerify(t, w)
}

// 整单不足则无消耗：库存保持不变，返回不足错误。
func TestInsufficientOrderConsumesNothing(t *testing.T) {
	w := NewWarehouse()
	mustInbound(t, w, "A", "b1", 4, at(10))
	mustInbound(t, w, "A", "b2", 4, at(20))

	_, err := w.Outbound("A", 9, t0)
	if !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("err = %v, want ErrInsufficientStock", err)
	}
	if got := w.StockOf("A"); got != 8 {
		t.Fatalf("stock = %d, want 8 (no consumption)", got)
	}
	if got := w.BatchStock("b1"); got != 4 {
		t.Fatalf("b1 stock = %d, want 4", got)
	}
	_, _, consumed, _ := w.Totals()
	if consumed != 0 {
		t.Fatalf("consumed = %d, want 0", consumed)
	}
	mustVerify(t, w)
}

// 整单不足时，冻结导致的不可用也计入（冻结批次不可消耗）。
func TestInsufficientDueToFreeze(t *testing.T) {
	w := NewWarehouse()
	mustInbound(t, w, "A", "b-frozen", 10, at(10))
	mustInbound(t, w, "A", "b-free", 2, at(20))
	if err := w.SetFrozen("b-frozen", true); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Outbound("A", 3, t0); !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("err = %v, want ErrInsufficientStock", err)
	}
	if got := w.BatchStock("b-free"); got != 2 {
		t.Fatalf("b-free stock = %d, want 2", got)
	}
	mustVerify(t, w)
}

// 退款回原批次，增加该批在库；再次出库按 FEFO 重新排序。
func TestRefundToOriginalBatch(t *testing.T) {
	w := NewWarehouse()
	mustInbound(t, w, "A", "b1", 5, at(10))
	mustInbound(t, w, "A", "b2", 5, at(20))

	if _, err := w.Outbound("A", 5, t0); err != nil { // 清空 b1
		t.Fatal(err)
	}
	restocked, scrapped, err := w.Refund("b1", 3, t0)
	if err != nil {
		t.Fatalf("refund: %v", err)
	}
	if restocked != 3 || scrapped != 0 {
		t.Fatalf("restocked=%d scrapped=%d, want 3/0", restocked, scrapped)
	}
	if got := w.BatchStock("b1"); got != 3 {
		t.Fatalf("b1 stock = %d, want 3", got)
	}
	// 退款件回到 b1，出库仍按 FEFO 先消耗 b1。
	allocs, err := w.Outbound("A", 2, t0)
	if err != nil {
		t.Fatal(err)
	}
	if len(allocs) != 1 || allocs[0].BatchID != "b1" {
		t.Fatalf("allocs = %v, want b1 first", allocs)
	}
	mustVerify(t, w)
}

// 退款时原批已过期：退回件直接报废，不回库。
func TestRefundExpiredBatchGoesToScrap(t *testing.T) {
	w := NewWarehouse()
	mustInbound(t, w, "A", "b1", 5, at(10))

	if _, err := w.Outbound("A", 2, t0); err != nil {
		t.Fatal(err)
	}
	restocked, scrapped, err := w.Refund("b1", 2, at(15)) // 已过期
	if err != nil {
		t.Fatalf("refund: %v", err)
	}
	if restocked != 0 || scrapped != 2 {
		t.Fatalf("restocked=%d scrapped=%d, want 0/2", restocked, scrapped)
	}
	// 出库触发清退：b1 剩余 3 件也报废。
	if _, err := w.Outbound("A", 1, at(15)); !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("err = %v, want ErrInsufficientStock", err)
	}
	_, _, _, totalScrapped := w.Totals()
	if totalScrapped != 5 {
		t.Fatalf("scrapped = %d, want 5 (2 refund + 3 cleared)", totalScrapped)
	}
	mustVerify(t, w)
}

// 混合长序列后逐件核验账目守恒。
func TestVerifyAfterMixedOperations(t *testing.T) {
	w := NewWarehouse()
	mustInbound(t, w, "A", "a1", 10, at(5))
	mustInbound(t, w, "A", "a2", 10, at(15))
	mustInbound(t, w, "B", "b1", 7, at(10))
	if err := w.SetFrozen("a2", true); err != nil {
		t.Fatal(err)
	}

	if _, err := w.Outbound("A", 4, t0); err != nil { // 消耗 a1 x4
		t.Fatal(err)
	}
	if _, err := w.Outbound("B", 7, at(6)); err != nil { // b1 全部消耗
		t.Fatal(err)
	}
	// at(6)：a1 剩余 6 件已过期，出库 A 时先清退；a2 冻结不可用。
	if _, err := w.Outbound("A", 1, at(6)); !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("err = %v, want ErrInsufficientStock", err)
	}
	if err := w.SetFrozen("a2", false); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Outbound("A", 10, at(6)); err != nil { // a2 x10
		t.Fatal(err)
	}
	if _, _, err := w.Refund("a1", 2, at(6)); err != nil { // 已过期 -> 报废
		t.Fatal(err)
	}
	if _, _, err := w.Refund("b1", 1, at(6)); err != nil { // 未过期 -> 回库
		t.Fatal(err)
	}

	in, refunded, consumed, scrapped := w.Totals()
	if in != 27 || refunded != 3 || consumed != 21 || scrapped != 8 {
		t.Fatalf("totals = %d/%d/%d/%d, want 27/3/21/8", in, refunded, consumed, scrapped)
	}
	if got := w.StockOf("B"); got != 1 {
		t.Fatalf("B stock = %d, want 1 (refunded)", got)
	}
	mustVerify(t, w)
}

// 边界与错误输入。
func TestEdgeCases(t *testing.T) {
	w := NewWarehouse()
	if err := w.Inbound("A", "b0", 0, at(10), t0); !errors.Is(err, ErrInvalidQuantity) {
		t.Fatalf("err = %v, want ErrInvalidQuantity", err)
	}
	if err := w.Inbound("A", "b-exp", 1, at(0), at(0)); !errors.Is(err, ErrBatchExpired) {
		t.Fatalf("err = %v, want ErrBatchExpired", err)
	}
	mustInbound(t, w, "A", "b1", 2, at(10))
	if err := w.Inbound("A", "b1", 2, at(10), t0); !errors.Is(err, ErrBatchExists) {
		t.Fatalf("err = %v, want ErrBatchExists", err)
	}
	if err := w.SetFrozen("nope", true); !errors.Is(err, ErrBatchNotFound) {
		t.Fatalf("err = %v, want ErrBatchNotFound", err)
	}
	if _, _, err := w.Refund("nope", 1, t0); !errors.Is(err, ErrBatchNotFound) {
		t.Fatalf("err = %v, want ErrBatchNotFound", err)
	}
	if _, err := w.Outbound("A", 0, t0); !errors.Is(err, ErrInvalidQuantity) {
		t.Fatalf("err = %v, want ErrInvalidQuantity", err)
	}
	mustVerify(t, w)
}
