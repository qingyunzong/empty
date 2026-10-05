package batchsched

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// naiveModel is an independent, deliberately simple round-by-round
// implementation of the same scheduling spec: plain slices, linear scans,
// no clock fast-forward. The property tests cross-check the optimized
// Scheduler against it.
type naiveModel struct {
	quantum        int
	urgentPerRound int
	order          []string
	cursor         int
	deficit        map[string]int
	queues         map[string][]Task
	urgent         []Task
	fees           map[string]int
	completed      []Completion
}

func runNaive(quantum, urgentPerRound, until int, ops []Op) *naiveModel {
	m := &naiveModel{
		quantum:        quantum,
		urgentPerRound: urgentPerRound,
		deficit:        make(map[string]int),
		queues:         make(map[string][]Task),
		fees:           make(map[string]int),
	}
	for round := 1; round <= until; round++ {
		for _, op := range ops {
			if op.At == round-1 {
				m.apply(op)
			}
		}
		m.runRound(round)
	}
	return m
}

func (m *naiveModel) apply(op Op) {
	switch op.Kind {
	case OpSubmit:
		t := op.Task
		if t.Urgent {
			m.urgent = append(m.urgent, t)
			return
		}
		if _, ok := m.queues[t.Tenant]; !ok {
			m.order = append(m.order, t.Tenant)
		}
		m.queues[t.Tenant] = append(m.queues[t.Tenant], t)
	case OpCancel:
		for i, t := range m.urgent {
			if t.ID == op.TaskID {
				m.urgent = append(m.urgent[:i], m.urgent[i+1:]...)
				return
			}
		}
		for tenant, q := range m.queues {
			for i, t := range q {
				if t.ID == op.TaskID {
					m.queues[tenant] = append(q[:i], q[i+1:]...)
					return
				}
			}
		}
	}
}

func (m *naiveModel) runRound(round int) {
	for i := 0; i < m.urgentPerRound && len(m.urgent) > 0; i++ {
		t := m.urgent[0]
		m.urgent = m.urgent[1:]
		m.fees[t.Tenant] += t.Cost
		m.completed = append(m.completed, Completion{Task: t, Round: round})
	}
	n := len(m.order)
	if n == 0 {
		return
	}
	for i := 0; i < n; i++ {
		name := m.order[(m.cursor+i)%n]
		q := m.queues[name]
		if len(q) == 0 {
			m.deficit[name] = 0
			continue
		}
		d := m.deficit[name] + m.quantum
		for len(q) > 0 && q[0].Cost <= d {
			d -= q[0].Cost
			m.fees[name] += q[0].Cost
			m.completed = append(m.completed, Completion{Task: q[0], Round: round})
			q = q[1:]
		}
		m.queues[name] = q
		if len(q) == 0 {
			d = 0
		}
		m.deficit[name] = d
	}
	m.cursor = (m.cursor + 1) % n
}

func completedIDs(cs []Completion) []int {
	ids := make([]int, len(cs))
	for i, c := range cs {
		ids[i] = c.Task.ID
	}
	return ids
}

// crossCheck runs the same op log through both implementations and requires
// identical fees, identical dispatch order, and identical dispatch rounds.
func crossCheck(t *testing.T, quantum, urgentPerRound, until int, ops []Op) *Scheduler {
	t.Helper()
	sorted := make([]Op, len(ops))
	copy(sorted, ops)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].At < sorted[j].At })

	s := New(quantum, urgentPerRound)
	s.Replay(ops, until)
	m := runNaive(quantum, urgentPerRound, until, sorted)

	if got, want := s.Fees(), m.fees; !reflect.DeepEqual(got, want) {
		t.Fatalf("fees mismatch:\n scheduler: %v\n naive:     %v", got, want)
	}
	got, want := s.Completed(), m.completed
	if !reflect.DeepEqual(completedIDs(got), completedIDs(want)) {
		t.Fatalf("dispatch order mismatch:\n scheduler: %v\n naive:     %v", completedIDs(got), completedIDs(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("completion %d mismatch: scheduler %+v, naive %+v", i, got[i], want[i])
		}
	}
	return s
}

func TestLargeTaskAccumulatesAcrossRounds(t *testing.T) {
	// Cost 10 with quantum 3: deficit grows 3, 6, 9, 12; dispatch in round 4.
	s := crossCheck(t, 3, 2, 10, []Op{
		{At: 0, Kind: OpSubmit, Task: Task{ID: 1, Tenant: "a", Cost: 10}},
	})
	got := s.Completed()
	if len(got) != 1 || got[0].Round != 4 {
		t.Fatalf("expected big task dispatched in round 4, got %+v", got)
	}
	if fee := s.Fees()["a"]; fee != 10 {
		t.Fatalf("expected fee 10, got %d", fee)
	}
}

func TestUrgentCapTwoPerRound(t *testing.T) {
	ops := make([]Op, 0, 5)
	for i := 1; i <= 5; i++ {
		ops = append(ops, Op{At: 0, Kind: OpSubmit, Task: Task{ID: i, Tenant: "a", Cost: 1, Urgent: true}})
	}
	s := crossCheck(t, 1, 2, 3, ops)
	perRound := map[int]int{}
	for _, c := range s.Completed() {
		perRound[c.Round]++
	}
	for r := 1; r <= 2; r++ {
		if perRound[r] != 2 {
			t.Fatalf("round %d: expected 2 urgent dispatches, got %d", r, perRound[r])
		}
	}
	if perRound[3] != 1 {
		t.Fatalf("round 3: expected 1 urgent dispatch, got %d", perRound[3])
	}
}

func TestCancelLeavesNoPhantomCharge(t *testing.T) {
	s := crossCheck(t, 4, 2, 6, []Op{
		{At: 0, Kind: OpSubmit, Task: Task{ID: 1, Tenant: "a", Cost: 3}},
		{At: 0, Kind: OpSubmit, Task: Task{ID: 2, Tenant: "a", Cost: 2, Urgent: true}},
		{At: 0, Kind: OpSubmit, Task: Task{ID: 3, Tenant: "b", Cost: 5}},
		{At: 0, Kind: OpCancel, TaskID: 1},
		{At: 0, Kind: OpCancel, TaskID: 2},
		// Cancelling an unknown or already-dispatched ID is a no-op.
		{At: 3, Kind: OpCancel, TaskID: 99},
	})
	fees := s.Fees()
	if fees["a"] != 0 {
		t.Fatalf("tenant a: expected zero fees after cancelling all tasks, got %d", fees["a"])
	}
	if fees["b"] != 5 {
		t.Fatalf("tenant b: expected fee 5, got %d", fees["b"])
	}
	if s.Pending() != 0 {
		t.Fatalf("expected no pending tasks, got %d", s.Pending())
	}
}

func TestCancelAfterPartialProgress(t *testing.T) {
	// Tenant a has two tasks; the first dispatches in round 1, the second is
	// cancelled before it can run. Only the dispatched task may be charged.
	s := crossCheck(t, 3, 0, 5, []Op{
		{At: 0, Kind: OpSubmit, Task: Task{ID: 1, Tenant: "a", Cost: 2}},
		{At: 0, Kind: OpSubmit, Task: Task{ID: 2, Tenant: "a", Cost: 7}},
		{At: 1, Kind: OpCancel, TaskID: 2},
	})
	if fee := s.Fees()["a"]; fee != 2 {
		t.Fatalf("expected fee 2 (only the dispatched task), got %d", fee)
	}
}

func TestIdleTenantDoesNotBankCredit(t *testing.T) {
	// Tenant a runs one small task then goes idle; tenant b submits a huge
	// task late. b must wait ceil(cost/quantum) rounds from its submission,
	// and a's idle rounds must not let a dispatch instantly later.
	s := crossCheck(t, 2, 0, 12, []Op{
		{At: 0, Kind: OpSubmit, Task: Task{ID: 1, Tenant: "a", Cost: 1}},
		{At: 5, Kind: OpSubmit, Task: Task{ID: 2, Tenant: "b", Cost: 7}},
		{At: 5, Kind: OpSubmit, Task: Task{ID: 3, Tenant: "a", Cost: 7}},
	})
	rounds := map[int]int{}
	for _, c := range s.Completed() {
		rounds[c.Task.ID] = c.Round
	}
	// Submitted after round 5; first credit arrives in round 6, needs
	// ceil(7/2)=4 credits: dispatch in round 9 at the earliest.
	if rounds[2] != 9 || rounds[3] != 9 {
		t.Fatalf("expected both big tasks in round 9, got %v", rounds)
	}
}

func TestNoStarvationUnderContinuousLoad(t *testing.T) {
	// One tenant's huge task must complete even while other tenants keep
	// submitting small tasks every round.
	ops := []Op{{At: 0, Kind: OpSubmit, Task: Task{ID: 1, Tenant: "big", Cost: 25}}}
	id := 2
	for r := 0; r < 8; r++ {
		for _, tenant := range []string{"x", "y", "z"} {
			ops = append(ops, Op{At: r, Kind: OpSubmit, Task: Task{ID: id, Tenant: tenant, Cost: 1}})
			id++
		}
	}
	s := crossCheck(t, 3, 1, 40, ops)
	for _, c := range s.Completed() {
		if c.Task.ID == 1 {
			// Needs ceil(25/3)=9 credits, first in round 1: done by round 9.
			if c.Round > 9 {
				t.Fatalf("big task starved: dispatched in round %d, want <= 9", c.Round)
			}
			return
		}
	}
	t.Fatal("big task never dispatched")
}

func TestVirtualClockFastForward(t *testing.T) {
	// With nothing pending, Advance must jump the clock without simulating
	// rounds, and later submissions must behave as if the idle rounds never
	// banked credit.
	s := New(3, 2)
	s.Advance(1_000_000)
	if s.Round() != 1_000_000 {
		t.Fatalf("expected clock at 1_000_000, got %d", s.Round())
	}
	s.Submit(Task{ID: 1, Tenant: "a", Cost: 10})
	s.Advance(1_000_004)
	got := s.Completed()
	if len(got) != 1 || got[0].Round != 1_000_004 {
		t.Fatalf("expected dispatch 4 rounds after submission, got %+v", got)
	}
}

func TestRandomizedReplayMatchesNaive(t *testing.T) {
	for seed := int64(0); seed < 100; seed++ {
		t.Run("", func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			quantum := 1 + rng.Intn(5)
			urgentPerRound := 1 + rng.Intn(3)
			until := 60 + rng.Intn(40)
			tenants := []string{"a", "b", "c", "d"}

			var ops []Op
			submitted := map[int]bool{}
			cancelAt := map[int]int{}
			nextID := 1
			for r := 0; r < until; r++ {
				for n := rng.Intn(3); n >= 0; n-- {
					if rng.Intn(4) == 0 {
						break
					}
					t := Task{
						ID:     nextID,
						Tenant: tenants[rng.Intn(len(tenants))],
						Cost:   1 + rng.Intn(4*quantum),
						Urgent: rng.Intn(5) == 0,
					}
					nextID++
					submitted[t.ID] = true
					ops = append(ops, Op{At: r, Kind: OpSubmit, Task: t})
				}
				if rng.Intn(3) == 0 && len(submitted) > 0 {
					ids := make([]int, 0, len(submitted))
					for id := range submitted {
						ids = append(ids, id)
					}
					sort.Ints(ids)
					id := ids[rng.Intn(len(ids))]
					ops = append(ops, Op{At: r, Kind: OpCancel, TaskID: id})
					cancelAt[id] = r
					delete(submitted, id)
				}
			}

			s := crossCheck(t, quantum, urgentPerRound, until, ops)

			// No starvation: with the clock run far enough, every task that
			// was never cancelled must eventually dispatch.
			s.Advance(until + 1000)
			dispatched := map[int]bool{}
			for _, c := range s.Completed() {
				dispatched[c.Task.ID] = true
			}
			for _, op := range ops {
				if op.Kind != OpSubmit {
					continue
				}
				if _, cancelled := cancelAt[op.Task.ID]; cancelled {
					continue
				}
				if !dispatched[op.Task.ID] {
					t.Fatalf("seed %d: task %+v starved", seed, op.Task)
				}
			}

			// No phantom charges: total fees equal total cost of dispatched
			// tasks, and any task with a cancel op was either dispatched
			// before the cancel landed or never dispatched at all.
			total := 0
			for _, v := range s.Fees() {
				total += v
			}
			costSum := 0
			for _, c := range s.Completed() {
				costSum += c.Task.Cost
				if at, cancelled := cancelAt[c.Task.ID]; cancelled && c.Round > at {
					t.Fatalf("seed %d: task %d dispatched in round %d after cancel at %d", seed, c.Task.ID, c.Round, at)
				}
			}
			if total != costSum {
				t.Fatalf("seed %d: fee ledger %d != dispatched cost %d", seed, total, costSum)
			}
		})
	}
}
