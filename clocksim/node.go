package clocksim

import "sync"

// VersionedValue is a stored value together with the commit interval of the
// write that produced it. Commit.Latest is the commit upper bound.
type VersionedValue struct {
	Value  string
	Commit Interval
}

// Node couples a clock with a small key/value store.
type Node struct {
	ID    string
	Clock *ManualClock

	mu    sync.Mutex
	store map[string]VersionedValue
}

// NewNode creates a node with the given id and clock.
func NewNode(id string, clock *ManualClock) *Node {
	return &Node{ID: id, Clock: clock, store: make(map[string]VersionedValue)}
}

// Write commits a value. The commit interval is the writer's clock interval
// at commit time; its Latest is the upper bound readers must wait past.
func (n *Node) Write(key, value string) VersionedValue {
	vv := VersionedValue{Value: value, Commit: n.Clock.Now()}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.store[key] = vv
	return vv
}

// Lookup returns the stored value without any visibility check.
func (n *Node) Lookup(key string) (VersionedValue, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	vv, ok := n.store[key]
	return vv, ok
}

// VisibleAt reports whether a value with the given commit interval may be
// served to a reader whose clock currently reads now. The rule: the read is
// safe only when the reader's earliest possible "now" is strictly later than
// the write's commit upper bound.
func VisibleAt(now Interval, commit Interval) bool {
	return now.Earliest > commit.Latest
}

// Read performs a single non-blocking read attempt. It returns the value and
// true only if it is visible under the reader's current clock interval.
func (n *Node) Read(key string) (VersionedValue, bool) {
	vv, ok := n.Lookup(key)
	if !ok {
		return VersionedValue{}, false
	}
	if !VisibleAt(n.Clock.Now(), vv.Commit) {
		return VersionedValue{}, false
	}
	return vv, true
}

// WaitForVisible ticks the node's clock until the value for key becomes
// visible, the interval stops making progress, or maxTicks is exhausted.
// It returns the value (only when visible), whether it may be served, and
// the evidence of the wait.
func (n *Node) WaitForVisible(key string, maxTicks int) (VersionedValue, bool, WaitEvidence) {
	vv, ok := n.Lookup(key)
	start := n.Clock.Now()
	ev := WaitEvidence{
		Node:         n.ID,
		Key:          key,
		Start:        start,
		End:          start,
		Outcome:      PendingTickLimit,
	}
	if !ok {
		ev.Outcome = PendingNoProgress
		return VersionedValue{}, false, ev
	}
	ev.CommitLatest = vv.Commit.Latest

	now := start
	if VisibleAt(now, vv.Commit) {
		ev.Outcome = Visible
		return vv, true, ev
	}
	for i := 0; i < maxTicks; i++ {
		next, progress := n.Clock.Tick()
		ev.AfterTicks = append(ev.AfterTicks, next)
		ev.End = next
		if !progress {
			ev.Outcome = PendingNoProgress
			return VersionedValue{}, false, ev
		}
		if VisibleAt(next, vv.Commit) {
			ev.Outcome = Visible
			return vv, true, ev
		}
	}
	return VersionedValue{}, false, ev
}
