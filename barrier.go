// Package barrier 实现按任务 ID 汇聚终结通知的屏障。
//
// 语义：
//   - 目标集合通过 Add 追加，Seal 封口后固定；
//   - Complete / Revoke 按 ID 上报终结，每个 ID 只计一次；
//   - 重复通知若结果相同则幂等忽略，结果不同则记录并报告冲突；
//   - Wait 阻塞至集合封口且全部终结，返回固定的结果快照。
package barrier

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
)

// Outcome 表示任务的终结方式。
type Outcome int

const (
	// Completed 任务正常完成，携带结果值。
	Completed Outcome = iota
	// Revoked 任务被撤销，无结果值。
	Revoked
)

func (o Outcome) String() string {
	switch o {
	case Completed:
		return "completed"
	case Revoked:
		return "revoked"
	default:
		return "unknown"
	}
}

// Result 是某个任务 ID 的终结结果。
type Result struct {
	ID      string
	Outcome Outcome
	Value   any // 仅 Completed 时有意义
}

// Conflict 记录同一 ID 的重复通知产生了不同结果。
// 首次通知的结果生效，后续冲突结果仅被记录。
type Conflict struct {
	ID     string
	First  Result
	Second Result
}

// ConflictError 在重复通知结果不一致时返回。
type ConflictError struct {
	Conflict Conflict
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("barrier: conflicting notification for %q: first %s, then %s",
		e.Conflict.ID, e.Conflict.First.Outcome, e.Conflict.Second.Outcome)
}

var (
	// ErrSealed 表示集合已封口，不能再追加任务。
	ErrSealed = errors.New("barrier: set is sealed")
	// ErrUnknownID 表示通知的 ID 不在目标集合中。
	ErrUnknownID = errors.New("barrier: unknown task id")
	// ErrDuplicateID 表示追加的 ID 已在目标集合中。
	ErrDuplicateID = errors.New("barrier: duplicate task id")
)

// Barrier 汇聚目标集合中所有任务的终结通知。
// 零值不可用，请使用 New 构造。所有方法并发安全。
type Barrier struct {
	mu        sync.Mutex
	pending   map[string]struct{} // 已加入集合、尚未终结的 ID
	results   map[string]Result   // 已终结 ID 的生效结果
	conflicts []Conflict          // 结果不一致的重复通知
	sealed    bool
	done      chan struct{} // 封口且全部终结时关闭，关闭后结果固定
}

// New 创建一个空的目标集合屏障。
func New() *Barrier {
	return &Barrier{
		pending: make(map[string]struct{}),
		results: make(map[string]Result),
		done:    make(chan struct{}),
	}
}

// Add 向目标集合追加任务 ID。集合封口后追加返回 ErrSealed；
// ID 已在集合中（无论是否已终结）返回 ErrDuplicateID。
func (b *Barrier) Add(ids ...string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.sealed {
		return ErrSealed
	}
	for _, id := range ids {
		if _, ok := b.pending[id]; ok {
			return fmt.Errorf("%w: %q", ErrDuplicateID, id)
		}
		if _, ok := b.results[id]; ok {
			return fmt.Errorf("%w: %q", ErrDuplicateID, id)
		}
	}
	for _, id := range ids {
		b.pending[id] = struct{}{}
	}
	return nil
}

// Seal 封口目标集合。封口后 Add 失败，Wait 等待的结果集固定。
// 重复调用是幂等的。
func (b *Barrier) Seal() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sealed = true
	b.maybeCloseLocked()
}

// Sealed 报告集合是否已封口。
func (b *Barrier) Sealed() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sealed
}

// Complete 上报任务正常完成并携带结果值。
func (b *Barrier) Complete(id string, value any) error {
	return b.notify(Result{ID: id, Outcome: Completed, Value: value})
}

// Revoke 上报任务被撤销。
func (b *Barrier) Revoke(id string) error {
	return b.notify(Result{ID: id, Outcome: Revoked})
}

// notify 保证每个 ID 只计一次：相同结果的重复通知幂等忽略，
// 不同结果的重复通知记录冲突并返回 *ConflictError，首次结果保持生效。
func (b *Barrier) notify(r Result) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.pending[r.ID]; !ok {
		if first, done := b.results[r.ID]; done {
			if sameResult(first, r) {
				return nil // 相同结果的重复通知，幂等
			}
			c := Conflict{ID: r.ID, First: first, Second: r}
			b.conflicts = append(b.conflicts, c)
			return &ConflictError{Conflict: c}
		}
		return fmt.Errorf("%w: %q", ErrUnknownID, r.ID)
	}
	delete(b.pending, r.ID)
	b.results[r.ID] = r
	b.maybeCloseLocked()
	return nil
}

func sameResult(a, b Result) bool {
	return a.Outcome == b.Outcome && reflect.DeepEqual(a.Value, b.Value)
}

// maybeCloseLocked 在封口且全部终结时关闭 done，唤醒所有等待者。
// 终结条件单调不可逆，done 至多关闭一次，不会漏唤醒。
func (b *Barrier) maybeCloseLocked() {
	if b.sealed && len(b.pending) == 0 {
		select {
		case <-b.done:
		default:
			close(b.done)
		}
	}
}

// Wait 阻塞直到集合封口且全部任务终结，返回结果快照与冲突列表。
// 返回的映射是拷贝，此后集合固定，不会再变化。
// ctx 取消时返回 ctx.Err()。
func (b *Barrier) Wait(ctx context.Context) (map[string]Result, []Conflict, error) {
	b.mu.Lock()
	done := b.done
	b.mu.Unlock()

	select {
	case <-done:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	results := make(map[string]Result, len(b.results))
	for id, r := range b.results {
		results[id] = r
	}
	conflicts := make([]Conflict, len(b.conflicts))
	copy(conflicts, b.conflicts)
	return results, conflicts, nil
}

// Pending 返回尚未终结的任务数。
func (b *Barrier) Pending() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.pending)
}
