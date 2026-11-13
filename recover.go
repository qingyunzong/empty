package dataeng

import (
	"errors"
	"fmt"
	"io"
)

// ResumeMode 描述恢复决策的结果。
type ResumeMode int

const (
	// ResumeFresh 表示没有可用状态，按 Options.StartAtHead 从头或从尾开始。
	ResumeFresh ResumeMode = iota
	// ResumeCursor 表示游标验证通过，从游标之后继续。
	ResumeCursor
	// ResumeBackfill 表示游标已失效（如 vacuum 清理），
	// 回退到按 realtime 时间补扫。
	ResumeBackfill
)

func (m ResumeMode) String() string {
	switch m {
	case ResumeCursor:
		return "cursor"
	case ResumeBackfill:
		return "backfill"
	default:
		return "fresh"
	}
}

// Options 控制连接器的恢复与去重行为。
type Options struct {
	// StartAtHead 为 true 时无状态从 journal 头部开始读，
	// 否则从尾部开始（只消费新条目）。
	StartAtHead bool
	// UniqueFields 是补扫去重使用的唯一字段集，空则取 DefaultUniqueFields。
	UniqueFields []string
	// DedupCapacity 是去重窗口容量，<= 0 时取默认值。
	DedupCapacity int
}

// Connector 是主机日志连接器的读取侧：封装恢复决策、
// 补扫过滤与去重，并维护可持久化的消费状态。
type Connector struct {
	r      Reader
	dedup  *Deduper
	saved  State // Open 时传入的状态，补扫过滤的基准
	state  State // 当前消费位置，随每条投递更新
	mode   ResumeMode
	filter bool // 是否需要按 saved 做补扫过滤
}

// Open 依据持久化状态恢复读取位置：
//
//  1. 状态为空：按 Options.StartAtHead 定位头/尾；
//  2. 状态非空：先用 ValidateCursor 验证游标对应条目是否仍在，
//     在则从游标后继续；
//  3. 游标失效（vacuum 等）：回退到按 realtime 补扫，
//     补扫期间用 saved 状态过滤确定已覆盖的条目，并用去重窗口
//     吸收无法证明已覆盖的重叠条目（跨 boot 单调时间不可比的情形）。
func Open(r Reader, saved State, opts *Options) (*Connector, error) {
	if r == nil {
		return nil, errors.New("dataeng: nil journal reader")
	}
	if err := saved.Validate(); err != nil {
		return nil, err
	}
	var o Options
	if opts != nil {
		o = *opts
	}
	c := &Connector{
		r:     r,
		dedup: NewDeduper(o.DedupCapacity, o.UniqueFields...),
		saved: saved,
		state: saved,
	}
	switch {
	case saved.IsZero():
		c.mode = ResumeFresh
		var err error
		if o.StartAtHead {
			err = r.SeekHead()
		} else {
			err = r.SeekTail()
		}
		if err != nil {
			return nil, fmt.Errorf("dataeng: fresh seek: %w", err)
		}
	default:
		ok, err := ValidateCursor(r, saved.Cursor)
		if err != nil {
			return nil, fmt.Errorf("dataeng: validate cursor: %w", err)
		}
		if ok {
			c.mode = ResumeCursor
			break
		}
		c.mode = ResumeBackfill
		c.filter = true
		if err := r.SeekRealtime(saved.Realtime); err != nil {
			return nil, fmt.Errorf("dataeng: backfill seek: %w", err)
		}
	}
	return c, nil
}

// Mode 返回本次 Open 的恢复决策。
func (c *Connector) Mode() ResumeMode {
	return c.mode
}

// State 返回当前消费位置，可持久化后用于下次 Open。
func (c *Connector) State() State {
	return c.state
}

// Deduper 暴露内部去重器，便于调用方在 Open 后补种历史键
// （例如从外部快照恢复去重窗口），或观测窗口水位。
func (c *Connector) Deduper() *Deduper {
	return c.dedup
}

// Next 返回下一条应投递的条目；读到 journal 当前末尾返回 io.EOF。
//
// 补扫模式下跳过确定已被 saved 覆盖的条目；所有模式下重叠于
// 去重窗口的条目都会被丢弃。每投递一条，内部状态随之推进。
func (c *Connector) Next() (*Entry, error) {
	for {
		ok, err := c.r.Next()
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, io.EOF
		}
		e, err := c.r.Entry()
		if err != nil {
			return nil, err
		}
		if cur, err := c.r.Cursor(); err == nil {
			e.Cursor = cur
		}
		if c.filter && coveredByState(c.saved, e) {
			continue
		}
		if c.dedup.Seen(e) {
			continue
		}
		c.state = stateFromEntry(e)
		return e, nil
	}
}
