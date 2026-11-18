package formal

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// DefaultQueueID is used when a task does not name a queue and no explicit
// queue can be inferred.
const DefaultQueueID = "default"

// Options controls optional DRF policies. The zero value enables automatic
// preemption across queues and disables equal-share preemption.
type Options struct {
	// DisablePreemption makes Allocate leave a task waiting instead of
	// evicting running tasks.
	DisablePreemption bool
	// PreemptSameQueue allows a task to preempt a higher-share task from its
	// own queue. It is disabled by default to avoid internal churn.
	PreemptSameQueue bool
	// AllowEqualSharePreemption lets a victim with exactly the same
	// dominant share as the incoming task be selected. The default is
	// strict dominance, which prevents A/B/A preemption cycles.
	AllowEqualSharePreemption bool
}

// Scheduler is a deterministic, weighted DRF scheduler with atomic gang
// admission and resource-conserving preemption.
type Scheduler struct {
	mu sync.Mutex

	capacity Vector
	options  Options

	queues     map[string]*queueState
	queueOrder []*queueState
	tasks      map[string]*taskState
	used       Vector

	nextQueueSequence uint64
	nextTaskSequence  uint64
	steps             uint64
}

// DRF and DRFScheduler are aliases for Scheduler.
type DRF = Scheduler
type DRFScheduler = Scheduler

type queueState struct {
	queue    Queue
	capacity Vector
	used     Vector
	sequence uint64
	tasks    []*taskState
}

type taskState struct {
	task        Task
	queue       *queueState
	sequence    uint64
	status      Status
	alloc       Vector
	reason      string
	preemptions int
}

// NewScheduler creates a scheduler with the default policies.
func NewScheduler(capacity Vector) (*Scheduler, error) {
	return NewSchedulerWithOptions(capacity, Options{})
}

// NewSchedulerWithOptions creates a scheduler with explicit policies.
func NewSchedulerWithOptions(capacity Vector, options Options) (*Scheduler, error) {
	if err := validateCapacity(capacity); err != nil {
		return nil, err
	}
	capacity = capacity.Clone()
	return &Scheduler{
		capacity: capacity,
		options:  options,
		queues:   make(map[string]*queueState),
		tasks:    make(map[string]*taskState),
		used:     make(Vector, len(capacity)),
	}, nil
}

// New is an alias for NewScheduler.
func New(capacity Vector) (*Scheduler, error) { return NewScheduler(capacity) }

// NewDRF is an alias for NewScheduler.
func NewDRF(capacity Vector) (*Scheduler, error) { return NewScheduler(capacity) }

// NewDRFScheduler is an alias for NewScheduler.
func NewDRFScheduler(capacity Vector) (*Scheduler, error) { return NewScheduler(capacity) }

// DefaultOptions returns the built-in policy: automatic stable preemption
// across queues, strict share dominance for victims, and no same-queue
// preemption.
func DefaultOptions() Options { return Options{} }

// MustNewScheduler is like NewScheduler but panics on invalid capacity.
func MustNewScheduler(capacity Vector) *Scheduler {
	scheduler, err := NewScheduler(capacity)
	if err != nil {
		panic(err)
	}
	return scheduler
}

// Capacity returns a copy of the cluster capacity.
func (s *Scheduler) Capacity() Vector {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.capacity.Clone()
}

// AddQueue registers a queue, optionally submitting its initial tasks.
func (s *Scheduler) AddQueue(queue Queue) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.addQueueLocked(queue)
}

// RegisterQueue registers an empty queue with a weight. Weight <= 0 means one.
func (s *Scheduler) RegisterQueue(id string, weight int64) error {
	return s.AddQueue(Queue{ID: id, Weight: weight})
}

func (s *Scheduler) addQueueLocked(queue Queue) error {
	if err := requireNonEmpty(queue.ID, "queue ID"); err != nil {
		return err
	}
	if queue.Weight < 0 {
		return fmt.Errorf("%w: queue %q has negative weight %d", ErrInvalidQueue, queue.ID, queue.Weight)
	}
	if _, exists := s.queues[queue.ID]; exists {
		return fmt.Errorf("%w: %q", ErrQueueExists, queue.ID)
	}

	state := &queueState{
		queue: Queue{
			ID:     queue.ID,
			Weight: queue.NormalizedWeight(),
		},
		capacity: s.capacity,
		used:     make(Vector, len(s.capacity)),
		sequence: s.nextQueueSequence,
	}
	s.nextQueueSequence++
	s.queues[state.queue.ID] = state
	s.queueOrder = append(s.queueOrder, state)

	for _, task := range queue.Tasks {
		task.QueueID = queue.ID
		if err := s.submitLocked(task); err != nil {
			s.removeQueueStateLocked(state)
			return err
		}
	}
	return nil
}

func (s *Scheduler) removeQueueStateLocked(queue *queueState) {
	for _, task := range queue.tasks {
		delete(s.tasks, task.task.ID)
	}
	delete(s.queues, queue.queue.ID)
	for i, candidate := range s.queueOrder {
		if candidate == queue {
			s.queueOrder = append(s.queueOrder[:i], s.queueOrder[i+1:]...)
			break
		}
	}
}

// Submit enqueues a task. If the task has no QueueID, the only registered
// queue is used; if no queues exist a "default" queue is created.
func (s *Scheduler) Submit(task Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if task.QueueID == "" {
		switch len(s.queueOrder) {
		case 0:
			task.QueueID = DefaultQueueID
			if err := s.addQueueLocked(Queue{ID: DefaultQueueID}); err != nil {
				return err
			}
		case 1:
			task.QueueID = s.queueOrder[0].queue.ID
		default:
			if _, ok := s.queues[DefaultQueueID]; !ok {
				return fmt.Errorf("%w: task %q must name one of %d queues", ErrUnknownQueue, task.ID, len(s.queueOrder))
			}
			task.QueueID = DefaultQueueID
		}
	}
	return s.submitLocked(task)
}

// SubmitTo enqueues a task into an explicitly named queue.
func (s *Scheduler) SubmitTo(queueID string, task Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	task.QueueID = queueID
	return s.submitLocked(task)
}

// AddTask is an alias for Submit.
func (s *Scheduler) AddTask(task Task) error { return s.Submit(task) }

func (s *Scheduler) submitLocked(task Task) error {
	if task.QueueID == "" {
		return fmt.Errorf("%w: task must have a queue", ErrInvalidTask)
	}
	queue, ok := s.queues[task.QueueID]
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownQueue, task.QueueID)
	}
	if task.Weight < 0 {
		return fmt.Errorf("%w: task %q has negative weight %d", ErrInvalidTask, task.ID, task.Weight)
	}
	if task.GangSize < 0 {
		return fmt.Errorf("%w: task %q has negative gang size %d", ErrInvalidTask, task.ID, task.GangSize)
	}
	if len(task.Demand) == 0 {
		return fmt.Errorf("%w: task %q has empty demand", ErrInvalidTask, task.ID)
	}
	if err := validateDemand(task.Demand, s.capacity); err != nil {
		return err
	}
	if _, err := task.TotalDemand(); err != nil {
		return err
	}
	if task.ID == "" {
		for {
			task.ID = fmt.Sprintf("task-%d", s.nextTaskSequence+1)
			if _, exists := s.tasks[task.ID]; !exists {
				break
			}
			s.nextTaskSequence++
		}
	}
	if _, exists := s.tasks[task.ID]; exists {
		return fmt.Errorf("%w: %q", ErrTaskExists, task.ID)
	}
	task.Demand = task.Demand.Clone()

	state := &taskState{
		task:     task,
		queue:    queue,
		sequence: s.nextTaskSequence,
		status:   StatusWaiting,
		alloc:    make(Vector, len(s.capacity)),
	}
	s.nextTaskSequence++
	s.tasks[task.ID] = state
	queue.tasks = append(queue.tasks, state)
	return nil
}

// Allocate makes scheduling progress until no waiting task can be admitted or
// helped by preemption. Admission is atomic per gang.
func (s *Scheduler) Allocate() (*Decision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.allocateLocked()
}

// Schedule is an alias for Allocate.
func (s *Scheduler) Schedule() (*Decision, error) { return s.Allocate() }

// Run is an alias for Allocate.
func (s *Scheduler) Run() (*Decision, error) { return s.Allocate() }

func (s *Scheduler) allocateLocked() (*Decision, error) {
	total := &Decision{}
	seen := make(map[string]struct{})
	for {
		signature := s.stateSignatureLocked()
		if _, repeated := seen[signature]; repeated {
			return nil, fmt.Errorf("%w: repeated scheduler state", ErrSchedulingLoop)
		}
		seen[signature] = struct{}{}
		if len(seen) > 1<<18 {
			return nil, fmt.Errorf("%w: too many states", ErrSchedulingLoop)
		}
		step, progressed, err := s.stepLocked()
		if err != nil {
			return nil, err
		}
		if !progressed {
			break
		}
		total.merge(step)
	}
	s.finishDecision(total)
	return total, nil
}

// AllocateOne performs at most one admission (possibly preceded by
// preemptions). The bool reports whether anything changed.
func (s *Scheduler) AllocateOne() (*Decision, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	decision, progressed, err := s.stepLocked()
	if err != nil {
		return nil, false, err
	}
	s.finishDecision(decision)
	return decision, progressed, nil
}

// Step is an alias for AllocateOne.
func (s *Scheduler) Step() (*Decision, bool, error) { return s.AllocateOne() }

func (s *Scheduler) stepLocked() (*Decision, bool, error) {
	candidates := s.candidatesLocked()
	if len(candidates) == 0 {
		return &Decision{}, false, nil
	}

	free := s.capacity.Sub(s.used)
	for _, task := range candidates {
		total, err := task.task.TotalDemand()
		if err != nil {
			return nil, false, err
		}
		if total.Fits(free) {
			admitted, err := s.admitLocked(task, total)
			if err != nil {
				return nil, false, err
			}
			decision := &Decision{Admitted: []Allocation{admitted}, Steps: 1}
			return decision, true, nil
		}

		if s.options.DisablePreemption {
			continue
		}
		if !total.Fits(s.capacity) {
			continue
		}
		victims, ok := s.selectVictimsLocked(task, total)
		if !ok {
			continue
		}

		preempted := make([]Allocation, 0, len(victims))
		for _, victim := range victims {
			preempted = append(preempted, s.allocationOfLocked(victim))
		}
		for _, victim := range victims {
			s.releaseRunningLocked(victim, "preempted", true)
		}
		free = s.capacity.Sub(s.used)
		if !total.Fits(free) {
			// The victim set was computed from the same ledger; this can only
			// happen if an internal invariant was violated.
			return nil, false, fmt.Errorf("drf: preemption selected insufficient victims")
		}
		admitted, err := s.admitLocked(task, total)
		if err != nil {
			return nil, false, err
		}
		decision := &Decision{
			Admitted:  []Allocation{admitted},
			Preempted: preempted,
			Steps:     1 + len(preempted),
		}
		return decision, true, nil
	}

	s.markWaitingReasonsLocked()
	return &Decision{}, false, nil
}

func (s *Scheduler) stateSignatureLocked() string {
	tasks := make([]*taskState, 0, len(s.tasks))
	for _, task := range s.tasks {
		tasks = append(tasks, task)
	}
	sortTasks(tasks)
	var builder strings.Builder
	builder.WriteString(s.used.String())
	for _, task := range tasks {
		builder.WriteByte('|')
		builder.WriteString(task.task.ID)
		builder.WriteByte(':')
		builder.WriteString(string(task.status))
		builder.WriteByte(':')
		builder.WriteString(task.alloc.String())
	}
	return builder.String()
}

func (s *Scheduler) candidatesLocked() []*taskState {
	candidates := make([]*taskState, 0)
	for _, task := range s.tasks {
		if task.status == StatusWaiting {
			candidates = append(candidates, task)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		leftShare, rightShare := queueShare(left.queue), queueShare(right.queue)
		if comparison := leftShare.Cmp(rightShare); comparison != 0 {
			return comparison < 0
		}
		if left.queue.sequence != right.queue.sequence {
			return left.queue.sequence < right.queue.sequence
		}
		if left.sequence != right.sequence {
			return left.sequence < right.sequence
		}
		return left.task.ID < right.task.ID
	})
	return candidates
}

type victim struct {
	task       *taskState
	share      Share
	queueShare Share
}

func (s *Scheduler) selectVictimsLocked(candidate *taskState, demand Vector) ([]*taskState, bool) {
	potential := weightedShare(
		demand,
		s.capacity,
		candidate.queue.queue.NormalizedWeight(),
		candidate.task.NormalizedWeight(),
	)
	projectedQueue := weightedShare(
		candidate.queue.used.Add(demand),
		s.capacity,
		candidate.queue.queue.NormalizedWeight(),
	)

	victims := make([]victim, 0)
	for _, task := range s.tasks {
		if task.status != StatusRunning {
			continue
		}
		if !s.options.PreemptSameQueue && task.queue == candidate.queue {
			continue
		}
		share := taskShare(task, task.queue)
		comparison := share.Cmp(potential)
		if comparison < 0 || (comparison == 0 && !s.options.AllowEqualSharePreemption) {
			continue
		}
		victimQueueShare := queueShare(task.queue)
		if task.queue != candidate.queue && victimQueueShare.Cmp(projectedQueue) < 0 {
			// Do not take resources from a queue that is already at a
			// lower projected share than the requester.
			continue
		}
		victims = append(victims, victim{
			task:       task,
			share:      share,
			queueShare: victimQueueShare,
		})
	}
	if len(victims) == 0 {
		return nil, false
	}
	sort.Slice(victims, func(i, j int) bool {
		left, right := victims[i], victims[j]
		if comparison := left.share.Cmp(right.share); comparison != 0 {
			return comparison > 0
		}
		if comparison := left.queueShare.Cmp(right.queueShare); comparison != 0 {
			return comparison > 0
		}
		if left.task.sequence != right.task.sequence {
			return left.task.sequence < right.task.sequence
		}
		return left.task.task.ID < right.task.task.ID
	})

	projected := s.used.Clone()
	selected := make([]*taskState, 0, len(victims))
	for _, victim := range victims {
		selected = append(selected, victim.task)
		projected.subInPlace(victim.task.alloc)
		if projected.Add(demand).Fits(s.capacity) {
			return selected, true
		}
	}
	return nil, false
}

func (s *Scheduler) allocationOfLocked(task *taskState) Allocation {
	return Allocation{
		TaskID:        task.task.ID,
		QueueID:       task.queue.queue.ID,
		GangSize:      task.task.GangMembers(),
		Resources:     task.alloc.Clone(),
		DominantShare: taskShare(task, task.queue),
		QueueShare:    queueShare(task.queue),
		Sequence:      task.sequence,
	}
}

func (s *Scheduler) admitLocked(task *taskState, total Vector) (Allocation, error) {
	if task.status != StatusWaiting {
		return Allocation{}, fmt.Errorf("drf: task %q is not waiting", task.task.ID)
	}
	if !total.Fits(s.capacity.Sub(s.used)) {
		return Allocation{}, fmt.Errorf("drf: task %q does not fit in free capacity", task.task.ID)
	}
	task.alloc = total.Clone()
	task.status = StatusRunning
	task.reason = ""
	task.queue.used.addInPlace(total)
	s.used.addInPlace(total)
	s.steps++
	return s.allocationOfLocked(task), nil
}

func (s *Scheduler) releaseRunningLocked(task *taskState, reason string, preempted bool) {
	task.queue.used.subInPlace(task.alloc)
	s.used.subInPlace(task.alloc)
	task.alloc = make(Vector, len(s.capacity))
	task.status = StatusWaiting
	task.reason = reason
	if preempted {
		task.preemptions++
	}
}

func (s *Scheduler) markWaitingReasonsLocked() {
	free := s.capacity.Sub(s.used)
	for _, task := range s.tasks {
		if task.status != StatusWaiting {
			continue
		}
		total, err := task.task.TotalDemand()
		switch {
		case err != nil:
			task.reason = "invalid demand"
		case !total.Fits(s.capacity):
			task.reason = "gang request exceeds cluster capacity"
		case s.options.DisablePreemption:
			task.reason = "insufficient free resources (preemption disabled)"
		case !total.Fits(free):
			task.reason = "insufficient free resources (no eligible preemption victims)"
		default:
			task.reason = "waiting"
		}
	}
}

func (s *Scheduler) finishDecision(decision *Decision) {
	_, waiting := s.runningAndWaitingLocked()
	reasons := make(map[string]string, len(waiting))
	for _, task := range waiting {
		reasons[task.task.ID] = task.reason
	}
	decision.finish(s.capacity, s.used, s.queues, waiting, reasons)
}

func (s *Scheduler) runningAndWaitingLocked() ([]*taskState, []*taskState) {
	running := make([]*taskState, 0)
	waiting := make([]*taskState, 0)
	for _, task := range s.tasks {
		switch task.status {
		case StatusRunning:
			running = append(running, task)
		case StatusWaiting:
			waiting = append(waiting, task)
		}
	}
	sortTasks(running)
	sortTasks(waiting)
	return running, waiting
}

func sortTasks(tasks []*taskState) {
	sort.Slice(tasks, func(i, j int) bool {
		if tasks[i].sequence != tasks[j].sequence {
			return tasks[i].sequence < tasks[j].sequence
		}
		return tasks[i].task.ID < tasks[j].task.ID
	})
}

// Preempt immediately releases a running task and returns the whole task to
// the waiting set. It does not admit a replacement; call Allocate for that.
func (s *Scheduler) Preempt(taskID string) (Allocation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.tasks[taskID]
	if !ok {
		return Allocation{}, fmt.Errorf("%w: %q", ErrUnknownTask, taskID)
	}
	if task.status != StatusRunning {
		return Allocation{}, fmt.Errorf("%w: %q", ErrTaskNotRunning, taskID)
	}
	allocation := s.allocationOfLocked(task)
	s.releaseRunningLocked(task, "preempted manually", true)
	s.steps++
	return allocation, nil
}

// Complete releases a running task permanently. Completing a waiting task
// cancels it.
func (s *Scheduler) Complete(taskID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.tasks[taskID]
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownTask, taskID)
	}
	switch task.status {
	case StatusRunning:
		s.releaseRunningLocked(task, "", false)
		task.status = StatusCompleted
		s.steps++
	case StatusWaiting:
		task.status = StatusCancelled
		task.reason = "cancelled"
	default:
		return fmt.Errorf("%w: %q is %s", ErrTaskNotRunning, taskID, task.status)
	}
	return nil
}

// Release is an alias for Complete.
func (s *Scheduler) Release(taskID string) error { return s.Complete(taskID) }

// Cancel withdraws a waiting task.
func (s *Scheduler) Cancel(taskID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.tasks[taskID]
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownTask, taskID)
	}
	if task.status != StatusWaiting {
		return fmt.Errorf("%w: %q is %s", ErrTaskNotRunning, taskID, task.status)
	}
	task.status = StatusCancelled
	task.reason = "cancelled"
	return nil
}

// SetPreemptionEnabled toggles automatic preemption for future Allocate calls.
func (s *Scheduler) SetPreemptionEnabled(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.options.DisablePreemption = !enabled
}

// QueueUsage returns the current aggregate allocation of a queue.
func (s *Scheduler) QueueUsage(queueID string) (Vector, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue, ok := s.queues[queueID]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownQueue, queueID)
	}
	return queue.used.Clone(), nil
}

// QueueShare returns the exact weighted dominant share of a queue.
func (s *Scheduler) QueueShare(queueID string) (Share, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	queue, ok := s.queues[queueID]
	if !ok {
		return Share{}, fmt.Errorf("%w: %q", ErrUnknownQueue, queueID)
	}
	return queueShare(queue), nil
}

// TaskShare returns the exact weighted dominant share of a task. Waiting or
// completed tasks have zero share.
func (s *Scheduler) TaskShare(taskID string) (Share, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.tasks[taskID]
	if !ok {
		return Share{}, fmt.Errorf("%w: %q", ErrUnknownTask, taskID)
	}
	return taskShare(task, task.queue), nil
}

// StatusOf returns the current lifecycle status of a task.
func (s *Scheduler) StatusOf(taskID string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.tasks[taskID]
	if !ok {
		return "", fmt.Errorf("%w: %q", ErrUnknownTask, taskID)
	}
	return task.status, nil
}

// AllocationOf returns the reservation of a task. Waiting and terminal tasks
// have an empty resource vector.
func (s *Scheduler) AllocationOf(taskID string) (Allocation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.tasks[taskID]
	if !ok {
		return Allocation{}, false
	}
	return s.allocationOfLocked(task), true
}

// TaskInfo returns a detailed exported view of one task.
func (s *Scheduler) TaskInfo(taskID string) (TaskInfo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.tasks[taskID]
	if !ok {
		return TaskInfo{}, false
	}
	return task.info(task.queue), true
}

// Queues returns all queue definitions in registration order.
func (s *Scheduler) Queues() []Queue {
	s.mu.Lock()
	defer s.mu.Unlock()
	queues := make([]Queue, 0, len(s.queueOrder))
	for _, queue := range s.queueOrder {
		definition := queue.queue
		definition.Tasks = nil
		queues = append(queues, definition)
	}
	return queues
}

// Snapshot returns a consistent immutable view of the scheduler.
func (s *Scheduler) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	running, waiting := s.runningAndWaitingLocked()
	snapshot := Snapshot{
		Capacity: s.capacity.Clone(),
		Used:     s.used.Clone(),
		Free:     s.capacity.Sub(s.used),
		Queues:   make(map[string]QueueSnapshot, len(s.queues)),
		Steps:    s.steps,
	}
	for _, task := range running {
		snapshot.Running = append(snapshot.Running, s.allocationOfLocked(task))
	}
	for _, task := range waiting {
		snapshot.Waiting = append(snapshot.Waiting, task.task.ID)
	}
	for id, queue := range s.queues {
		view := QueueSnapshot{
			ID:     id,
			Weight: queue.queue.NormalizedWeight(),
			Used:   queue.used.Clone(),
			Share:  queueShare(queue),
		}
		for _, task := range queue.tasks {
			switch task.status {
			case StatusRunning:
				view.Running = append(view.Running, s.allocationOfLocked(task))
			case StatusWaiting:
				view.Waiting = append(view.Waiting, task.task.ID)
			}
		}
		snapshot.Queues[id] = view
	}
	return snapshot
}

// Validate recomputes the resource ledger and checks the core invariants:
// atomic gangs, per-queue accounting, and no overcommit.
func (s *Scheduler) Validate() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	global := make(Vector, len(s.capacity))
	for id, queue := range s.queues {
		queueTotal := make(Vector, len(s.capacity))
		for _, task := range queue.tasks {
			switch task.status {
			case StatusRunning:
				expected, err := task.task.TotalDemand()
				if err != nil {
					return err
				}
				if !task.alloc.Equal(expected) {
					return fmt.Errorf("drf: task %q holds %s, want gang request %s", task.task.ID, task.alloc, expected)
				}
				queueTotal.addInPlace(task.alloc)
			default:
				if !task.alloc.IsZero() {
					return fmt.Errorf("drf: non-running task %q still holds %s", task.task.ID, task.alloc)
				}
			}
		}
		if !queue.used.Equal(queueTotal) {
			return fmt.Errorf("drf: queue %q ledger is %s, want %s", id, queue.used, queueTotal)
		}
		global.addInPlace(queueTotal)
	}
	if !global.Equal(s.used) {
		return fmt.Errorf("drf: global ledger is %s, want %s", s.used, global)
	}
	if !s.used.Fits(s.capacity) {
		return fmt.Errorf("drf: overcommit: used %s exceeds capacity %s", s.used, s.capacity)
	}
	return nil
}
