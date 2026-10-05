// Package streamjoin 提供基于事件时间的双流区间连接（interval join）。
//
// 语义：
//   - 两侧事件按键相等且 |tL-tR| <= d（边界等于 d 包含）即匹配，一对多；
//   - 某侧事件在对侧水位超过其候选最晚时刻（t+d）后才输出未匹配行；
//   - 同一 ID 再次 Add 视为更正，先撤回旧版本产生的全部输出，再按新版本输出。
package streamjoin

import "math"

// Side 标识输入流。
type Side int

const (
	Left Side = iota
	Right
)

// Event 是一条输入事件。ID 在同一侧内唯一，用于更正。
type Event struct {
	ID    string
	Key   string
	Time  int64
	Value string
}

// Record 是一条输出记录。Retract 为 true 表示撤回此前发出的同一记录；
// Left 或 Right 为 nil 表示对侧未匹配（外连接行）。
type Record struct {
	Retract bool
	Left    *Event
	Right   *Event
}

type entry struct {
	ev   Event
	solo bool // 未匹配行是否已输出
}

// Joiner 维护两流状态并产生增量输出，输出通过 Drain 取走。
type Joiner struct {
	d   int64
	buf [2]map[string]*entry
	wm  [2]int64
	out []Record
}

// New 创建时间差窗口为 d 的 Joiner。
func New(d int64) *Joiner {
	if d < 0 {
		panic("streamjoin: negative window")
	}
	return &Joiner{
		d:   d,
		buf: [2]map[string]*entry{{}, {}},
		wm:  [2]int64{math.MinInt64, math.MinInt64},
	}
}

// Add 将事件加入指定侧；同 ID 重复加入视为更正。
func (j *Joiner) Add(side Side, e Event) {
	mine := j.buf[side]
	if old, ok := mine[e.ID]; ok {
		j.retractPairs(side, old.ev)
		if old.solo {
			j.out = append(j.out, soloRecord(true, side, old.ev))
		}
		delete(mine, e.ID)
	}
	mine[e.ID] = &entry{ev: e}
	j.reconcile()
	j.emitPairs(side, e)
}

// Advance 推进指定侧水位；水位只增不减。对侧中候选最晚时刻已被超过
// 且仍无匹配的事件，在此输出未匹配行。
func (j *Joiner) Advance(side Side, wm int64) {
	if wm > j.wm[side] {
		j.wm[side] = wm
	}
	j.reconcile()
}

// Drain 取走并清空自上次 Drain 以来累积的输出记录。
func (j *Joiner) Drain() []Record {
	out := j.out
	j.out = nil
	return out
}

func (j *Joiner) emitPairs(side Side, e Event) {
	for _, o := range j.buf[1-side] {
		if matched(j.d, e, o.ev) {
			j.out = append(j.out, pairRecord(false, side, e, o.ev))
		}
	}
}

func (j *Joiner) retractPairs(side Side, e Event) {
	for _, o := range j.buf[1-side] {
		if matched(j.d, e, o.ev) {
			j.out = append(j.out, pairRecord(true, side, e, o.ev))
		}
	}
}

// reconcile 使每个事件的未匹配行输出状态收敛到期望状态：
// 当前无匹配且对侧水位已超过 t+d 时应已输出，否则不应输出。
func (j *Joiner) reconcile() {
	for side := Left; side <= Right; side++ {
		other := 1 - side
		for _, en := range j.buf[side] {
			want := j.wm[other] > en.ev.Time+j.d && !j.hasMatch(side, en.ev)
			if want == en.solo {
				continue
			}
			en.solo = want
			j.out = append(j.out, soloRecord(!want, side, en.ev))
		}
	}
}

func (j *Joiner) hasMatch(side Side, e Event) bool {
	for _, o := range j.buf[1-side] {
		if matched(j.d, e, o.ev) {
			return true
		}
	}
	return false
}

func matched(d int64, a, b Event) bool {
	if a.Key != b.Key {
		return false
	}
	if a.Time >= b.Time {
		return a.Time-b.Time <= d
	}
	return b.Time-a.Time <= d
}

func pairRecord(retract bool, side Side, e, o Event) Record {
	ec, oc := e, o
	if side == Left {
		return Record{Retract: retract, Left: &ec, Right: &oc}
	}
	return Record{Retract: retract, Left: &oc, Right: &ec}
}

func soloRecord(retract bool, side Side, e Event) Record {
	ec := e
	if side == Left {
		return Record{Retract: retract, Left: &ec}
	}
	return Record{Retract: retract, Right: &ec}
}
