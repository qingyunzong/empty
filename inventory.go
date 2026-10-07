// Package inventory 实现批次库存库：
//   - 出库按 FEFO：最早到期优先，到期相同按批次 ID 升序；
//   - 出库前先把已过期库存清退入报废；
//   - 质检冻结的批次不参与消耗；
//   - 整单不足则不发生任何消耗（原子性）；
//   - 退款退回原批次，若原批已过期则直接进入报废；
//   - 所有数量以逐件（per-piece）模型记录，Verify 逐件核验账目。
package inventory

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

var (
	ErrBatchExists       = errors.New("batch already exists")
	ErrBatchNotFound     = errors.New("batch not found")
	ErrBatchExpired      = errors.New("batch already expired")
	ErrInvalidQuantity   = errors.New("quantity must be positive")
	ErrInsufficientStock = errors.New("insufficient stock: order not consumed")
)

// PieceState 是单件库存的生命周期状态。
type PieceState int

const (
	PieceInStock  PieceState = iota // 在库
	PieceConsumed                   // 已出库消耗
	PieceScrapped                   // 已报废（过期清退或过期退款）
)

func (s PieceState) String() string {
	switch s {
	case PieceInStock:
		return "in_stock"
	case PieceConsumed:
		return "consumed"
	case PieceScrapped:
		return "scrapped"
	}
	return "unknown"
}

// Piece 是逐件模型中的最小单位，账目核验以它为准。
type Piece struct {
	ID    int
	State PieceState
}

// Batch 是一个库存批次，数量由其持有的逐件记录推导。
type Batch struct {
	ID        string
	SKU       string
	ExpiresAt time.Time
	Frozen    bool // 质检冻结：不参与出库消耗
	pieces    []*Piece
}

// Stock 返回批次当前在库件数（逐件统计）。
func (b *Batch) Stock() int {
	n := 0
	for _, p := range b.pieces {
		if p.State == PieceInStock {
			n++
		}
	}
	return n
}

// expired 判定：到期时刻即视为过期（now >= ExpiresAt）。
func (b *Batch) expired(now time.Time) bool {
	return !b.ExpiresAt.After(now)
}

// Allocation 描述一次出库在某批次上的消耗量。
type Allocation struct {
	BatchID  string
	Quantity int
}

// Warehouse 是库存库，聚合账目计数与逐件模型双向核验。
type Warehouse struct {
	batches     map[string]*Batch
	nextPieceID int

	// 账目计数器，Verify 会用逐件模型重新统计并比对。
	inbound  int // 累计入库件数
	refunded int // 累计退款件数（回库 + 报废）
	consumed int // 累计出库 or 消耗件数
	scrapped int // 累计报废件数
}

func NewWarehouse() *Warehouse {
	return &Warehouse{batches: make(map[string]*Batch)}
}

// Inbound 新建批次入库；已过期的批次拒绝入库。
func (w *Warehouse) Inbound(sku, batchID string, qty int, expiresAt, now time.Time) error {
	if qty <= 0 {
		return ErrInvalidQuantity
	}
	if _, ok := w.batches[batchID]; ok {
		return ErrBatchExists
	}
	b := &Batch{ID: batchID, SKU: sku, ExpiresAt: expiresAt}
	if b.expired(now) {
		return ErrBatchExpired
	}
	for i := 0; i < qty; i++ {
		b.pieces = append(b.pieces, &Piece{ID: w.nextPieceID, State: PieceInStock})
		w.nextPieceID++
	}
	w.batches[batchID] = b
	w.inbound += qty
	return nil
}

// SetFrozen 设置/解除质检冻结。
func (w *Warehouse) SetFrozen(batchID string, frozen bool) error {
	b, ok := w.batches[batchID]
	if !ok {
		return ErrBatchNotFound
	}
	b.Frozen = frozen
	return nil
}

// ClearExpired 把所有在库且已到期的件清退入报废，返回清退件数。
func (w *Warehouse) ClearExpired(now time.Time) int {
	cleared := 0
	for _, b := range w.batches {
		if !b.expired(now) {
			continue
		}
		for _, p := range b.pieces {
			if p.State == PieceInStock {
				p.State = PieceScrapped
				cleared++
			}
		}
	}
	w.scrapped += cleared
	return cleared
}

// Outbound 出库：先清退过期库存，再按 (到期时间, 批次ID) 升序消耗，
// 跳过质检冻结批次；整单不足则不发生任何消耗。
func (w *Warehouse) Outbound(sku string, qty int, now time.Time) ([]Allocation, error) {
	if qty <= 0 {
		return nil, ErrInvalidQuantity
	}
	// 过期时刻先清退再出库。
	w.ClearExpired(now)

	var candidates []*Batch
	available := 0
	for _, b := range w.batches {
		if b.SKU != sku || b.Frozen || b.expired(now) {
			continue
		}
		if stock := b.Stock(); stock > 0 {
			candidates = append(candidates, b)
			available += stock
		}
	}
	// 整单不足则无消耗。
	if available < qty {
		return nil, ErrInsufficientStock
	}

	sort.Slice(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if !a.ExpiresAt.Equal(b.ExpiresAt) {
			return a.ExpiresAt.Before(b.ExpiresAt)
		}
		return a.ID < b.ID
	})

	remaining := qty
	var allocs []Allocation
	for _, b := range candidates {
		if remaining == 0 {
			break
		}
		took := 0
		for _, p := range b.pieces {
			if remaining == 0 {
				break
			}
			if p.State == PieceInStock {
				p.State = PieceConsumed
				remaining--
				took++
			}
		}
		if took > 0 {
			allocs = append(allocs, Allocation{BatchID: b.ID, Quantity: took})
		}
	}
	w.consumed += qty
	return allocs, nil
}

// Refund 退款回原批次；若原批在退款时刻已过期，退回件直接报废。
// 返回回库件数与报废件数。
func (w *Warehouse) Refund(batchID string, qty int, now time.Time) (restocked, scrapped int, err error) {
	if qty <= 0 {
		return 0, 0, ErrInvalidQuantity
	}
	b, ok := w.batches[batchID]
	if !ok {
		return 0, 0, ErrBatchNotFound
	}
	state := PieceInStock
	if b.expired(now) {
		state = PieceScrapped
	}
	for i := 0; i < qty; i++ {
		b.pieces = append(b.pieces, &Piece{ID: w.nextPieceID, State: state})
		w.nextPieceID++
	}
	w.refunded += qty
	if state == PieceScrapped {
		w.scrapped += qty
		return 0, qty, nil
	}
	return qty, 0, nil
}

// Batch 返回批次（只读视图语义：调用方不应修改其字段）。
func (w *Warehouse) Batch(batchID string) (*Batch, bool) {
	b, ok := w.batches[batchID]
	return b, ok
}

// StockOf 返回某 SKU 当前可出库的在库总量（含冻结批次的在库件，
// 冻结仅影响消耗资格，不影响在库事实）。
func (w *Warehouse) StockOf(sku string) int {
	n := 0
	for _, b := range w.batches {
		if b.SKU == sku {
			n += b.Stock()
		}
	}
	return n
}

// Totals 返回账目计数器：入库、退款、消耗、报废。
func (w *Warehouse) Totals() (inbound, refunded, consumed, scrapped int) {
	return w.inbound, w.refunded, w.consumed, w.scrapped
}

// Verify 用逐件模型全量核验账目：
//   - 每个件归属唯一批次、ID 全局唯一；
//   - 各状态件数与计数器一致；
//   - 守恒式：入库 + 退款 = 在库 + 消耗 + 报废。
func (w *Warehouse) Verify() error {
	seen := make(map[int]string)
	counts := map[PieceState]int{}
	total := 0
	for _, b := range w.batches {
		for _, p := range b.pieces {
			if prev, dup := seen[p.ID]; dup {
				return fmt.Errorf("piece %d belongs to both batch %s and %s", p.ID, prev, b.ID)
			}
			seen[p.ID] = b.ID
			counts[p.State]++
			total++
		}
	}
	if total != w.inbound+w.refunded {
		return fmt.Errorf("piece count %d != inbound %d + refunded %d", total, w.inbound, w.refunded)
	}
	if counts[PieceConsumed] != w.consumed {
		return fmt.Errorf("consumed pieces %d != counter %d", counts[PieceConsumed], w.consumed)
	}
	if counts[PieceScrapped] != w.scrapped {
		return fmt.Errorf("scrapped pieces %d != counter %d", counts[PieceScrapped], w.scrapped)
	}
	if counts[PieceInStock] != w.inbound+w.refunded-w.consumed-w.scrapped {
		return fmt.Errorf("in-stock pieces %d violate conservation (in %d + refund %d - consumed %d - scrapped %d)",
			counts[PieceInStock], w.inbound, w.refunded, w.consumed, w.scrapped)
	}
	return nil
}

// BatchStock 返回指定批次的在库件数；批次不存在返回 0。
func (w *Warehouse) BatchStock(batchID string) int {
	if b, ok := w.batches[batchID]; ok {
		return b.Stock()
	}
	return 0
}
