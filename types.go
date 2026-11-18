package formal

import (
	"fmt"
	"math"
	"strings"
)

// Status is the lifecycle state of a submitted task.
type Status string

const (
	// StatusWaiting means the task is queued and holds no resources. A
	// preempted task also returns to this state.
	StatusWaiting Status = "waiting"
	// StatusRunning means the whole gang holds its full resource request.
	StatusRunning Status = "running"
	// StatusCompleted means the task released its resources permanently.
	StatusCompleted Status = "completed"
	// StatusCancelled means a waiting task was withdrawn.
	StatusCancelled Status = "cancelled"
)

// Task is an atomic gang request.
//
// Demand is the resource request of one gang member. GangSize is the number
// of identical members that must be admitted together; zero means one and
// negative values are rejected on submission.
// A task is never partially admitted: either all GangSize members receive
// Demand, or the task remains waiting.
//
// Weight is an optional per-task DRF weight. Zero means one and negative
// values are rejected on submission. The effective share weight of a task is
// Queue.Weight * Task.Weight.
type Task struct {
	ID       string
	QueueID  string
	Demand   Vector
	GangSize int
	Weight   int64
}

// GangMembers returns the normalized, positive gang size.
func (t Task) GangMembers() int {
	if t.GangSize <= 0 {
		return 1
	}
	return t.GangSize
}

// NormalizedWeight returns the normalized, positive task weight.
func (t Task) NormalizedWeight() int64 {
	if t.Weight <= 0 {
		return 1
	}
	return t.Weight
}

// TotalDemand returns Demand multiplied by the gang size. The result is the
// amount of resources reserved atomically for the task.
func (t Task) TotalDemand() (Vector, error) {
	members := int64(t.GangMembers())
	total := make(Vector, len(t.Demand))
	for name, amount := range t.Demand {
		if amount < 0 {
			return nil, fmt.Errorf("%w: resource %q has negative demand %d", ErrInvalidTask, name, amount)
		}
		if amount != 0 && members > math.MaxInt64/amount {
			return nil, fmt.Errorf("%w: gang demand for resource %q overflows int64", ErrInvalidTask, name)
		}
		total[name] = amount * members
	}
	return total, nil
}

// Queue groups tasks and carries a DRF weight. Tasks in a queue share the
// queue's allocation history.
type Queue struct {
	ID     string
	Weight int64
	// Tasks is optional; AddQueue submits these tasks after registering the
	// queue. Task.QueueID may be left empty in this slice.
	Tasks []Task
}

// NormalizedWeight returns the queue's positive DRF weight.
func (q Queue) NormalizedWeight() int64 {
	if q.Weight <= 0 {
		return 1
	}
	return q.Weight
}

// Allocation describes the resource reservation and exact shares of one task
// at a particular instant. DominantShare is weighted by both queue and task
// weights; QueueShare is weighted by the queue weight.
type Allocation struct {
	TaskID        string
	QueueID       string
	GangSize      int
	Resources     Vector
	DominantShare Share
	QueueShare    Share
	Sequence      uint64
}

// Decision is the result of one scheduling step or a whole Allocate pass.
//
// Waiting and Reasons describe the state after the decision. QueueUsed and
// QueueShares contain every registered queue, including empty ones.
type Decision struct {
	Admitted    []Allocation
	Preempted   []Allocation
	Waiting     []string
	Reasons     map[string]string
	Used        Vector
	Free        Vector
	QueueUsed   map[string]Vector
	QueueShares map[string]Share
	Steps       int
}

// QueueSnapshot is an immutable view of one queue.
type QueueSnapshot struct {
	ID      string
	Weight  int64
	Used    Vector
	Share   Share
	Running []Allocation
	Waiting []string
}

// Snapshot is a consistent view of the scheduler.
type Snapshot struct {
	Capacity Vector
	Used     Vector
	Free     Vector
	Queues   map[string]QueueSnapshot
	Running  []Allocation
	Waiting  []string
	Steps    uint64
}

func (d *Decision) merge(other *Decision) {
	d.Admitted = append(d.Admitted, other.Admitted...)
	d.Preempted = append(d.Preempted, other.Preempted...)
	d.Steps += other.Steps
}

func (d *Decision) finish(capacity Vector, used Vector, queues map[string]*queueState, waiting []*taskState, reasons map[string]string) {
	d.Used = used.Clone()
	d.Free = capacity.Sub(used)
	d.QueueUsed = make(map[string]Vector, len(queues))
	d.QueueShares = make(map[string]Share, len(queues))
	for id, queue := range queues {
		d.QueueUsed[id] = queue.used.Clone()
		d.QueueShares[id] = queueShare(queue)
	}
	d.Waiting = make([]string, 0, len(waiting))
	for _, task := range waiting {
		d.Waiting = append(d.Waiting, task.task.ID)
	}
	d.Reasons = make(map[string]string, len(reasons))
	for id, reason := range reasons {
		d.Reasons[id] = reason
	}
}

// TaskInfo is an exported view of a task's current scheduling metadata.
// DominantShare is the task's exact queue- and task-weighted share.
type TaskInfo struct {
	ID            string
	QueueID       string
	Demand        Vector
	GangSize      int
	Weight        int64
	Status        Status
	Resources     Vector
	DominantShare Share
	QueueShare    Share
	Sequence      uint64
	Preemptions   int
	Reason        string
}

func (t *taskState) info(queue *queueState) TaskInfo {
	return TaskInfo{
		ID:            t.task.ID,
		QueueID:       queue.queue.ID,
		Demand:        t.task.Demand.Clone(),
		GangSize:      t.task.GangMembers(),
		Weight:        t.task.NormalizedWeight(),
		Status:        t.status,
		Resources:     t.alloc.Clone(),
		DominantShare: taskShare(t, queue),
		QueueShare:    queueShare(queue),
		Sequence:      t.sequence,
		Preemptions:   t.preemptions,
		Reason:        t.reason,
	}
}

func taskShare(task *taskState, queue *queueState) Share {
	return weightedShare(task.alloc, queue.capacity, queue.queue.NormalizedWeight(), task.task.NormalizedWeight())
}

func queueShare(queue *queueState) Share {
	return weightedShare(queue.used, queue.capacity, queue.queue.NormalizedWeight())
}

func weightedShare(used, capacity Vector, factors ...int64) Share {
	_, share := dominantResource(used, capacity, factors...)
	return share
}

func requireNonEmpty(value, what string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%w: %s must not be empty", ErrInvalidQueue, what)
	}
	return nil
}
