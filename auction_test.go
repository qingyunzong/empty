package auction

import (
	"math/rand"
	"sort"
	"testing"
)

// fillMap aggregates fills per (orderID, price).
func fillMap(r Result) map[[2]int64]int64 {
	m := make(map[[2]int64]int64)
	for _, f := range r.Fills {
		m[[2]int64{f.OrderID, f.Price}] += f.Quantity
	}
	return m
}

func orderTotal(r Result, id int64) int64 {
	var t int64
	for _, f := range r.Fills {
		if f.OrderID == id {
			t += f.Quantity
		}
	}
	return t
}

// 价高优先：高价段先成交，低价段拿剩余供给。
func TestHigherPriceFirst(t *testing.T) {
	a := New(5)
	a.AddOrder(Order{ID: 1, Cap: 100, Segments: []Segment{{Price: 100, Quantity: 3}}})
	a.AddOrder(Order{ID: 2, Cap: 100, Segments: []Segment{{Price: 90, Quantity: 5}}})

	r := a.Allocate()
	if !r.Cleared {
		t.Fatal("expected cleared")
	}
	if got := orderTotal(r, 1); got != 3 {
		t.Errorf("order1 = %d, want 3", got)
	}
	if got := orderTotal(r, 2); got != 2 {
		t.Errorf("order2 = %d, want 2 (only remaining supply)", got)
	}
	if r.ClearingPrice != 90 {
		t.Errorf("clearing price = %d, want 90 (last allocated segment)", r.ClearingPrice)
	}
	if r.Total() != 5 {
		t.Errorf("total = %d, want 5", r.Total())
	}
}

// 同价比例分配：供给不足时按需求比例，余件按余数大、再按 ID 小。
func TestProportionalSamePrice(t *testing.T) {
	// 供给 2，三方各需 1：比例各得 0，余件 2 个按 ID 小先分。
	a := New(2)
	for i := int64(1); i <= 3; i++ {
		a.AddOrder(Order{ID: i, Cap: 10, Segments: []Segment{{Price: 100, Quantity: 1}}})
	}
	r := a.Allocate()
	if orderTotal(r, 1) != 1 || orderTotal(r, 2) != 1 || orderTotal(r, 3) != 0 {
		t.Errorf("leftover tie should go to smaller IDs, got %v", r.Fills)
	}
	if r.ClearingPrice != 100 {
		t.Errorf("clearing price = %d, want 100", r.ClearingPrice)
	}

	// 供给 5，需求 3/3/4：floor 为 1/1/2，余数 5/5/0，余件给余数并列中 ID 小者。
	b := New(5)
	b.AddOrder(Order{ID: 1, Cap: 10, Segments: []Segment{{Price: 100, Quantity: 3}}})
	b.AddOrder(Order{ID: 2, Cap: 10, Segments: []Segment{{Price: 100, Quantity: 3}}})
	b.AddOrder(Order{ID: 3, Cap: 10, Segments: []Segment{{Price: 100, Quantity: 4}}})
	rb := b.Allocate()
	if orderTotal(rb, 1) != 2 || orderTotal(rb, 2) != 1 || orderTotal(rb, 3) != 2 {
		t.Errorf("largest-remainder split = %v, want 2/1/2", rb.Fills)
	}
	if rb.Total() != 5 {
		t.Errorf("total = %d, want 5", rb.Total())
	}
}

// 数量上限：订单总成交不得超过 Cap，且上限影响后续低价段。
func TestOrderCap(t *testing.T) {
	a := New(100)
	a.AddOrder(Order{ID: 1, Cap: 4, Segments: []Segment{{Price: 100, Quantity: 10}, {Price: 90, Quantity: 10}}})
	a.AddOrder(Order{ID: 2, Cap: 100, Segments: []Segment{{Price: 95, Quantity: 50}}})

	r := a.Allocate()
	if got := orderTotal(r, 1); got != 4 {
		t.Errorf("order1 = %d, want 4 (capped)", got)
	}
	if got := fillMap(r)[[2]int64{1, 90}]; got != 0 {
		t.Errorf("order1 @90 = %d, want 0 (cap exhausted at higher level)", got)
	}
	if got := orderTotal(r, 2); got != 50 {
		t.Errorf("order2 = %d, want 50", got)
	}
	if r.ClearingPrice != 95 {
		t.Errorf("clearing price = %d, want 95", r.ClearingPrice)
	}
}

// 无成交返回空结果。
func TestNoTradeReturnsEmpty(t *testing.T) {
	cases := map[string]*Auction{
		"zero supply":  New(0),
		"no orders":    New(10),
		"zero demand":  New(10),
		"empty segs":   New(10),
		"zero qty seg": New(10),
	}
	cases["zero supply"].AddOrder(Order{ID: 1, Cap: 5, Segments: []Segment{{Price: 100, Quantity: 5}}})
	cases["zero demand"].AddOrder(Order{ID: 1, Cap: 5, Segments: []Segment{{Price: 100, Quantity: 0}}})
	cases["empty segs"].AddOrder(Order{ID: 1, Cap: 5})
	cases["zero qty seg"].AddOrder(Order{ID: 1, Cap: 0, Segments: []Segment{{Price: 100, Quantity: 5}}})

	for name, a := range cases {
		r := a.Allocate()
		if r.Cleared || r.Fills != nil || r.Total() != 0 {
			t.Errorf("%s: got %+v, want empty result", name, r)
		}
	}
}

// 撤单后重算：被撤订单不再参与，其余订单按新供给重新分配。
func TestCancelAndReallocate(t *testing.T) {
	a := New(4)
	a.AddOrder(Order{ID: 1, Cap: 10, Segments: []Segment{{Price: 100, Quantity: 4}}})
	a.AddOrder(Order{ID: 2, Cap: 10, Segments: []Segment{{Price: 90, Quantity: 4}}})

	r1 := a.Allocate()
	if orderTotal(r1, 1) != 4 || orderTotal(r1, 2) != 0 || r1.ClearingPrice != 100 {
		t.Fatalf("first allocation = %+v", r1)
	}

	if !a.Cancel(1) {
		t.Fatal("Cancel(1) = false, want true")
	}
	if a.Cancel(99) {
		t.Fatal("Cancel(99) = true, want false")
	}

	r2 := a.Allocate()
	if orderTotal(r2, 1) != 0 {
		t.Errorf("cancelled order still filled: %+v", r2.Fills)
	}
	if orderTotal(r2, 2) != 4 || r2.ClearingPrice != 90 {
		t.Errorf("reallocation = %+v, want order2 fully filled @90", r2)
	}

	// 全部撤单后无成交。
	a.Cancel(2)
	if r3 := a.Allocate(); r3.Cleared || r3.Fills != nil {
		t.Errorf("after cancelling all: %+v, want empty", r3)
	}
}

// 独立逐段分配：同一订单的不同价格段在各自价位独立参与分配。
func TestIndependentSegmentAllocation(t *testing.T) {
	a := New(8)
	a.AddOrder(Order{ID: 1, Cap: 100, Segments: []Segment{{Price: 100, Quantity: 2}, {Price: 90, Quantity: 3}}})
	a.AddOrder(Order{ID: 2, Cap: 100, Segments: []Segment{{Price: 95, Quantity: 4}}})

	r := a.Allocate()
	fm := fillMap(r)
	if fm[[2]int64{1, 100}] != 2 {
		t.Errorf("order1 @100 = %d, want 2", fm[[2]int64{1, 100}])
	}
	if fm[[2]int64{2, 95}] != 4 {
		t.Errorf("order2 @95 = %d, want 4", fm[[2]int64{2, 95}])
	}
	if fm[[2]int64{1, 90}] != 2 {
		t.Errorf("order1 @90 = %d, want 2 (partial, remaining supply)", fm[[2]int64{1, 90}])
	}
	if r.ClearingPrice != 90 {
		t.Errorf("clearing price = %d, want 90", r.ClearingPrice)
	}

	// 供给只够到 95 价位时，90 段完全不得分。
	b := New(6)
	b.AddOrder(Order{ID: 1, Cap: 100, Segments: []Segment{{Price: 100, Quantity: 2}, {Price: 90, Quantity: 3}}})
	b.AddOrder(Order{ID: 2, Cap: 100, Segments: []Segment{{Price: 95, Quantity: 4}}})
	rb := b.Allocate()
	if got := fillMap(rb)[[2]int64{1, 90}]; got != 0 {
		t.Errorf("order1 @90 = %d, want 0 (supply exhausted above)", got)
	}
	if rb.ClearingPrice != 95 {
		t.Errorf("clearing price = %d, want 95", rb.ClearingPrice)
	}
}

// 数量守恒：总成交 == min(供给, 各订单 min(Cap, 段需求合计) 之和)，
// 且每订单不超 Cap、每段不超段需求。随机用例反复核对。
func TestQuantityConservation(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 500; trial++ {
		supply := int64(rng.Intn(50))
		nOrders := rng.Intn(6)
		a := New(supply)
		orders := make(map[int64]Order)
		for i := 0; i < nOrders; i++ {
			id := int64(i + 1)
			nSegs := rng.Intn(4)
			var segs []Segment
			var segSum int64
			for j := 0; j < nSegs; j++ {
				q := int64(rng.Intn(20))
				segs = append(segs, Segment{Price: int64(80 + rng.Intn(30)), Quantity: q})
				segSum += q
			}
			o := Order{ID: id, Cap: int64(rng.Intn(30)), Segments: segs}
			orders[id] = o
			a.AddOrder(o)
		}

		r := a.Allocate()

		// 期望总成交。
		var wantTotal int64
		segSums := make(map[int64]int64)
		segQty := make(map[[2]int64]int64)
		for id, o := range orders {
			for _, s := range o.Segments {
				segSums[id] += s.Quantity
				segQty[[2]int64{id, s.Price}] += s.Quantity
			}
			capped := segSums[id]
			if o.Cap < capped {
				capped = o.Cap
			}
			wantTotal += capped
		}
		if supply < wantTotal {
			wantTotal = supply
		}
		if r.Total() != wantTotal {
			t.Fatalf("trial %d: total = %d, want %d (supply=%d)", trial, r.Total(), wantTotal, supply)
		}
		if wantTotal == 0 && (r.Cleared || r.Fills != nil) {
			t.Fatalf("trial %d: want empty result, got %+v", trial, r)
		}

		// 每订单不超 Cap，每段不超段需求，成交价必须是该订单某段价格。
		allocPerOrder := make(map[int64]int64)
		allocPerSeg := make(map[[2]int64]int64)
		for _, f := range r.Fills {
			allocPerOrder[f.OrderID] += f.Quantity
			allocPerSeg[[2]int64{f.OrderID, f.Price}] += f.Quantity
			if _, ok := segQty[[2]int64{f.OrderID, f.Price}]; !ok {
				t.Fatalf("trial %d: fill at unknown segment %+v", trial, f)
			}
		}
		for id, q := range allocPerOrder {
			if q > orders[id].Cap {
				t.Fatalf("trial %d: order %d allocated %d > cap %d", trial, id, q, orders[id].Cap)
			}
		}
		for key, q := range allocPerSeg {
			if q > segQty[key] {
				t.Fatalf("trial %d: segment %v allocated %d > demand %d", trial, key, q, segQty[key])
			}
		}
	}
}

// 撤单后仍满足数量守恒。
func TestConservationAfterCancel(t *testing.T) {
	a := New(7)
	a.AddOrder(Order{ID: 1, Cap: 5, Segments: []Segment{{Price: 100, Quantity: 5}}})
	a.AddOrder(Order{ID: 2, Cap: 5, Segments: []Segment{{Price: 100, Quantity: 5}}})
	a.AddOrder(Order{ID: 3, Cap: 9, Segments: []Segment{{Price: 90, Quantity: 9}}})

	before := a.Allocate()
	if before.Total() != 7 {
		t.Fatalf("before cancel: total = %d, want 7", before.Total())
	}

	a.Cancel(1)
	after := a.Allocate()
	// 供给 7，剩余需求 min(5,5)+min(9,9)=14，仍应成交 7。
	if after.Total() != 7 {
		t.Fatalf("after cancel: total = %d, want 7", after.Total())
	}
	if orderTotal(after, 1) != 0 {
		t.Fatalf("cancelled order filled: %+v", after.Fills)
	}
	// 同价只剩订单 2，得 5；订单 3 得剩余 2，清仓价 90。
	if orderTotal(after, 2) != 5 || orderTotal(after, 3) != 2 || after.ClearingPrice != 90 {
		t.Fatalf("after cancel: %+v", after)
	}
}

// 结果按订单 ID、价格降序排列，便于消费方使用。
func TestFillsSorted(t *testing.T) {
	a := New(100)
	a.AddOrder(Order{ID: 2, Cap: 10, Segments: []Segment{{Price: 100, Quantity: 1}, {Price: 90, Quantity: 1}}})
	a.AddOrder(Order{ID: 1, Cap: 10, Segments: []Segment{{Price: 95, Quantity: 1}}})
	r := a.Allocate()
	if !sort.SliceIsSorted(r.Fills, func(i, j int) bool {
		if r.Fills[i].OrderID != r.Fills[j].OrderID {
			return r.Fills[i].OrderID < r.Fills[j].OrderID
		}
		return r.Fills[i].Price > r.Fills[j].Price
	}) {
		t.Errorf("fills not sorted: %+v", r.Fills)
	}
}
