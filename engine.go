package fefo

import (
	"fmt"
	"sort"
	"time"
)

// Batch 是一个库存批次。
type Batch struct {
	ID     string
	SKU    string
	Expiry time.Time
	OnHand int
}

// Allocation 记录一次订单履约从哪个批次出了多少货。
type Allocation struct {
	Date    time.Time
	OrderID string
	SKU     string
	BatchID string
	Qty     int
}

// Return 记录一笔退货的去向：恢复原批或归报废。
type Return struct {
	Date     time.Time
	OrderID  string
	SKU      string
	BatchID  string
	Qty      int
	Restored bool // true=恢复未到期原批；false=已过期归报废
}

// Flow 是某 SKU 在某日的库存流量，用于与逐日库存模型核对。
type Flow struct {
	Date  time.Time
	SKU   string
	In    int // 收货入库
	Out   int // 订单出库
	Ret   int // 退货恢复库存
	Scrap int // 过期退货报废
}

// Engine 由事件序列重放得到的全量状态。
type Engine struct {
	Batches map[string]*Batch
	Allocs  []Allocation
	Returns []Return
	Flows   []Flow

	shipped  map[string]int            // 订单号 -> 净出库（出库-退货）
	allocIdx map[string]map[string]int // 订单号 -> 批次 -> 净分配量
}

// Replay 从零重放生效事件序列，构造引擎状态。任何事件非法即报错。
func Replay(events []Event) (*Engine, error) {
	e := &Engine{
		Batches:  map[string]*Batch{},
		shipped:  map[string]int{},
		allocIdx: map[string]map[string]int{},
	}
	for _, ev := range events {
		var err error
		switch ev.Kind {
		case KindReceipt:
			err = e.applyReceipt(ev)
		case KindOrder:
			err = e.applyOrder(ev)
		case KindReturn:
			err = e.applyReturn(ev)
		default:
			err = fmt.Errorf("事件 %d: 未知类型 %d", ev.ID, ev.Kind)
		}
		if err != nil {
			return nil, err
		}
	}
	return e, nil
}

func (e *Engine) flow(date time.Time, sku string) *Flow {
	for i := range e.Flows {
		if e.Flows[i].Date.Equal(date) && e.Flows[i].SKU == sku {
			return &e.Flows[i]
		}
	}
	e.Flows = append(e.Flows, Flow{Date: date, SKU: sku})
	return &e.Flows[len(e.Flows)-1]
}

func (e *Engine) applyReceipt(ev Event) error {
	if ev.BatchID == "" || ev.SKU == "" || ev.Qty <= 0 {
		return fmt.Errorf("事件 %d: 收货字段非法", ev.ID)
	}
	if _, dup := e.Batches[ev.BatchID]; dup {
		return fmt.Errorf("事件 %d: 批次 %q 重复入库", ev.ID, ev.BatchID)
	}
	e.Batches[ev.BatchID] = &Batch{ID: ev.BatchID, SKU: ev.SKU, Expiry: ev.Expiry, OnHand: ev.Qty}
	e.flow(ev.Date, ev.SKU).In += ev.Qty
	return nil
}

// applyOrder 按 FEFO 分配：在订单日期未到期（Expiry >= Date）且有余量的
// 批次中，按到期日升序（并列按批次号）依次扣减，直到满足订单数量。
func (e *Engine) applyOrder(ev Event) error {
	if ev.OrderID == "" || ev.SKU == "" || ev.Qty <= 0 {
		return fmt.Errorf("事件 %d: 订单字段非法", ev.ID)
	}
	var cand []*Batch
	for _, b := range e.Batches {
		if b.SKU == ev.SKU && b.OnHand > 0 && !b.Expiry.Before(ev.Date) {
			cand = append(cand, b)
		}
	}
	sort.Slice(cand, func(i, j int) bool {
		if !cand[i].Expiry.Equal(cand[j].Expiry) {
			return cand[i].Expiry.Before(cand[j].Expiry)
		}
		return cand[i].ID < cand[j].ID
	})
	avail := 0
	for _, b := range cand {
		avail += b.OnHand
	}
	if avail < ev.Qty {
		return fmt.Errorf("事件 %d: 订单 %q SKU %q 需求 %d，可用未到期库存仅 %d",
			ev.ID, ev.OrderID, ev.SKU, ev.Qty, avail)
	}
	need := ev.Qty
	for _, b := range cand {
		if need == 0 {
			break
		}
		take := min(b.OnHand, need)
		b.OnHand -= take
		need -= take
		e.Allocs = append(e.Allocs, Allocation{
			Date: ev.Date, OrderID: ev.OrderID, SKU: ev.SKU, BatchID: b.ID, Qty: take,
		})
		if e.allocIdx[ev.OrderID] == nil {
			e.allocIdx[ev.OrderID] = map[string]int{}
		}
		e.allocIdx[ev.OrderID][b.ID] += take
	}
	e.shipped[ev.OrderID] += ev.Qty
	e.flow(ev.Date, ev.SKU).Out += ev.Qty
	return nil
}

// applyReturn 退货须对应原订单的原批次；退货日批次未到期则恢复原批库存，
// 已到期（Expiry < Date）则归报废。
func (e *Engine) applyReturn(ev Event) error {
	if ev.OrderID == "" || ev.BatchID == "" || ev.Qty <= 0 {
		return fmt.Errorf("事件 %d: 退货字段非法", ev.ID)
	}
	b, ok := e.Batches[ev.BatchID]
	if !ok {
		return fmt.Errorf("事件 %d: 退货批次 %q 不存在", ev.ID, ev.BatchID)
	}
	if b.SKU != ev.SKU {
		return fmt.Errorf("事件 %d: 退货 SKU %q 与批次 %q 的 SKU %q 不符",
			ev.ID, ev.SKU, ev.BatchID, b.SKU)
	}
	net := e.allocIdx[ev.OrderID][ev.BatchID]
	if ev.Qty > net {
		return fmt.Errorf("事件 %d: 订单 %q 批次 %q 净分配 %d，不足以退货 %d",
			ev.ID, ev.OrderID, ev.BatchID, net, ev.Qty)
	}
	r := Return{Date: ev.Date, OrderID: ev.OrderID, SKU: ev.SKU, BatchID: ev.BatchID, Qty: ev.Qty}
	if b.Expiry.Before(ev.Date) {
		e.flow(ev.Date, ev.SKU).Scrap += ev.Qty
	} else {
		b.OnHand += ev.Qty
		r.Restored = true
		e.flow(ev.Date, ev.SKU).Ret += ev.Qty
	}
	e.Returns = append(e.Returns, r)
	e.allocIdx[ev.OrderID][ev.BatchID] -= ev.Qty
	e.shipped[ev.OrderID] -= ev.Qty
	return nil
}

// Totals 返回全局守恒量：累计入库、在库、净出库、报废。
// 退货无论恢复还是报废都冲减净出库；报废的退货不再回到在库，
// 因此守恒式为：入库 = 在库 + 净出库 + 报废。
func (e *Engine) Totals() (in, onHand, shipped, scrap int) {
	for _, f := range e.Flows {
		in += f.In
		shipped += f.Out - f.Ret - f.Scrap
		scrap += f.Scrap
	}
	for _, b := range e.Batches {
		onHand += b.OnHand
	}
	return
}
