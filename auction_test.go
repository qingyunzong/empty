package auction

import (
	"errors"
	"math/rand"
	"testing"
)

func mustSubmit(t *testing.T, a *Auction, o Order) {
	t.Helper()
	if err := a.Submit(o); err != nil {
		t.Fatalf("Submit(%d) failed: %v", o.ID, err)
	}
}

func allocOf(r Result, orderID int64, segIdx int) int64 {
	for _, a := range r.Allocations {
		if a.OrderID == orderID && a.SegmentIndex == segIdx {
			return a.Quantity
		}
	}
	return 0
}

// 价高优先: 高价段先满足, 低价段获得剩余额度。
func TestPricePriority(t *testing.T) {
	a := New(10)
	mustSubmit(t, a, Order{ID: 1, Segments: []Segment{{Price: 100, Quantity: 6}}})
	mustSubmit(t, a, Order{ID: 2, Segments: []Segment{{Price: 90, Quantity: 8}}})

	r := a.Clear()
	if !r.HasTrades {
		t.Fatal("expected trades")
	}
	if got := allocOf(r, 1, 0); got != 6 {
		t.Errorf("order1 alloc = %d, want 6", got)
	}
	if got := allocOf(r, 2, 0); got != 4 {
		t.Errorf("order2 alloc = %d, want 4", got)
	}
	if r.ClearingPrice != 90 {
		t.Errorf("clearing price = %d, want 90 (最后分配段价格)", r.ClearingPrice)
	}
}

// 同价比例分配: 额度不足时按需求比例分配。
func TestProRataAtSamePrice(t *testing.T) {
	a := New(10)
	mustSubmit(t, a, Order{ID: 1, Segments: []Segment{{Price: 100, Quantity: 30}}})
	mustSubmit(t, a, Order{ID: 2, Segments: []Segment{{Price: 100, Quantity: 10}}})

	r := a.Clear()
	// 30*10/40 = 7 余 20; 10*10/40 = 2 余 20; 已分 9, 余 1 补给余数并列中 ID 小者。
	if got := allocOf(r, 1, 0); got != 8 {
		t.Errorf("order1 alloc = %d, want 8", got)
	}
	if got := allocOf(r, 2, 0); got != 2 {
		t.Errorf("order2 alloc = %d, want 2", got)
	}
	if r.Total() != 10 {
		t.Errorf("total = %d, want 10", r.Total())
	}
}

// 余件按余数大者优先分配。
func TestRemainderByLargestFraction(t *testing.T) {
	a := New(7)
	mustSubmit(t, a, Order{ID: 1, Segments: []Segment{{Price: 100, Quantity: 4}}})
	mustSubmit(t, a, Order{ID: 2, Segments: []Segment{{Price: 100, Quantity: 3}}})
	mustSubmit(t, a, Order{ID: 3, Segments: []Segment{{Price: 100, Quantity: 3}}})
	// 4*7/10=2 余 8; 3*7/10=2 余 1; 3*7/10=2 余 1; 已分 6, 余 1 补给 order1。
	r := a.Clear()
	if got := allocOf(r, 1, 0); got != 3 {
		t.Errorf("order1 alloc = %d, want 3", got)
	}
	if got := allocOf(r, 2, 0); got != 2 {
		t.Errorf("order2 alloc = %d, want 2", got)
	}
	if got := allocOf(r, 3, 0); got != 2 {
		t.Errorf("order3 alloc = %d, want 2", got)
	}
}

// 余数相同时按订单 ID 小者优先, 与提交顺序无关。
func TestRemainderTieBreakBySmallerID(t *testing.T) {
	a := New(5)
	mustSubmit(t, a, Order{ID: 2, Segments: []Segment{{Price: 100, Quantity: 3}}})
	mustSubmit(t, a, Order{ID: 1, Segments: []Segment{{Price: 100, Quantity: 3}}})
	// 两者均 3*5/6=2 余 3, 已分 4, 余 1 补给 ID 更小的 order1。
	r := a.Clear()
	if got := allocOf(r, 1, 0); got != 3 {
		t.Errorf("order1 alloc = %d, want 3", got)
	}
	if got := allocOf(r, 2, 0); got != 2 {
		t.Errorf("order2 alloc = %d, want 2", got)
	}
}

// 成交价为最后一个获得分配的段的价格。
func TestClearingPriceIsLastAllocatedSegment(t *testing.T) {
	a := New(10)
	mustSubmit(t, a, Order{ID: 1, Segments: []Segment{{Price: 100, Quantity: 4}}})
	mustSubmit(t, a, Order{ID: 2, Segments: []Segment{{Price: 90, Quantity: 4}}})
	mustSubmit(t, a, Order{ID: 3, Segments: []Segment{{Price: 80, Quantity: 4}}})

	r := a.Clear()
	if r.ClearingPrice != 80 {
		t.Errorf("clearing price = %d, want 80", r.ClearingPrice)
	}
	if got := allocOf(r, 3, 0); got != 2 {
		t.Errorf("order3 alloc = %d, want 2", got)
	}
	if r.Total() != 10 {
		t.Errorf("total = %d, want 10", r.Total())
	}
}

// 无成交返回空结果。
func TestNoTradesReturnsEmpty(t *testing.T) {
	empty := New(10)
	if r := empty.Clear(); r.HasTrades || r.ClearingPrice != 0 || r.Allocations != nil {
		t.Errorf("no orders: got %+v, want empty result", r)
	}

	zero := New(0)
	mustSubmit(t, zero, Order{ID: 1, Segments: []Segment{{Price: 100, Quantity: 5}}})
	if r := zero.Clear(); r.HasTrades || r.ClearingPrice != 0 || r.Allocations != nil {
		t.Errorf("zero capacity: got %+v, want empty result", r)
	}
}

// 撤单后基于剩余订单重新计算。
func TestCancelAndRecompute(t *testing.T) {
	a := New(10)
	mustSubmit(t, a, Order{ID: 1, Segments: []Segment{{Price: 100, Quantity: 10}}})
	mustSubmit(t, a, Order{ID: 2, Segments: []Segment{{Price: 90, Quantity: 10}}})

	r1 := a.Clear()
	if got := allocOf(r1, 1, 0); got != 10 || r1.ClearingPrice != 100 {
		t.Fatalf("before cancel: order1 = %d, clearing = %d; want 10 @100", got, r1.ClearingPrice)
	}

	if err := a.Cancel(1); err != nil {
		t.Fatalf("Cancel failed: %v", err)
	}
	r2 := a.Clear()
	if got := allocOf(r2, 2, 0); got != 10 || r2.ClearingPrice != 90 {
		t.Errorf("after cancel: order2 = %d, clearing = %d; want 10 @90", got, r2.ClearingPrice)
	}
	if got := allocOf(r2, 1, 0); got != 0 {
		t.Errorf("cancelled order1 still allocated %d", got)
	}

	if err := a.Cancel(1); !errors.Is(err, ErrUnknownOrder) {
		t.Errorf("re-cancel err = %v, want ErrUnknownOrder", err)
	}
	if err := a.Cancel(2); err != nil {
		t.Fatalf("Cancel(2) failed: %v", err)
	}
	if r := a.Clear(); r.HasTrades {
		t.Errorf("all cancelled: got %+v, want empty result", r)
	}
}

// 分段需求: 同一订单的不同价格段独立参与分配。
func TestSegmentedDemandIndependentAllocation(t *testing.T) {
	a := New(6)
	mustSubmit(t, a, Order{ID: 1, Segments: []Segment{
		{Price: 100, Quantity: 3},
		{Price: 80, Quantity: 5},
	}})
	mustSubmit(t, a, Order{ID: 2, Segments: []Segment{{Price: 90, Quantity: 4}}})

	r := a.Clear()
	if got := allocOf(r, 1, 0); got != 3 {
		t.Errorf("order1 seg0 = %d, want 3", got)
	}
	if got := allocOf(r, 2, 0); got != 3 {
		t.Errorf("order2 seg0 = %d, want 3", got)
	}
	if got := allocOf(r, 1, 1); got != 0 {
		t.Errorf("order1 seg1 = %d, want 0 (低价段未轮到)", got)
	}
	if r.ClearingPrice != 90 {
		t.Errorf("clearing price = %d, want 90", r.ClearingPrice)
	}

	// 追加一个不影响高价段的低价段, 既有分配不变。
	b := New(6)
	mustSubmit(t, b, Order{ID: 1, Segments: []Segment{
		{Price: 100, Quantity: 3},
		{Price: 80, Quantity: 5},
		{Price: 10, Quantity: 100},
	}})
	mustSubmit(t, b, Order{ID: 2, Segments: []Segment{{Price: 90, Quantity: 4}}})
	r2 := b.Clear()
	if allocOf(r2, 1, 0) != allocOf(r, 1, 0) || allocOf(r2, 2, 0) != allocOf(r, 2, 0) {
		t.Errorf("adding independent low-price segment changed higher allocations: %+v vs %+v", r2, r)
	}
}

// 数量守恒: 成交总量等于 min(上限, 总需求), 且每段分配不超过其需求。
func TestQuantityConservation(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 200; trial++ {
		capacity := int64(rng.Intn(50))
		a := New(capacity)
		var demand int64
		nOrders := 1 + rng.Intn(5)
		for id := 1; id <= nOrders; id++ {
			nSegs := 1 + rng.Intn(3)
			segs := make([]Segment, nSegs)
			for i := range segs {
				segs[i] = Segment{Price: int64(rng.Intn(5)) * 10, Quantity: 1 + int64(rng.Intn(20))}
				demand += segs[i].Quantity
			}
			mustSubmit(t, a, Order{ID: int64(id), Segments: segs})
		}

		r := a.Clear()
		want := demand
		if capacity < want {
			want = capacity
		}
		if r.Total() != want {
			t.Fatalf("trial %d: total = %d, want min(%d, %d) = %d", trial, r.Total(), capacity, demand, want)
		}
		if r.Total() > capacity {
			t.Fatalf("trial %d: total %d exceeds capacity %d", trial, r.Total(), capacity)
		}
		if r.Total() == 0 && r.HasTrades {
			t.Fatalf("trial %d: zero total but HasTrades", trial)
		}
		if r.Total() > 0 && !r.HasTrades {
			t.Fatalf("trial %d: positive total but !HasTrades", trial)
		}
		// 每段分配不超过该段需求。
		limits := make(map[[2]int]int64)
		for id := int64(1); id <= int64(nOrders); id++ {
			o := a.orders[id]
			for i, s := range o.Segments {
				limits[[2]int{int(id), i}] = s.Quantity
			}
		}
		seen := make(map[[2]int]bool)
		for _, al := range r.Allocations {
			key := [2]int{int(al.OrderID), al.SegmentIndex}
			if seen[key] {
				t.Fatalf("trial %d: duplicate allocation for %v", trial, key)
			}
			seen[key] = true
			if al.Quantity <= 0 || al.Quantity > limits[key] {
				t.Fatalf("trial %d: alloc %v out of range (limit %d)", trial, al, limits[key])
			}
		}
		// 成交价须为某成交段价格, 且不高于任何未成交段价格、不低于成交段价格。
		if r.HasTrades {
			lastPrice := r.Allocations[len(r.Allocations)-1].Price
			if r.ClearingPrice != lastPrice {
				t.Fatalf("trial %d: clearing %d != last allocated segment price %d", trial, r.ClearingPrice, lastPrice)
			}
		}
	}
}

// 输入校验。
func TestValidation(t *testing.T) {
	a := New(10)
	if err := a.Submit(Order{ID: 1}); !errors.Is(err, ErrNoSegments) {
		t.Errorf("empty segments err = %v", err)
	}
	if err := a.Submit(Order{ID: 1, Segments: []Segment{{Price: 1, Quantity: 0}}}); !errors.Is(err, ErrBadQuantity) {
		t.Errorf("zero quantity err = %v", err)
	}
	if err := a.Submit(Order{ID: 1, Segments: []Segment{{Price: -1, Quantity: 1}}}); !errors.Is(err, ErrNegativePrice) {
		t.Errorf("negative price err = %v", err)
	}
	mustSubmit(t, a, Order{ID: 1, Segments: []Segment{{Price: 1, Quantity: 1}}})
	if err := a.Submit(Order{ID: 1, Segments: []Segment{{Price: 2, Quantity: 2}}}); !errors.Is(err, ErrDuplicateOrder) {
		t.Errorf("duplicate ID err = %v", err)
	}
}
