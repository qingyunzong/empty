// Package aggregator 提供按任务 ID 汇聚终态（完成/撤销）的屏障。
//
// 目标集合在封口（Seal）前可随意追加（Add）；封口后集合固定，
// Wait 等待集合内全部任务终结后返回结果快照。
// 每个 ID 的首次通知生效；重复通知结果一致则忽略，不一致则报告冲突。
package aggregator

import (
	"errors"
	"fmt"
	"sync"
)

// Result 表示任务的终态。
type Result int

const (
	// Completed 任务正常完成。
	Completed Result = iota
	// Revoked 任务被撤销。
	Revoked
)

func (r Result) String() string {
	switch r {
	case Completed:
		return "completed"
	case Revoked:
		return "revoked"
	default:
		return "unknown"
	}
}

// ErrSealed 表示在封口之后尝试修改目标集合。
var ErrSealed = errors.New("aggregator: set is sealed")

// ErrDuplicateID 表示向目标集合重复添加同一 ID。
var ErrDuplicateID = errors.New("aggregator: duplicate task id")

// ConflictError 表示同一 ID 收到了不一致的终态通知。
type ConflictError struct {
	ID       string
	Recorded Result
	Incoming Result
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("aggregator: conflicting result for task %q: recorded %s, got %s",
		e.ID, e.Recorded, e.Incoming)
}

// Aggregator 汇聚一组任务的终态，并在全部终结后释放等待者。
// 零值不可用，请使用 New 创建。所有方法可并发调用。
type Aggregator struct {
	mu      sync.Mutex
	members map[string]struct{} // 目标集合
	results map[string]Result   // 已收到的终态（含集合外 ID）
	sealed  bool
	done    chan struct{} // 条件满足时关闭，负责唤醒所有等待者
}

// New 创建一个未封口的汇聚器。
func New() *Aggregator {
	return &Aggregator{
		members: make(map[string]struct{}),
		results: make(map[string]Result),
		done:    make(chan struct{}),
	}
}

// Add 将 id 追加进目标集合。封口后调用返回 ErrSealed；
// 重复添加同一 ID 返回 ErrDuplicateID。
func (a *Aggregator) Add(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sealed {
		return ErrSealed
	}
	if _, ok := a.members[id]; ok {
		return fmt.Errorf("%w: %q", ErrDuplicateID, id)
	}
	a.members[id] = struct{}{}
	return nil
}

// Notify 上报 id 的终态。每个 ID 只计一次：
// 重复通知结果一致时忽略（返回 nil）；不一致时返回 *ConflictError，
// 并保留首次记录的结果。通知允许先于 Add 到达。
func (a *Aggregator) Notify(id string, r Result) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if prev, ok := a.results[id]; ok {
		if prev != r {
			return &ConflictError{ID: id, Recorded: prev, Incoming: r}
		}
		return nil
	}
	a.results[id] = r
	a.maybeCloseLocked()
	return nil
}

// Seal 封闭目标集合，之后 Add 一律失败，Wait 的等待目标固定。
// 重复调用是安全的（幂等）。
func (a *Aggregator) Seal() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sealed = true
	a.maybeCloseLocked()
}

// Sealed 报告集合是否已封口。
func (a *Aggregator) Sealed() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sealed
}

// Done 返回一个 channel，在集合封口且全部成员终结后关闭。
// 可用于 select 场景；与 Wait 共享同一唤醒源，不会漏唤醒。
func (a *Aggregator) Done() <-chan struct{} {
	return a.done
}

// Wait 阻塞直到集合封口且全部成员都已终结，返回成员 ID 到终态的快照。
// 若条件在调用前已满足则立即返回，不会漏掉唤醒。
func (a *Aggregator) Wait() map[string]Result {
	<-a.done
	a.mu.Lock()
	defer a.mu.Unlock()
	snapshot := make(map[string]Result, len(a.members))
	for id := range a.members {
		snapshot[id] = a.results[id]
	}
	return snapshot
}

// maybeCloseLocked 在“已封口且所有成员都有终态”时关闭 done。
// 调用方必须持有 a.mu。条件单调（封口不可逆、结果只增不减），
// 因此 done 至多关闭一次，关闭即永久成立，不存在漏唤醒。
func (a *Aggregator) maybeCloseLocked() {
	if !a.sealed {
		return
	}
	select {
	case <-a.done:
		return // 已关闭
	default:
	}
	for id := range a.members {
		if _, ok := a.results[id]; !ok {
			return
		}
	}
	close(a.done)
}
