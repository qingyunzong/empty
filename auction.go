// Package auction implements a uniform-price auction with segmented demand
// and per-order quantity caps.
//
// Allocation rules:
//   - Segments from all orders compete globally, highest price first.
//   - At a price level where total demand exceeds remaining supply, supply is
//     split proportionally to demand; leftover units go to the largest
//     fractional remainder, ties broken by smaller order ID.
//   - Each order's total allocation never exceeds its quantity cap.
//   - The clearing price is the price of the last segment that received any
//     allocation. If nothing is allocated, the result is empty.
package auction

import "sort"

// Segment is one rung of an order's demand ladder: the order is willing to
// buy up to Quantity units at a price of at least Price.
type Segment struct {
	Price    int64
	Quantity int64
}

// Order is a demand order with segmented demand and a total quantity cap.
type Order struct {
	ID       int64
	Cap      int64 // maximum total quantity this order may receive
	Segments []Segment
}

// Fill records quantity allocated to one segment of one order.
type Fill struct {
	OrderID  int64
	Price    int64 // price of the segment that was filled
	Quantity int64
}

// Result is the outcome of one allocation run.
type Result struct {
	Fills         []Fill // nil when nothing cleared
	ClearingPrice int64  // price of the last allocated segment
	Cleared       bool   // false when no quantity was allocated
}

// Total returns the total allocated quantity across all fills.
func (r Result) Total() int64 {
	var total int64
	for _, f := range r.Fills {
		total += f.Quantity
	}
	return total
}

// Auction holds the supply and the live orders.
type Auction struct {
	supply int64
	orders map[int64]Order
}

// New creates an Auction with the given supply quantity.
func New(supply int64) *Auction {
	return &Auction{supply: supply, orders: make(map[int64]Order)}
}

// AddOrder inserts or replaces an order.
func (a *Auction) AddOrder(o Order) {
	a.orders[o.ID] = o
}

// Cancel removes an order; it reports whether the order existed.
// Allocation is recomputed from the remaining orders on the next Allocate.
func (a *Auction) Cancel(id int64) bool {
	if _, ok := a.orders[id]; !ok {
		return false
	}
	delete(a.orders, id)
	return true
}

// candidate is one segment competing at its price level.
type candidate struct {
	orderID int64
	price   int64
	demand  int64 // segment quantity, later capped by the order's remaining cap
	alloc   int64
	rem     int64 // fractional remainder used for leftover distribution
}

// Allocate runs the auction over the live orders and returns the result.
func (a *Auction) Allocate() Result {
	if a.supply <= 0 || len(a.orders) == 0 {
		return Result{}
	}

	// Collect segments and group them by price level. Segments of the same
	// order at the same price merge into one candidate so the order cap is
	// enforced per order at every level.
	type segKey struct {
		orderID int64
		price   int64
	}
	demands := make(map[segKey]int64)
	levels := make(map[int64][]*candidate)
	byKey := make(map[segKey]*candidate)
	var prices []int64
	for _, o := range a.orders {
		for _, s := range o.Segments {
			if s.Quantity <= 0 {
				continue
			}
			k := segKey{o.ID, s.Price}
			c, ok := byKey[k]
			if !ok {
				c = &candidate{orderID: o.ID, price: s.Price}
				byKey[k] = c
				if _, seen := levels[s.Price]; !seen {
					prices = append(prices, s.Price)
				}
				levels[s.Price] = append(levels[s.Price], c)
			}
			demands[k] += s.Quantity
			c.demand = demands[k]
		}
	}
	if len(prices) == 0 {
		return Result{}
	}
	sort.Slice(prices, func(i, j int) bool { return prices[i] > prices[j] })

	remaining := a.supply
	capLeft := make(map[int64]int64, len(a.orders))
	for id, o := range a.orders {
		capLeft[id] = o.Cap
	}

	var fills []Fill
	var clearingPrice int64
	cleared := false

	// Walk price levels from highest to lowest, allocating each segment
	// independently at its own level.
	for _, p := range prices {
		if remaining == 0 {
			break
		}
		level := levels[p]
		var levelDemand int64
		for _, c := range level {
			if left := capLeft[c.orderID]; left < c.demand {
				c.demand = left
			}
			if c.demand < 0 {
				c.demand = 0
			}
			levelDemand += c.demand
		}
		if levelDemand == 0 {
			continue
		}

		if levelDemand <= remaining {
			// Whole level clears: every segment gets its full demand.
			for _, c := range level {
				c.alloc = c.demand
			}
		} else {
			// Contended level: proportional split, leftovers by largest
			// remainder, ties by smaller order ID.
			var assigned int64
			for _, c := range level {
				prod := remaining * c.demand
				c.alloc = prod / levelDemand
				c.rem = prod % levelDemand
				assigned += c.alloc
			}
			leftover := remaining - assigned
			rest := make([]*candidate, len(level))
			copy(rest, level)
			sort.Slice(rest, func(i, j int) bool {
				if rest[i].rem != rest[j].rem {
					return rest[i].rem > rest[j].rem
				}
				return rest[i].orderID < rest[j].orderID
			})
			for i := int64(0); i < leftover; i++ {
				rest[i].alloc++
			}
		}

		levelFilled := false
		for _, c := range level {
			if c.alloc == 0 {
				continue
			}
			fills = append(fills, Fill{OrderID: c.orderID, Price: p, Quantity: c.alloc})
			capLeft[c.orderID] -= c.alloc
			remaining -= c.alloc
			levelFilled = true
		}
		if levelFilled {
			cleared = true
			clearingPrice = p
		}
	}

	if !cleared {
		return Result{}
	}
	sort.Slice(fills, func(i, j int) bool {
		if fills[i].OrderID != fills[j].OrderID {
			return fills[i].OrderID < fills[j].OrderID
		}
		return fills[i].Price > fills[j].Price
	})
	return Result{Fills: fills, ClearingPrice: clearingPrice, Cleared: true}
}
