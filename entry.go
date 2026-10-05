// Package ledger 维护按时间及 ID 排序的带符号费用条目，
// 提供累计查询、首次越界定位、冲正撤销、双索引原子发布与故障恢复核对。
package ledger

import (
	"errors"
	"fmt"
	"time"
)

// Kind 区分普通费用条目与冲正条目。
type Kind int

const (
	KindNormal   Kind = iota // 普通费用
	KindReversal             // 冲正（撤销旧条目时新增，金额为负）
)

// Entry 是一条带符号费用。Amount 为正表示费用，为负表示负费用或冲正。
type Entry struct {
	ID           string    // 全局唯一，同时间戳下作为排序决胜键
	BusinessTime time.Time // 业务时间轴
	SubmitTime   time.Time // 提交时间轴
	Amount       int64     // 带符号金额（最小货币单位）
	BatchID      string    // 所属结算批
	Kind         Kind
	ReversesID   string // 仅冲正条目：被冲正的原始条目 ID
}

// Batch 是已锁结算批：锁定后条目不可改，只能整体提交到账本。
type Batch struct {
	ID      string
	Entries []Entry
	Locked  bool
}

// NewBatch 构造未锁批次。
func NewBatch(id string) *Batch { return &Batch{ID: id} }

// Add 向未锁批次追加条目，并强制回填 BatchID。
func (b *Batch) Add(e Entry) error {
	if b.Locked {
		return fmt.Errorf("batch %s is locked", b.ID)
	}
	if e.ID == "" {
		return errors.New("entry ID must not be empty")
	}
	e.BatchID = b.ID
	b.Entries = append(b.Entries, e)
	return nil
}

// Lock 锁定批次，之后不可再增删改条目。
func (b *Batch) Lock() { b.Locked = true }

// ErrBatchNotLocked 表示试图提交未锁定的结算批。
var ErrBatchNotLocked = errors.New("ledger: settlement batch must be locked before commit")

// ErrDuplicateID 表示条目 ID 与账本中已有条目冲突。
var ErrDuplicateID = errors.New("ledger: duplicate entry ID")
