// Package offlineq 实现一个离线任务队列：领取任务产生递增世代租约，
// 租约到期（now >= deadline）即失效；超时后可被重新领取，旧世代的
// ACK/延长请求一律拒绝。所有状态变更以事件日志追加持久化，重启后重放恢复。
package offlineq

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// 事件类型。
const (
	EventAdded    = "added"
	EventClaimed  = "claimed"
	EventAcked    = "acked"
	EventExtended = "extended"
)

// Event 是追加到日志中的一条状态变更记录。时间均为 UnixNano。
type Event struct {
	Type       string `json:"type"`
	TaskID     string `json:"task_id"`
	Holder     string `json:"holder,omitempty"`
	Generation uint64 `json:"generation,omitempty"`
	Deadline   int64  `json:"deadline,omitempty"`
	Time       int64  `json:"time"`
}

// Lease 是一次成功领取返回的租约。
type Lease struct {
	TaskID     string
	Holder     string
	Generation uint64
	Deadline   time.Time
}

// Expired 报告租约在时刻 now 是否已失效：now == deadline 即视为到期。
func (l Lease) Expired(now time.Time) bool {
	return !now.Before(l.Deadline)
}

type taskState struct {
	id         string
	acked      bool
	leased     bool
	holder     string
	generation uint64
	deadline   int64
}

func (t *taskState) expired(now int64) bool {
	return !t.leased || now >= t.deadline
}

// Queue 是离线任务队列，状态由事件日志重放构建，变更追加持久化。
type Queue struct {
	mu     sync.Mutex
	tasks  map[string]*taskState
	events []Event // 完整历史，用于核对
	file   *os.File
	enc    *json.Encoder
}

var (
	ErrTaskExists   = errors.New("offlineq: task already exists")
	ErrTaskNotFound = errors.New("offlineq: task not found")
	ErrTaskAcked    = errors.New("offlineq: task already acked")
	ErrTaskLeased   = errors.New("offlineq: task currently leased")
)

// Open 打开（必要时创建）位于 path 的事件日志，重放全部历史恢复状态。
func Open(path string) (*Queue, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	q := &Queue{
		tasks: make(map[string]*taskState),
		file:  f,
		enc:   json.NewEncoder(f),
	}
	if err := q.replay(); err != nil {
		f.Close()
		return nil, err
	}
	return q, nil
}

// Close 关闭底层日志文件。
func (q *Queue) Close() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.file.Close()
}

func (q *Queue) replay() error {
	if _, err := q.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	dec := json.NewDecoder(bufio.NewReader(q.file))
	for {
		var ev Event
		if err := dec.Decode(&ev); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return fmt.Errorf("offlineq: replay log: %w", err)
		}
		q.apply(ev)
	}
	// 回到末尾继续追加。
	if _, err := q.file.Seek(0, io.SeekEnd); err != nil {
		return err
	}
	return nil
}

// apply 将事件应用到内存状态（不加锁，调用方持锁或在 replay 中串行调用）。
func (q *Queue) apply(ev Event) {
	t, ok := q.tasks[ev.TaskID]
	if !ok {
		t = &taskState{id: ev.TaskID}
		q.tasks[ev.TaskID] = t
	}
	switch ev.Type {
	case EventAdded:
		// 无额外状态。
	case EventClaimed:
		t.leased = true
		t.holder = ev.Holder
		t.generation = ev.Generation
		t.deadline = ev.Deadline
	case EventAcked:
		t.acked = true
		t.leased = false
	case EventExtended:
		t.deadline = ev.Deadline
	}
	q.events = append(q.events, ev)
}

// append 持久化并应用一条事件（调用方须持锁）。
func (q *Queue) append(ev Event) error {
	if err := q.enc.Encode(ev); err != nil {
		return err
	}
	if err := q.file.Sync(); err != nil {
		return err
	}
	q.apply(ev)
	return nil
}

// Add 向队列中加入一个任务。
func (q *Queue) Add(taskID string, now time.Time) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, ok := q.tasks[taskID]; ok {
		return ErrTaskExists
	}
	return q.append(Event{Type: EventAdded, TaskID: taskID, Time: now.UnixNano()})
}

// Claim 尝试为 holder 领取任务，成功返回递增世代的租约。
// 仅当任务存在、未 ACK、且当前无有效租约（now >= 旧 deadline）时成功。
func (q *Queue) Claim(taskID, holder string, now time.Time, ttl time.Duration) (Lease, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	t, ok := q.tasks[taskID]
	if !ok {
		return Lease{}, ErrTaskNotFound
	}
	if t.acked {
		return Lease{}, ErrTaskAcked
	}
	if !t.expired(now.UnixNano()) {
		return Lease{}, ErrTaskLeased
	}
	gen := t.generation + 1
	deadline := now.Add(ttl)
	ev := Event{
		Type:       EventClaimed,
		TaskID:     taskID,
		Holder:     holder,
		Generation: gen,
		Deadline:   deadline.UnixNano(),
		Time:       now.UnixNano(),
	}
	if err := q.append(ev); err != nil {
		return Lease{}, err
	}
	return Lease{TaskID: taskID, Holder: holder, Generation: gen, Deadline: deadline}, nil
}

// Ack 确认任务完成。只有当前世代、持有者在租约未到期（now < deadline）
// 时的 ACK 才被接受；超时重新领取后旧世代的 ACK 一律拒绝。
func (q *Queue) Ack(taskID, holder string, generation uint64, now time.Time) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	t, ok := q.tasks[taskID]
	if !ok {
		return ErrTaskNotFound
	}
	if t.acked {
		return ErrTaskAcked
	}
	if t.expired(now.UnixNano()) || t.holder != holder || t.generation != generation {
		return fmt.Errorf("offlineq: stale or expired lease (gen %d)", generation)
	}
	return q.append(Event{
		Type:       EventAcked,
		TaskID:     taskID,
		Holder:     holder,
		Generation: generation,
		Time:       now.UnixNano(),
	})
}

// Extend 延长当前租约 extra 时长。只接受当前世代且未到期（now < deadline）。
func (q *Queue) Extend(taskID, holder string, generation uint64, now time.Time, extra time.Duration) (time.Time, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	t, ok := q.tasks[taskID]
	if !ok {
		return time.Time{}, ErrTaskNotFound
	}
	if t.acked {
		return time.Time{}, ErrTaskAcked
	}
	if t.expired(now.UnixNano()) || t.holder != holder || t.generation != generation {
		return time.Time{}, fmt.Errorf("offlineq: stale or expired lease (gen %d)", generation)
	}
	newDeadline := time.Unix(0, t.deadline).Add(extra)
	ev := Event{
		Type:       EventExtended,
		TaskID:     taskID,
		Holder:     holder,
		Generation: generation,
		Deadline:   newDeadline.UnixNano(),
		Time:       now.UnixNano(),
	}
	if err := q.append(ev); err != nil {
		return time.Time{}, err
	}
	return newDeadline, nil
}

// CurrentHolder 返回任务在时刻 now 的当前持有者；无有效租约时 ok=false。
func (q *Queue) CurrentHolder(taskID string, now time.Time) (holder string, generation uint64, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	t, found := q.tasks[taskID]
	if !found || t.acked || t.expired(now.UnixNano()) {
		return "", 0, false
	}
	return t.holder, t.generation, true
}

// VerifySingleHolder 枚举完整事件历史，核对任意任务在任意事件时刻
// 至多有一个当前持有者：每次领取发生时，旧租约必须已到期（领取时刻
// >= 旧 deadline）。发现违例返回错误。
func (q *Queue) VerifySingleHolder() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	type lease struct {
		holder   string
		deadline int64
	}
	current := make(map[string]lease)
	for _, ev := range q.events {
		switch ev.Type {
		case EventClaimed:
			if prev, ok := current[ev.TaskID]; ok && ev.Time < prev.deadline {
				return fmt.Errorf("offlineq: task %q held by %q until %d, but claimed by %q at %d",
					ev.TaskID, prev.holder, prev.deadline, ev.Holder, ev.Time)
			}
			current[ev.TaskID] = lease{holder: ev.Holder, deadline: ev.Deadline}
		case EventExtended:
			if prev, ok := current[ev.TaskID]; ok && prev.holder == ev.Holder {
				current[ev.TaskID] = lease{holder: ev.Holder, deadline: ev.Deadline}
			}
		case EventAcked:
			if prev, ok := current[ev.TaskID]; ok && prev.holder == ev.Holder {
				delete(current, ev.TaskID)
			}
		}
	}
	return nil
}

// Events 返回已重放/记录的完整事件历史的副本。
func (q *Queue) Events() []Event {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := make([]Event, len(q.events))
	copy(out, q.events)
	return out
}
