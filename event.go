// Package fefo 实现配货库的事件溯源模型：
// 批次按最早到期日优先（FEFO）分配，订单可跨日期分多次履约，
// 退货仅恢复未到期原批、已过期归报废，事件更正通过重放生效。
package fefo

import "time"

// Kind 事件类型。
type Kind int

const (
	KindReceipt Kind = iota // 收货入库，产生批次
	KindOrder               // 订单履约（同一订单号可跨日期多次出现）
	KindReturn              // 退货，须指明原批次
	KindCorrect             // 更正历史事件，触发重放
)

// Event 是日志中的一条事件。不同 Kind 使用不同字段：
//   - Receipt: SKU, Qty, BatchID, Expiry
//   - Order:   SKU, Qty, OrderID
//   - Return:  SKU, Qty, OrderID, BatchID（须为该订单原分配批次）
//   - Correct: TargetID, Replace（Replace 为 nil 表示作废目标事件）
type Event struct {
	ID   int       // 日志内唯一编号，由 Journal 分配
	Seq  int       // 到达顺序，同日事件按此排序
	Date time.Time // 业务日期（仅取日期部分）
	Kind Kind

	SKU     string
	Qty     int
	BatchID string
	Expiry  time.Time
	OrderID string

	TargetID int
	Replace  *Event
}

// day 取日期部分（UTC 零点），保证可比较、可作 map 键。
func day(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// Journal 是只追加的事件日志。更正事件不修改原记录，
// 而是在 Resolve 时生成生效事件序列。
type Journal struct {
	events []Event
	nextID int
}

// Append 追加事件并返回其编号。
func (j *Journal) Append(e Event) int {
	j.nextID++
	e.ID = j.nextID
	e.Seq = len(j.events)
	e.Date = day(e.Date)
	e.Expiry = day(e.Expiry)
	j.events = append(j.events, e)
	return e.ID
}

// Resolve 应用全部更正，生成生效事件序列：
// 按 (Date, Seq) 稳定排序；被作废的事件剔除，被替换的事件以
// 替换内容参与重放（保留原编号）。同一目标多次更正时后者生效。
func (j *Journal) Resolve() []Event {
	repl := map[int]*Event{}
	voided := map[int]bool{}
	for _, e := range j.events {
		if e.Kind != KindCorrect {
			continue
		}
		if e.Replace == nil {
			voided[e.TargetID] = true
			delete(repl, e.TargetID)
		} else {
			r := *e.Replace
			r.ID = e.TargetID
			r.Date = day(r.Date)
			r.Expiry = day(r.Expiry)
			repl[e.TargetID] = &r
			delete(voided, e.TargetID)
		}
	}
	var out []Event
	for _, e := range j.events {
		if e.Kind == KindCorrect || voided[e.ID] {
			continue
		}
		if r, ok := repl[e.ID]; ok {
			r.Seq = e.Seq
			out = append(out, *r)
			continue
		}
		out = append(out, e)
	}
	sortStable(out)
	return out
}

func sortStable(es []Event) {
	// 插入排序保持稳定：先按日期，同日期保持到达顺序。
	for i := 1; i < len(es); i++ {
		for k := i; k > 0 && es[k].Date.Before(es[k-1].Date); k-- {
			es[k], es[k-1] = es[k-1], es[k]
		}
	}
}
