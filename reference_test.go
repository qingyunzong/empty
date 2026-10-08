package drr_test

import (
	"container/list"
	"fmt"
	"math/rand"
	"testing"

	"drr"
)

// refModel 是基于 container/list 的参考模型，逐字实现规格：
// 每轮为活跃租户加 weight*quantum 配额；队首费用不足则累计赤字；
// 空队列清零并移出活跃列表；权重更新下一轮生效；每次扣费记账。
// 它与 drr.Scheduler 的实现相互独立，用于交叉核验。
type refModel struct {
	quantum  int
	round    int
	weight   map[string]int
	pending  map[string]int
	queues   map[string]*list.List // 元素为 drr.Task
	deficit  map[string]int
	active   *list.List // 元素为租户 ID
	position map[string]*list.Element
	ledger   []drr.LedgerEntry
}

func newRefModel(quantum int) *refModel {
	return &refModel{
		quantum:  quantum,
		weight:   make(map[string]int),
		pending:  make(map[string]int),
		queues:   make(map[string]*list.List),
		deficit:  make(map[string]int),
		active:   list.New(),
		position: make(map[string]*list.Element),
	}
}

func (m *refModel) addTenant(id string, weight int) {
	m.weight[id] = weight
	m.queues[id] = list.New()
}

func (m *refModel) setWeight(id string, weight int) {
	m.pending[id] = weight
}

func (m *refModel) enqueue(id string, task drr.Task) {
	q := m.queues[id]
	q.PushBack(task)
	if q.Len() == 1 {
		if _, ok := m.position[id]; !ok {
			m.position[id] = m.active.PushBack(id)
		}
	}
}

func (m *refModel) runRound() []drr.LedgerEntry {
	for id, w := range m.pending {
		m.weight[id] = w
	}
	m.pending = make(map[string]int)
	m.round++
	start := len(m.ledger)
	for e := m.active.Front(); e != nil; {
		next := e.Next()
		id := e.Value.(string)
		q := m.queues[id]
		m.deficit[id] += m.weight[id] * m.quantum
		for q.Len() > 0 {
			head := q.Front().Value.(drr.Task)
			if head.Cost > m.deficit[id] {
				break
			}
			q.Remove(q.Front())
			m.deficit[id] -= head.Cost
			m.ledger = append(m.ledger, drr.LedgerEntry{
				Round:    m.round,
				TenantID: id,
				TaskID:   head.ID,
				Cost:     head.Cost,
			})
		}
		if q.Len() == 0 {
			m.deficit[id] = 0
			m.active.Remove(e)
			delete(m.position, id)
		}
		e = next
	}
	return m.ledger[start:]
}

func (m *refModel) backlog(id string) int {
	if q, ok := m.queues[id]; ok {
		return q.Len()
	}
	return 0
}

func checkLedgerEqual(t *testing.T, got, want []drr.LedgerEntry, ctx string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: ledger length = %d, want %d\ngot:  %v\nwant: %v", ctx, len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: ledger[%d] = %+v, want %+v", ctx, i, got[i], want[i])
		}
	}
}

// TestAgainstReferenceModel 用随机操作序列交叉核验调度器与参考模型。
func TestAgainstReferenceModel(t *testing.T) {
	for _, seed := range []int64{1, 7, 42, 2026, 999983} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			s := newScheduler(t, 10)
			ref := newRefModel(10)

			tenants := []string{"alpha", "beta", "gamma", "delta"}
			for i, id := range tenants {
				w := 1 + rng.Intn(3)
				mustAddTenant(t, s, id, w)
				ref.addTenant(id, w)
				_ = i
			}

			taskSeq := 0
			for step := 0; step < 400; step++ {
				switch rng.Intn(10) {
				case 0, 1: // 更新权重，下一轮生效
					id := tenants[rng.Intn(len(tenants))]
					w := 1 + rng.Intn(4)
					if err := s.SetWeight(id, w); err != nil {
						t.Fatalf("SetWeight: %v", err)
					}
					ref.setWeight(id, w)
				case 2: // 入队大任务，检验不饥饿
					id := tenants[rng.Intn(len(tenants))]
					task := drr.Task{ID: fmt.Sprintf("big-%d", taskSeq), Cost: 50 + rng.Intn(150)}
					taskSeq++
					mustEnqueue(t, s, id, task)
					ref.enqueue(id, task)
				default: // 入队普通任务
					id := tenants[rng.Intn(len(tenants))]
					task := drr.Task{ID: fmt.Sprintf("t-%d", taskSeq), Cost: rng.Intn(30)}
					taskSeq++
					mustEnqueue(t, s, id, task)
					ref.enqueue(id, task)
				}
				if rng.Intn(3) == 0 {
					got := s.RunRound()
					want := ref.runRound()
					checkLedgerEqual(t, got, want, fmt.Sprintf("step %d round entries", step))
				}
			}
			for len(s.Ledger()) < len(ref.ledger) || backlogTotal(s, tenants) > 0 {
				s.RunRound()
				ref.runRound()
			}
			checkLedgerEqual(t, s.Ledger(), ref.ledger, "final ledger")
			for _, id := range tenants {
				if got, want := s.Backlog(id), ref.backlog(id); got != want {
					t.Fatalf("backlog(%q) = %d, want %d", id, got, want)
				}
			}
		})
	}
}

func backlogTotal(s *drr.Scheduler, tenants []string) int {
	total := 0
	for _, id := range tenants {
		total += s.Backlog(id)
	}
	return total
}

// TestLargeTaskDoesNotStarve 核验大任务不会因队首阻塞而饥饿：
// 赤字逐轮累计，最终必然被服务，且与参考模型逐条一致。
func TestLargeTaskDoesNotStarve(t *testing.T) {
	s := newScheduler(t, 100)
	ref := newRefModel(100)

	mustAddTenant(t, s, "big", 1)
	mustAddTenant(t, s, "small", 1)
	ref.addTenant("big", 1)
	ref.addTenant("small", 1)

	mustEnqueue(t, s, "big", drr.Task{ID: "huge", Cost: 1000})
	ref.enqueue("big", drr.Task{ID: "huge", Cost: 1000})

	servedRound := -1
	for round := 1; round <= 20; round++ {
		// small 每轮都有新的小任务，持续占用调度器。
		small := drr.Task{ID: fmt.Sprintf("s-%d", round), Cost: 5}
		mustEnqueue(t, s, "small", small)
		ref.enqueue("small", small)

		got := s.RunRound()
		want := ref.runRound()
		checkLedgerEqual(t, got, want, fmt.Sprintf("round %d", round))
		for _, e := range got {
			if e.TaskID == "huge" {
				servedRound = e.Round
			}
		}
	}
	if servedRound != 10 {
		t.Fatalf("huge task should be served in round 10 (100*10 >= 1000), got round %d", servedRound)
	}
	if got := s.Backlog("big"); got != 0 {
		t.Fatalf("big tenant backlog = %d, want 0", got)
	}
	checkLedgerEqual(t, s.Ledger(), ref.ledger, "final ledger")
}
