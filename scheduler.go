// Package drr 实现基于赤字轮询（Deficit Round Robin）的多租户任务调度库。
//
// 语义：
//   - 每轮为每个活跃租户（队列非空）增加 weight*quantum 的整数配额；
//   - 队首任务费用超过当前赤字余额时，本轮跳过，赤字累计到下一轮；
//   - 队列清空时赤字计数器清零，租户退出活跃列表；
//   - 负费用任务入队即被拒绝；
//   - 权重更新在下一轮开始时生效；
//   - 每次扣费都会追加一条账本记录。
package drr

import (
	"errors"
	"fmt"
)

// ErrNegativeCost 表示入队任务的费用为负数，被拒绝。
var ErrNegativeCost = errors.New("drr: 拒绝负费用任务")

// Task 是租户队列中等待调度的任务。
type Task struct {
	ID   string
	Cost int
}

// LedgerEntry 记录一次扣费。
type LedgerEntry struct {
	Round    int
	TenantID string
	TaskID   string
	Cost     int
}

type tenant struct {
	weight        int
	pendingWeight int // -1 表示没有待生效的权重更新
	deficit       int
	queue         []Task
	active        bool
}

// Scheduler 是赤字轮询调度器，非并发安全。
type Scheduler struct {
	quantum int
	round   int
	tenants map[string]*tenant
	active  []string // 活跃租户，按进入活跃状态的先后排序
	ledger  []LedgerEntry
}

// New 创建调度器。quantum 为单位权重每轮增加的整数配额，必须为正数。
func New(quantum int) (*Scheduler, error) {
	if quantum <= 0 {
		return nil, fmt.Errorf("drr: quantum 必须为正数，got %d", quantum)
	}
	return &Scheduler{quantum: quantum, tenants: make(map[string]*tenant)}, nil
}

// AddTenant 注册租户，权重必须为正数。
func (s *Scheduler) AddTenant(id string, weight int) error {
	if weight <= 0 {
		return fmt.Errorf("drr: 权重必须为正数，got %d", weight)
	}
	if _, ok := s.tenants[id]; ok {
		return fmt.Errorf("drr: 租户 %q 已存在", id)
	}
	s.tenants[id] = &tenant{weight: weight, pendingWeight: -1}
	return nil
}

// SetWeight 更新租户权重，从下一轮开始生效。
func (s *Scheduler) SetWeight(id string, weight int) error {
	if weight <= 0 {
		return fmt.Errorf("drr: 权重必须为正数，got %d", weight)
	}
	t, ok := s.tenants[id]
	if !ok {
		return fmt.Errorf("drr: 未知租户 %q", id)
	}
	t.pendingWeight = weight
	return nil
}

// Weight 返回租户当前生效的权重（不含待生效的更新）。
func (s *Scheduler) Weight(id string) (int, bool) {
	t, ok := s.tenants[id]
	if !ok {
		return 0, false
	}
	return t.weight, true
}

// Enqueue 把任务放入租户队尾。负费用任务被拒绝，返回 ErrNegativeCost。
func (s *Scheduler) Enqueue(tenantID string, task Task) error {
	if task.Cost < 0 {
		return ErrNegativeCost
	}
	t, ok := s.tenants[tenantID]
	if !ok {
		return fmt.Errorf("drr: 未知租户 %q", tenantID)
	}
	t.queue = append(t.queue, task)
	if !t.active {
		t.active = true
		s.active = append(s.active, tenantID)
	}
	return nil
}

// RunRound 执行一轮调度：先应用待生效的权重更新，再按活跃顺序为每个
// 租户补充配额并尽可能服务队首任务。返回本轮新增的账本条目。
func (s *Scheduler) RunRound() []LedgerEntry {
	for _, t := range s.tenants {
		if t.pendingWeight >= 0 {
			t.weight = t.pendingWeight
			t.pendingWeight = -1
		}
	}
	s.round++
	start := len(s.ledger)
	stillActive := make([]string, 0, len(s.active))
	for _, id := range s.active {
		t := s.tenants[id]
		t.deficit += t.weight * s.quantum
		for len(t.queue) > 0 && t.queue[0].Cost <= t.deficit {
			head := t.queue[0]
			t.queue = t.queue[1:]
			t.deficit -= head.Cost
			s.ledger = append(s.ledger, LedgerEntry{
				Round:    s.round,
				TenantID: id,
				TaskID:   head.ID,
				Cost:     head.Cost,
			})
		}
		if len(t.queue) == 0 {
			t.deficit = 0
			t.active = false
		} else {
			stillActive = append(stillActive, id)
		}
	}
	s.active = stillActive
	return append([]LedgerEntry(nil), s.ledger[start:]...)
}

// Ledger 返回完整账本的副本。
func (s *Scheduler) Ledger() []LedgerEntry {
	return append([]LedgerEntry(nil), s.ledger...)
}

// Round 返回当前已执行的轮数。
func (s *Scheduler) Round() int {
	return s.round
}

// Backlog 返回租户队列中剩余的任务数。
func (s *Scheduler) Backlog(id string) int {
	if t, ok := s.tenants[id]; ok {
		return len(t.queue)
	}
	return 0
}

// Deficit 返回租户当前的赤字余额（仅用于观测与测试）。
func (s *Scheduler) Deficit(id string) (int, bool) {
	if t, ok := s.tenants[id]; ok {
		return t.deficit, true
	}
	return 0, false
}
