// Package dataeng 在乱序遥测事件流上发现“同 key 下 A 之后出现 B，
// 且闭区间内不存在 C”的模式，并依据水位按确定顺序交付结果。
//
// 事件含 key、类型（仅 A/B/C）、唯一 ID 与 int64 时间戳，可乱序到达。
// 对同 key 的每个 A，匹配严格晚于该 A、且不晚于 A 时间加 D 的首个 B；
// 时间相同的候选 B 按 ID 字节序取最小者。若闭区间 [A 时间, B 时间]
// 内存在同 key 的 C，则该 A 不输出。同一个 B 可被多个 A 复用。
//
// 水位 W 承诺后续到达事件的时间不小于 W。仅当 W 严格大于 A 时间加 D 后，
// 该 A 的结果才视为已确定并可交付；交付顺序按 A 时间、再按 A 的 ID 字节序。
// 结束（End）等价于将水位推进到正无穷，会确定并交付全部剩余结果。
// 所有时间运算使用 math/big 数学整数，避免 int64 加法溢出。
//
// 相同 ID 相同内容的事件重复投递为幂等操作；相同 ID 但内容不一致、
// 以及任何违反水位承诺（迟到事件或水位回退）的调用都会被拒绝，且状态不变。
package dataeng

import (
	"errors"
	"math"
	"math/big"
	"sort"
	"sync"
)

// EventType 是事件类型，仅允许 TypeA、TypeB、TypeC。
type EventType int

const (
	// TypeA 是触发匹配的起始事件。
	TypeA EventType = iota
	// TypeB 是被 A 匹配的目标事件。
	TypeB
	// TypeC 是抑制匹配的否定事件。
	TypeC
)

// ErrUnknownType 表示事件类型不属于 A/B/C。
var ErrUnknownType = errors.New("dataeng: unknown event type")

// ErrEmptyID 表示事件缺少唯一 ID。
var ErrEmptyID = errors.New("dataeng: empty event id")

// ErrDuplicateConflict 表示相同 ID 的事件内容与已记录事件不一致。
var ErrDuplicateConflict = errors.New("dataeng: conflicting event with same id")

// ErrLateEvent 表示事件时间小于当前水位，违反水位承诺。
var ErrLateEvent = errors.New("dataeng: event time below watermark")

// ErrWatermarkBackwards 表示新水位不大于当前水位。
var ErrWatermarkBackwards = errors.New("dataeng: watermark must strictly advance")

// ErrClosed 表示关联器已结束，不再接受事件或水位推进。
var ErrClosed = errors.New("dataeng: correlator closed")

// ErrInvalidD 表示关联窗口 D 不是非负整数。
var ErrInvalidD = errors.New("dataeng: window D must be non-negative")

// Event 是一条遥测事件。时间戳为 int64，由关联器在内部提升为
// 数学整数参与运算，因此 int64 边界上的加减不会溢出。
type Event struct {
	Key  string
	Type EventType
	ID   string
	Time int64
}

// Result 是一个已确定的 A→B 匹配。AID 为起始事件 ID，BID 为被匹配的
// 首个 B 的 ID；ATime、BTime 为对应事件时间，Key 为二者共享的 key。
type Result struct {
	Key   string
	AID   string
	BID   string
	ATime int64
	BTime int64
}

type storedEvent struct {
	id   string
	time int64
	typ  EventType
}

// Correlator 是并发安全的事件关联器。零值不可用，须经 NewCorrelator 构造。
type Correlator struct {
	mu        sync.Mutex
	d         big.Int
	events    map[string][]storedEvent // key -> 该 key 下全部已接受事件
	byID      map[string]Event         // 全局唯一 ID -> 首次接受的事件内容
	delivered map[string]bool          // 已交付 A 的事件 ID
	watermark big.Int
	wmSet     bool // 是否已显式推进过水位
	ended     bool
}

// NewCorrelator 以数学整数形式的非负窗口 D 构造关联器。
// D 为 nil 或负数时返回 ErrInvalidD。
func NewCorrelator(d *big.Int) (*Correlator, error) {
	if d == nil || d.Sign() < 0 {
		return nil, ErrInvalidD
	}
	c := &Correlator{
		events:    make(map[string][]storedEvent),
		byID:      make(map[string]Event),
		delivered: make(map[string]bool),
	}
	c.d.Set(d)
	return c, nil
}

// NewCorrelatorInt64 以 int64 非负窗口 D 构造关联器。
func NewCorrelatorInt64(d int64) (*Correlator, error) {
	if d < 0 {
		return nil, ErrInvalidD
	}
	return NewCorrelator(big.NewInt(d))
}

// Ingest 接受一条事件。重复投递相同 ID 且内容一致的事件为幂等操作；
// ID 已存在但内容不一致、事件迟到（时间小于水位）或关联器已结束时，
// 调用被拒绝且内部状态不变。
func (c *Correlator) Ingest(e Event) error {
	if e.Type != TypeA && e.Type != TypeB && e.Type != TypeC {
		return ErrUnknownType
	}
	if e.ID == "" {
		return ErrEmptyID
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ended {
		return ErrClosed
	}
	if prev, ok := c.byID[e.ID]; ok {
		if prev != e {
			return ErrDuplicateConflict
		}
		return nil
	}
	if c.wmSet && big.NewInt(e.Time).Cmp(&c.watermark) < 0 {
		return ErrLateEvent
	}
	c.byID[e.ID] = e
	c.events[e.Key] = append(c.events[e.Key], storedEvent{
		id:   e.ID,
		time: e.Time,
		typ:  e.Type,
	})
	return nil
}

// AdvanceWatermark 将水位严格推进到 w。水位承诺后续事件时间不小于 w：
// 水位回退、关联器已结束都会被拒绝且状态不变。推进后不会自动交付结果，
// 需通过 Drain 取走本次新确定的匹配。
func (c *Correlator) AdvanceWatermark(w *big.Int) error {
	if w == nil {
		return errors.New("dataeng: nil watermark")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ended {
		return ErrClosed
	}
	if c.wmSet && w.Cmp(&c.watermark) <= 0 {
		return ErrWatermarkBackwards
	}
	c.watermark.Set(w)
	c.wmSet = true
	return nil
}

// End 将水位推进到正无穷并交付所有此前未交付的已确定匹配。
// 结束后关联器不再接受事件或水位推进。重复调用 End 返回空结果且不报错。
func (c *Correlator) End() []Result {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.ended {
		c.ended = true
	}
	return c.drainLocked(true)
}

// Drain 交付在当前水位下新确定的匹配。只有当水位严格大于 A 时间加 D 时，
// A 的结果才确定；结果按 A 时间、再按 A 的 ID 字节序排序。
// 每次调用只返回自上次交付以来新确定的结果。
func (c *Correlator) Drain() []Result {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.drainLocked(false)
}

// drainLocked 执行确定性匹配与交付。flushAll 为 true 时（End）忽略水位
// 限制，确定全部剩余 A；否则仅确定 A 时间加 D 严格小于当前水位的 A。
func (c *Correlator) drainLocked(flushAll bool) []Result {
	limit := new(big.Int)
	var results []Result
	for key, evs := range c.events {
		ordered := make([]storedEvent, len(evs))
		copy(ordered, evs)
		sort.SliceStable(ordered, func(i, j int) bool {
			if ordered[i].time != ordered[j].time {
				return ordered[i].time < ordered[j].time
			}
			return ordered[i].id < ordered[j].id
		})
		for _, a := range ordered {
			if a.typ != TypeA || c.delivered[a.id] {
				continue
			}
			aTime := big.NewInt(a.time)
			limit.Add(aTime, &c.d)
			if !flushAll && c.watermark.Cmp(limit) <= 0 {
				continue
			}
			var b *storedEvent
			for i := range ordered {
				candidate := &ordered[i]
				if candidate.typ != TypeB {
					continue
				}
				cTime := big.NewInt(candidate.time)
				if cTime.Cmp(aTime) <= 0 || cTime.Cmp(limit) > 0 {
					continue
				}
				b = candidate
				break
			}
			if b == nil {
				// 窗口已关闭且不存在合格 B，该 A 永久不输出。
				c.delivered[a.id] = true
				continue
			}
			suppressed := false
			for _, e := range ordered {
				if e.typ != TypeC {
					continue
				}
				eTime := big.NewInt(e.time)
				if eTime.Cmp(aTime) >= 0 && eTime.Cmp(big.NewInt(b.time)) <= 0 {
					suppressed = true
					break
				}
			}
			c.delivered[a.id] = true
			if suppressed {
				continue
			}
			results = append(results, Result{
				Key:   key,
				AID:   a.id,
				BID:   b.id,
				ATime: a.time,
				BTime: b.time,
			})
		}
	}
	sort.Slice(results, func(i, j int) bool {
		if results[i].ATime != results[j].ATime {
			return results[i].ATime < results[j].ATime
		}
		return results[i].AID < results[j].AID
	})
	return results
}

// Watermark 返回当前水位的副本。结束后返回的结果表示正无穷这一状态，
// 此时 Closed 返回 true。
func (c *Correlator) Watermark() big.Int {
	c.mu.Lock()
	defer c.mu.Unlock()
	w := new(big.Int)
	if c.wmSet {
		w.Set(&c.watermark)
	} else {
		w.SetInt64(math.MinInt64)
	}
	return *w
}

// Closed 报告关联器是否已结束。
func (c *Correlator) Closed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ended
}
