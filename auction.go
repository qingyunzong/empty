// Package auction 实现一个分段需求拍卖库。
//
// 规则:
//   - 每个订单由若干价格段组成, 每段有独立的价格与数量, 全库有总数量上限。
//   - 分配按价格从高到低逐段进行; 同一价格段需求超过剩余额度时按比例分配。
//   - 比例分配产生的整数余数, 按小数余数从大到小补给, 余数相同按订单 ID 小者优先。
//   - 成交价为最后一个获得分配的段的价格; 无任何成交时返回空结果。
//   - 撤单后基于当前订单集合重新计算, 各段分配相互独立。
package auction

import (
	"errors"
	"fmt"
	"sort"
)

// Segment 表示订单中的一个价格段需求。
type Segment struct {
	Price    int64 // 该段出价(最小货币单位)
	Quantity int64 // 该段需求数量, 必须为正
}

// Order 表示一个分段需求订单。
type Order struct {
	ID       int64
	Segments []Segment
}

// Allocation 表示某订单某段获得的成交数量。
type Allocation struct {
	OrderID      int64
	SegmentIndex int
	Price        int64
	Quantity     int64
}

// Result 为一次清算的结果。无任何成交时为零值(空结果)。
type Result struct {
	ClearingPrice int64 // 最后分配段的价格; 无成交为 0
	Allocations   []Allocation
	HasTrades     bool
}

// Total 返回成交总数量。
func (r Result) Total() int64 {
	var sum int64
	for _, a := range r.Allocations {
		sum += a.Quantity
	}
	return sum
}

var (
	ErrNoSegments     = errors.New("auction: order must contain at least one segment")
	ErrBadQuantity    = errors.New("auction: segment quantity must be positive")
	ErrNegativePrice  = errors.New("auction: segment price must be non-negative")
	ErrDuplicateOrder = errors.New("auction: duplicate order ID")
	ErrUnknownOrder   = errors.New("auction: unknown order ID")
)

// Auction 持有订单簿与总数量上限。
type Auction struct {
	capacity int64
	orders   map[int64]Order
}

// New 创建总数量上限为 capacity 的拍卖库。
func New(capacity int64) *Auction {
	return &Auction{capacity: capacity, orders: make(map[int64]Order)}
}

// Capacity 返回总数量上限。
func (a *Auction) Capacity() int64 { return a.capacity }

// Submit 校验并登记一个订单; ID 重复或段非法时返回错误。
func (a *Auction) Submit(o Order) error {
	if len(o.Segments) == 0 {
		return ErrNoSegments
	}
	for _, s := range o.Segments {
		if s.Quantity <= 0 {
			return ErrBadQuantity
		}
		if s.Price < 0 {
			return ErrNegativePrice
		}
	}
	if _, exists := a.orders[o.ID]; exists {
		return fmt.Errorf("%w: %d", ErrDuplicateOrder, o.ID)
	}
	a.orders[o.ID] = o
	return nil
}

// Cancel 撤销订单; 订单不存在时返回错误。撤单后 Clear 基于剩余订单重算。
func (a *Auction) Cancel(id int64) error {
	if _, exists := a.orders[id]; !exists {
		return fmt.Errorf("%w: %d", ErrUnknownOrder, id)
	}
	delete(a.orders, id)
	return nil
}

// segRef 是参与分配的段引用。
type segRef struct {
	orderID int64
	segIdx  int
	price   int64
	qty     int64
}

// Clear 对当前订单集合执行一次清算, 返回分配结果。
//
// 算法: 全部段按价格降序分组; 自高价起逐组分配, 组内需求不超过剩余额度
// 则全部分配, 否则按比例分配并以最大余数法(余数相同取订单 ID 小者)补齐整数。
// 每个段独立参与分配, 互不影响。
func (a *Auction) Clear() Result {
	if a.capacity <= 0 || len(a.orders) == 0 {
		return Result{}
	}

	segs := make([]segRef, 0)
	for _, o := range a.orders {
		for i, s := range o.Segments {
			segs = append(segs, segRef{orderID: o.ID, segIdx: i, price: s.Price, qty: s.Quantity})
		}
	}
	sort.Slice(segs, func(i, j int) bool {
		if segs[i].price != segs[j].price {
			return segs[i].price > segs[j].price
		}
		if segs[i].orderID != segs[j].orderID {
			return segs[i].orderID < segs[j].orderID
		}
		return segs[i].segIdx < segs[j].segIdx
	})

	var res Result
	remaining := a.capacity
	for i := 0; i < len(segs) && remaining > 0; {
		j := i
		var groupDemand int64
		for j < len(segs) && segs[j].price == segs[i].price {
			groupDemand += segs[j].qty
			j++
		}
		group := segs[i:j]

		var allocs []int64
		if groupDemand <= remaining {
			allocs = make([]int64, len(group))
			for k, s := range group {
				allocs[k] = s.qty
			}
			remaining -= groupDemand
		} else {
			allocs = prorate(group, remaining)
			remaining = 0
		}

		for k, s := range group {
			if allocs[k] <= 0 {
				continue
			}
			res.Allocations = append(res.Allocations, Allocation{
				OrderID:      s.orderID,
				SegmentIndex: s.segIdx,
				Price:        s.price,
				Quantity:     allocs[k],
			})
			res.HasTrades = true
			res.ClearingPrice = s.price // 组按价格降序处理, 最后写入者即最后分配段价格
		}
		i = j
	}
	return res
}

// prorate 在额度不足时对同价组按比例分配, 余数按最大余数法补齐。
func prorate(group []segRef, quota int64) []int64 {
	var total int64
	for _, s := range group {
		total += s.qty
	}
	allocs := make([]int64, len(group))
	type rem struct {
		idx int
		mod int64
	}
	rems := make([]rem, 0, len(group))
	var used int64
	for k, s := range group {
		exact := s.qty * quota
		allocs[k] = exact / total
		used += allocs[k]
		if m := exact % total; m > 0 {
			rems = append(rems, rem{idx: k, mod: m})
		}
	}
	// 余数大者优先; 余数相同按订单 ID 小者优先(组内已按 ID 升序, 稳定排序即可)。
	sort.SliceStable(rems, func(i, j int) bool {
		return rems[i].mod > rems[j].mod
	})
	for left := quota - used; left > 0 && len(rems) > 0; {
		for i := range rems {
			if left <= 0 {
				break
			}
			allocs[rems[i].idx]++
			left--
		}
	}
	return allocs
}
