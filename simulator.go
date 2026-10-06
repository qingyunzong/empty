// Package locksim 模拟优先级继承互斥锁：
//   - 每个任务有基础优先级，有效优先级 = max(基础优先级, 各等待者沿等待链捐赠的最大值)
//   - 有效优先级通过逐次固定点迭代重算，天然支持多重等待与传递捐赠
//   - 加锁时在等待图上检测环路，发现死锁返回环路而非无穷传播
//   - 解锁后唤醒队首等待者并重算，对应来源的捐赠随之撤回
package locksim

import (
	"errors"
	"fmt"
	"strings"
)

// Task 表示一个可持有/等待锁的任务。
type Task struct {
	name    string
	base    int
	eff     int
	held    map[*Lock]bool
	waiting *Lock
}

// Lock 表示一个互斥锁，等待者按 FIFO 排队。
type Lock struct {
	name    string
	owner   *Task
	waiters []*Task
}

// Simulator 维护任务与锁的集合，并负责有效优先级的固定点重算。
type Simulator struct {
	tasks []*Task
	locks []*Lock
}

// DeadlockError 表示加锁时检测到的等待环。
type DeadlockError struct {
	Cycle []string // 构成环路的任务名，按等待方向排列
}

func (e *DeadlockError) Error() string {
	return fmt.Sprintf("deadlock detected: %s", strings.Join(e.Cycle, " -> "))
}

// NewSimulator 创建空模拟器。
func NewSimulator() *Simulator { return &Simulator{} }

// NewTask 注册一个基础优先级为 base 的任务（数值越大优先级越高）。
func (s *Simulator) NewTask(name string, base int) *Task {
	t := &Task{name: name, base: base, eff: base, held: map[*Lock]bool{}}
	s.tasks = append(s.tasks, t)
	return t
}

// NewLock 注册一把锁。
func (s *Simulator) NewLock(name string) *Lock {
	l := &Lock{name: name}
	s.locks = append(s.locks, l)
	return l
}

// Priority 返回任务当前的有效优先级。
func (s *Simulator) Priority(t *Task) int { return t.eff }

// Base 返回任务的基础优先级。
func (t *Task) Base() int { return t.base }

// Name 返回任务名。
func (t *Task) Name() string { return t.name }

// Lock 让任务 t 请求锁 l。
// 锁空闲则直接获得；否则 t 进入等待队列并向持有者捐赠优先级。
// 若等待会构成环路，返回 *DeadlockError（携带构成环的任务名），状态不变。
func (s *Simulator) Lock(t *Task, l *Lock) error {
	if t.waiting != nil {
		return fmt.Errorf("task %s is already waiting on lock %s", t.name, t.waiting.name)
	}
	switch {
	case l.owner == nil:
		l.owner = t
		t.held[l] = true
	case l.owner == t:
		return fmt.Errorf("task %s already holds lock %s", t.name, l.name)
	default:
		if cycle := s.findCycle(t, l); cycle != nil {
			return &DeadlockError{Cycle: cycle}
		}
		l.waiters = append(l.waiters, t)
		t.waiting = l
	}
	s.recompute()
	return nil
}

// Unlock 让任务 t 释放锁 l，唤醒队首等待者并重算优先级（撤回相应捐赠）。
func (s *Simulator) Unlock(t *Task, l *Lock) error {
	if l.owner != t {
		return fmt.Errorf("task %s does not hold lock %s", t.name, l.name)
	}
	delete(t.held, l)
	l.owner = nil
	if len(l.waiters) > 0 {
		next := l.waiters[0]
		l.waiters = l.waiters[1:]
		next.waiting = nil
		l.owner = next
		next.held[l] = true
	}
	s.recompute()
	return nil
}

// findCycle 沿等待链从 l 的持有者出发，若回到 t 则返回构成环的任务名。
func (s *Simulator) findCycle(t *Task, l *Lock) []string {
	cur := l.owner
	for cur != nil {
		if cur == t {
			// 环闭合：t 等待 l，而 l 的持有链最终回到 t。
			cycle := []string{t.name}
			for c := l.owner; c != t; c = c.waiting.owner {
				cycle = append(cycle, c.name)
			}
			return append(cycle, t.name)
		}
		if cur.waiting == nil {
			return nil
		}
		cur = cur.waiting.owner
	}
	return nil
}

// recompute 逐次固定点重算所有任务的有效优先级：
// eff(t) = max(base(t), max{ eff(w) | w 等待 t 持有的某把锁 })。
// 等待图无环（加锁时已检测），迭代必然收敛。
func (s *Simulator) recompute() {
	for _, t := range s.tasks {
		t.eff = t.base
	}
	// 上限 |tasks| 次足够让捐赠沿任意无环链传播完毕。
	for i := 0; i <= len(s.tasks); i++ {
		changed := false
		for _, l := range s.locks {
			if l.owner == nil {
				continue
			}
			for _, w := range l.waiters {
				if w.eff > l.owner.eff {
					l.owner.eff = w.eff
					changed = true
				}
			}
		}
		if !changed {
			return
		}
	}
}

// IsDeadlock 判断错误是否为死锁。
func IsDeadlock(err error) bool {
	var de *DeadlockError
	return errors.As(err, &de)
}
