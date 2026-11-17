package formal

import (
	"sync"
	"time"
)

// Transport abstracts replica-to-replica RPCs so the coordinator stays free
// of network details. caller is the coordinator's local replica ID and is
// used to evaluate partition-group reachability.
type Transport interface {
	Read(caller, target, key string) ([]Version, error)
	Write(caller, target, key string, versions []Version) error
	Watermark(caller, target string) (int64, error)
	AdvanceWatermark(caller, target string, epoch int64) error
	GC(caller, target string, key string) (int, error)
}

// fakeTransport is an in-process transport with injectable partitions and
// per-node one-way latency. Nodes carry a partition-group label: an RPC only
// succeeds when caller and target belong to the same group (the empty group
// is the healed default), modeling a real network split.
type fakeTransport struct {
	mu sync.Mutex

	nodes  map[string]*Replica
	groups map[string]string
	delays map[string]time.Duration
}

// NewFakeTransport wires a transport over the given replicas.
func NewFakeTransport(replicas ...*Replica) *fakeTransport {
	t := &fakeTransport{
		nodes:  make(map[string]*Replica),
		groups: make(map[string]string),
		delays: make(map[string]time.Duration),
	}
	for _, replica := range replicas {
		t.nodes[replica.id] = replica
		t.groups[replica.id] = ""
	}
	return t
}

// Partition isolates node in its own group until Heal is called.
func (t *fakeTransport) Partition(node string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.groups[node] = "isolated:" + node
}

// SetGroup places node into a named partition group. Nodes in different
// groups cannot exchange RPCs.
func (t *fakeTransport) SetGroup(node, group string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.groups[node] = group
}

// Heal restores connectivity for node by returning it to the default group.
func (t *fakeTransport) Heal(node string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.groups[node] = ""
}

// SetDelay injects a fixed one-way latency onto RPCs targeting node.
func (t *fakeTransport) SetDelay(node string, delay time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.delays[node] = delay
}

// canReach reports whether caller may address target under the groups.
func (t *fakeTransport) canReach(caller, target string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	cg, cok := t.groups[caller]
	tg, tok := t.groups[target]
	return cok && tok && cg == tg
}

// delay returns the configured latency for node.
func (t *fakeTransport) delay(node string) time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.delays[node]
}

// ErrUnreachable is returned when an RPC targets an unreachable replica.
type ErrUnreachable struct{ Node string }

func (e ErrUnreachable) Error() string { return "replica unreachable: " + e.Node }

func (t *fakeTransport) Read(caller, target, key string) ([]Version, error) {
	if !t.canReach(caller, target) {
		return nil, ErrUnreachable{Node: target}
	}
	if delay := t.delay(target); delay > 0 {
		time.Sleep(delay)
	}
	replica, ok := t.nodes[target]
	if !ok {
		return nil, ErrUnreachable{Node: target}
	}
	return replica.Snapshot(key), nil
}

func (t *fakeTransport) Write(caller, target, key string, versions []Version) error {
	if !t.canReach(caller, target) {
		return ErrUnreachable{Node: target}
	}
	if delay := t.delay(target); delay > 0 {
		time.Sleep(delay)
	}
	replica, ok := t.nodes[target]
	if !ok {
		return ErrUnreachable{Node: target}
	}
	replica.Apply(key, versions)
	return nil
}

func (t *fakeTransport) Watermark(caller, target string) (int64, error) {
	if !t.canReach(caller, target) {
		return 0, ErrUnreachable{Node: target}
	}
	replica, ok := t.nodes[target]
	if !ok {
		return 0, ErrUnreachable{Node: target}
	}
	return replica.Watermark(), nil
}

func (t *fakeTransport) AdvanceWatermark(caller, target string, epoch int64) error {
	if !t.canReach(caller, target) {
		return ErrUnreachable{Node: target}
	}
	replica, ok := t.nodes[target]
	if !ok {
		return ErrUnreachable{Node: target}
	}
	replica.AdvanceWatermark(epoch)
	return nil
}

func (t *fakeTransport) GC(caller, target, key string) (int, error) {
	if !t.canReach(caller, target) {
		return 0, ErrUnreachable{Node: target}
	}
	replica, ok := t.nodes[target]
	if !ok {
		return 0, ErrUnreachable{Node: target}
	}
	return replica.GC(key), nil
}
