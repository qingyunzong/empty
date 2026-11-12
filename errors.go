package dataeng

import (
	"errors"
	"fmt"
)

// FailureKind 标识整批操作被拒绝的具体原因。
type FailureKind int

const (
	// KindReverseInterval 表示存在起止颠倒或起止值无法构成半开区间的记录。
	KindReverseInterval FailureKind = iota + 1
	// KindDuplicateID 表示新增批次内存在重复记录 ID，或该 ID 在库中已存在。
	KindDuplicateID
	// KindMissingID 表示待删除的记录 ID 在库中不存在。
	KindMissingID
)

// BatchError 汇总一次原子批操作中所有被拒绝的记录 ID。
// 任意错误存在时整批操作都不会生效，库内状态保持调用前不变。
type BatchError struct {
	Kind  FailureKind
	IDs   []string
	Op    string
	Extra error
}

func (e *BatchError) Error() string {
	if e.Extra != nil {
		return fmt.Sprintf("dataeng: batch %s rejected (%s): %v", e.Op, e.kindName(), e.Extra)
	}
	return fmt.Sprintf("dataeng: batch %s rejected (%s): %d record(s): %v",
		e.Op, e.kindName(), len(e.IDs), e.IDs)
}

func (e *BatchError) Unwrap() error { return e.Extra }

// Is 仅按错误类别比较，使调用方可用 errors.Is(err, ErrDuplicateID) 之类的哨兵判断。
func (e *BatchError) Is(target error) bool {
	switch target {
	case ErrReverseInterval:
		return e.Kind == KindReverseInterval
	case ErrDuplicateID:
		return e.Kind == KindDuplicateID
	case ErrMissingID:
		return e.Kind == KindMissingID
	}
	return false
}

func (e *BatchError) kindName() string {
	switch e.Kind {
	case KindReverseInterval:
		return "reverse interval"
	case KindDuplicateID:
		return "duplicate id"
	case KindMissingID:
		return "missing id"
	default:
		return "unknown"
	}
}

// 哨兵错误，供 errors.Is / errors.As 匹配。
var (
	ErrReverseInterval = &BatchError{Kind: KindReverseInterval, Op: "op"}
	ErrDuplicateID     = &BatchError{Kind: KindDuplicateID, Op: "op"}
	ErrMissingID       = &BatchError{Kind: KindMissingID, Op: "op"}
)

// ErrChildNotFound 表示查询或删除时指定的子记录 ID 不存在。
var ErrChildNotFound = errors.New("dataeng: child record not found")
