package formal_test

import (
	"math/big"
	"math/rand"
	"sort"
	"testing"

	drf "example.org/dlks/formal/q10086"
)

type refQueue struct {
	id     string
	weight int64
	seq    int
	used   drf.Vector
}

type refTask struct {
	id      string
	queue   *refQueue
	demand  drf.Vector
	gang    int
	weight  int64
	seq     int
	running bool
	alloc   drf.Vector
}

type refModel struct {
	capacity drf.Vector
	queues   map[string]*refQueue
	order    []*refQueue
	tasks    map[string]*refTask
	taskList []*refTask
	used     drf.Vector
}

type event struct {
	kind   byte
	target int
}

func newRefModel(capacity drf.Vector) *refModel {
	return &refModel{
		capacity: capacity.Clone(),
		queues:   make(map[string]*refQueue),
		tasks:    make(map[string]*refTask),
		used:     make(drf.Vector),
	}
}

func (m *refModel) addQueue(id string, weight int64) {
	if weight <= 0 {
		weight = 1
	}
	queue := &refQueue{id: id, weight: weight, seq: len(m.order), used: make(drf.Vector)}
	m.queues[id] = queue
	m.order = append(m.order, queue)
}

func (m *refModel) submit(id, queueID string, demand drf.Vector, gang int) {
	if gang <= 0 {
		gang = 1
	}
	task := &refTask{
		id:     id,
		queue:  m.queues[queueID],
		demand: demand.Clone(),
		gang:   gang,
		weight: 1,
		seq:    len(m.taskList),
		alloc:  make(drf.Vector),
	}
	m.tasks[id] = task
	m.taskList = append(m.taskList, task)
}

func (m *refModel) queueShare(queue *refQueue) *big.Rat {
	return naiveShare(queue.used, m.capacity, queue.weight)
}

func (m *refModel) step() (string, bool) {
	candidates := make([]*refTask, 0)
	for _, task := range m.taskList {
		if !task.running {
			candidates = append(candidates, task)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if comparison := compareRat(m.queueShare(left.queue), m.queueShare(right.queue)); comparison != 0 {
			return comparison < 0
		}
		if left.queue.seq != right.queue.seq {
			return left.queue.seq < right.queue.seq
		}
		return left.seq < right.seq
	})
	free := m.capacity.Sub(m.used)
	for _, task := range candidates {
		total := task.demand.Mul(int64(task.gang))
		if !total.Fits(free) {
			continue
		}
		task.running = true
		task.alloc = total.Clone()
		task.queue.used = task.queue.used.Add(total)
		m.used = m.used.Add(total)
		return task.id, true
	}
	return "", false
}

func (m *refModel) allocate() []string {
	var admitted []string
	for {
		taskID, ok := m.step()
		if !ok {
			return admitted
		}
		admitted = append(admitted, taskID)
	}
}

func compareRat(a, b *big.Rat) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	default:
		return a.Cmp(b)
	}
}

func TestAllocationMatchesNaiveDRFForEverySubmissionOrder(t *testing.T) {
	capacity := drf.Vector{"cpu": 8, "mem": 8}
	tasks := []drf.Task{
		{ID: "a", QueueID: "q1", Demand: drf.Vector{"cpu": 2, "mem": 1}},
		{ID: "b", QueueID: "q1", Demand: drf.Vector{"cpu": 1, "mem": 2}, GangSize: 2},
		{ID: "c", QueueID: "q1", Demand: drf.Vector{"cpu": 3, "mem": 1}},
		{ID: "d", QueueID: "q2", Demand: drf.Vector{"cpu": 1, "mem": 1}},
		{ID: "e", QueueID: "q2", Demand: drf.Vector{"cpu": 2, "mem": 3}},
	}

	permutations := permutationsOf(tasks)
	for _, order := range permutations {
		for mode := 0; mode < 2; mode++ {
			name := "batch"
			if mode == 1 {
				name = "incremental"
			}
			t.Run(name+"-"+orderName(order), func(t *testing.T) {
				scheduler := drf.MustNewScheduler(capacity)
				mustQueue(t, scheduler, drf.Queue{ID: "q1", Weight: 1})
				mustQueue(t, scheduler, drf.Queue{ID: "q2", Weight: 2})
				scheduler.SetPreemptionEnabled(false)

				model := newRefModel(capacity)
				model.addQueue("q1", 1)
				model.addQueue("q2", 2)

				if mode == 0 {
					for _, task := range order {
						mustSubmit(t, scheduler, task)
						model.submit(task.ID, task.QueueID, task.Demand, task.GangSize)
					}
					mustAllocate(t, scheduler)
					model.allocate()
					compareWithModel(t, scheduler, model, "batch")
					return
				}

				for _, task := range order {
					mustSubmit(t, scheduler, task)
					model.submit(task.ID, task.QueueID, task.Demand, task.GangSize)
					mustAllocate(t, scheduler)
					for {
						if _, ok := model.step(); !ok {
							break
						}
					}
					assertInvariants(t, scheduler, "incremental submit")
					compareWithModel(t, scheduler, model, "incremental")
				}
			})
		}
	}
}

func TestExhaustivePreemptionAndArrivalInterleavings(t *testing.T) {
	capacity := drf.Vector{"cpu": 4, "mem": 4}
	taskSpecs := []drf.Task{
		{ID: "a", QueueID: "q1", Demand: drf.Vector{"cpu": 2, "mem": 1}},
		{ID: "b", QueueID: "q1", Demand: drf.Vector{"cpu": 1, "mem": 2}, GangSize: 2},
		{ID: "c", QueueID: "q2", Demand: drf.Vector{"cpu": 2, "mem": 2}},
	}

	var events []event
	for index := range taskSpecs {
		events = append(events, event{kind: 's', target: index})
	}
	events = append(events, event{kind: 'a'})
	for index := range taskSpecs {
		events = append(events, event{kind: 'p', target: index})
	}
	for index := range taskSpecs {
		events = append(events, event{kind: 'c', target: index})
	}

	const depth = 5
	sequence := make([]event, depth)
	var walk func(int)
	walk = func(position int) {
		if position == depth {
			runEventSequence(t, capacity, taskSpecs, sequence)
			return
		}
		for _, candidate := range events {
			sequence[position] = candidate
			walk(position + 1)
		}
	}
	walk(0)
}

func runEventSequence(t *testing.T, capacity drf.Vector, tasks []drf.Task, sequence []event) {
	t.Helper()
	scheduler := drf.MustNewScheduler(capacity)
	mustQueue(t, scheduler, drf.Queue{ID: "q1"})
	mustQueue(t, scheduler, drf.Queue{ID: "q2"})
	submitted := make(map[int]bool)

	for _, event := range sequence {
		switch event.kind {
		case 's':
			if submitted[event.target] {
				continue
			}
			if err := scheduler.Submit(tasks[event.target]); err == nil {
				submitted[event.target] = true
			}
		case 'a':
			if _, err := scheduler.Allocate(); err != nil {
				t.Fatalf("Allocate after %v: %v", sequence, err)
			}
		case 'p':
			_, _ = scheduler.Preempt(tasks[event.target].ID)
		case 'c':
			_ = scheduler.Complete(tasks[event.target].ID)
		}
		if err := scheduler.Validate(); err != nil {
			t.Fatalf("event sequence %v: %v", sequence, err)
		}
	}
	assertInvariants(t, scheduler, "event sequence")
}

func TestRandomInterleavingPreservesLedger(t *testing.T) {
	capacity := drf.Vector{"cpu": 9, "mem": 7}
	scheduler := drf.MustNewScheduler(capacity)
	mustQueue(t, scheduler, drf.Queue{ID: "q1", Weight: 1})
	mustQueue(t, scheduler, drf.Queue{ID: "q2", Weight: 2})
	mustQueue(t, scheduler, drf.Queue{ID: "q3", Weight: 3})

	tasks := []drf.Task{
		{ID: "t0", QueueID: "q1", Demand: drf.Vector{"cpu": 2, "mem": 1}},
		{ID: "t1", QueueID: "q1", Demand: drf.Vector{"cpu": 1, "mem": 3}, GangSize: 2},
		{ID: "t2", QueueID: "q2", Demand: drf.Vector{"cpu": 3, "mem": 1}, Weight: 2},
		{ID: "t3", QueueID: "q2", Demand: drf.Vector{"cpu": 1, "mem": 1}, GangSize: 3},
		{ID: "t4", QueueID: "q3", Demand: drf.Vector{"cpu": 2, "mem": 2}},
		{ID: "t5", QueueID: "q3", Demand: drf.Vector{"cpu": 4, "mem": 4}, GangSize: 2},
	}

	rng := rand.New(rand.NewSource(0x5eed))
	submitted := make(map[string]bool)
	for step := 0; step < 2500; step++ {
		switch rng.Intn(10) {
		case 0, 1, 2:
			task := tasks[rng.Intn(len(tasks))]
			if !submitted[task.ID] {
				if err := scheduler.Submit(task); err == nil {
					submitted[task.ID] = true
				}
			}
		case 3, 4, 5:
			if _, err := scheduler.Allocate(); err != nil {
				t.Fatalf("step %d Allocate: %v", step, err)
			}
		case 6, 7:
			task := tasks[rng.Intn(len(tasks))]
			_, _ = scheduler.Preempt(task.ID)
		default:
			task := tasks[rng.Intn(len(tasks))]
			_ = scheduler.Complete(task.ID)
		}
		if err := scheduler.Validate(); err != nil {
			t.Fatalf("step %d: %v", step, err)
		}
	}
	assertInvariants(t, scheduler, "random interleaving")
}

func compareWithModel(t *testing.T, scheduler *drf.Scheduler, model *refModel, context string) {
	t.Helper()
	snapshot := scheduler.Snapshot()
	if !snapshot.Used.Equal(model.used) {
		t.Fatalf("%s: scheduler used %s, naive used %s", context, snapshot.Used, model.used)
	}
	for _, task := range model.taskList {
		info, ok := scheduler.TaskInfo(task.id)
		if !ok {
			t.Fatalf("%s: scheduler missing task %s", context, task.id)
		}
		if task.running {
			if info.Status != drf.StatusRunning {
				t.Fatalf("%s: task %s status %s, naive says running", context, task.id, info.Status)
			}
			if !info.Resources.Equal(task.alloc) {
				t.Fatalf("%s: task %s resources %s, naive %s", context, task.id, info.Resources, task.alloc)
			}
		} else {
			if info.Status != drf.StatusWaiting {
				t.Fatalf("%s: task %s status %s, naive says waiting", context, task.id, info.Status)
			}
			if !info.Resources.IsZero() {
				t.Fatalf("%s: waiting task %s holds %s", context, task.id, info.Resources)
			}
		}
	}
	for id, queue := range model.queues {
		usage, err := scheduler.QueueUsage(id)
		if err != nil {
			t.Fatal(err)
		}
		if !usage.Equal(queue.used) {
			t.Fatalf("%s: queue %s usage %s, naive %s", context, id, usage, queue.used)
		}
	}
}

func permutationsOf(tasks []drf.Task) [][]drf.Task {
	var result [][]drf.Task
	var walk func(int)
	current := append([]drf.Task(nil), tasks...)
	walk = func(position int) {
		if position == len(current) {
			permutation := append([]drf.Task(nil), current...)
			result = append(result, permutation)
			return
		}
		for index := position; index < len(current); index++ {
			current[position], current[index] = current[index], current[position]
			walk(position + 1)
			current[position], current[index] = current[index], current[position]
		}
	}
	walk(0)
	return result
}

func orderName(order []drf.Task) string {
	name := ""
	for _, task := range order {
		name += task.ID
	}
	return name
}
