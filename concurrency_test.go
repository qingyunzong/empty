package formal

import (
	"fmt"
	"math/rand"
	"sync"
	"testing"
	"time"
)

func TestConcurrentReserveReleaseAccounting(t *testing.T) {
	nodes := []Node{
		{ID: "root", Limit: Resources{"cpu": 40, "mem": 40}},
		{ID: "a", Parent: "root", Limit: Resources{"cpu": 15}},
		{ID: "b", Parent: "root", Limit: Resources{"cpu": 15}},
		{ID: "c", Parent: "root"},
		{ID: "d", Parent: "root"},
		{ID: "e", Parent: "root"},
	}
	topo := topology{
		config:   Config{Nodes: nodes},
		parents:  make(map[string]string),
		limits:   make(map[string]Resources),
		children: make(map[string][]string),
	}
	leaves := []string{"a", "b", "c", "d", "e"}
	for _, node := range nodes {
		topo.parents[node.ID] = node.Parent
		topo.limits[node.ID] = node.Limit
		if node.Parent != "" {
			topo.children[node.Parent] = append(topo.children[node.Parent], node.ID)
		}
	}

	calc, err := NewCalculator(topo.config)
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}

	const (
		workers    = 12
		iterations = 180
	)
	stop := make(chan struct{})
	errCh := make(chan error, 16)
	var wg sync.WaitGroup

	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(worker) + 1000))
			for i := 0; i < iterations; i++ {
				id := fmt.Sprintf("w%d-%d", worker, i)
				request := Request{
					ID:       id,
					Node:     leaves[rng.Intn(len(leaves))],
					Priority: int64(rng.Intn(8)),
					Resources: Resources{
						"cpu": int64(1 + rng.Intn(4)),
						"mem": int64(1 + rng.Intn(4)),
					},
				}
				hold, err := calc.TryReserve(request)
				if err != nil {
					continue
				}
				if rng.Intn(2) == 0 {
					if _, err := calc.Commit(id); err != nil {
						// The hold may have been preempted between reserve and
						// commit; only unknown hold is acceptable.
						if !containsError(err, ErrUnknownHold) {
							select {
							case errCh <- fmt.Errorf("commit %s: %w", id, err):
							default:
							}
						}
						continue
					}
				}
				if len(hold.Granted) > 0 && rng.Intn(10) < 7 {
					if _, err := calc.Release(id); err != nil && !containsError(err, ErrUnknownHold) {
						select {
						case errCh <- fmt.Errorf("release %s: %w", id, err):
						default:
						}
					}
				}
			}
		}(worker)
	}

	// A preemptor races with admissions and releases. It intentionally
	// requests more than may be available, exercising shortfall accounting.
	wg.Add(1)
	go func() {
		defer wg.Done()
		rng := rand.New(rand.NewSource(77))
		for i := 0; i < iterations; i++ {
			target := Resources{
				"cpu": int64(1 + rng.Intn(5)),
				"mem": int64(1 + rng.Intn(3)),
			}
			if rng.Intn(3) == 0 {
				_, err := calc.PreemptBelow("root", int64(rng.Intn(9)), target)
				if err != nil && !containsError(err, ErrReclaimShortfall) {
					select {
					case errCh <- fmt.Errorf("preempt: %w", err):
					default:
					}
				}
			} else {
				_, err := calc.Preempt(leaves[rng.Intn(len(leaves))], target)
				if err != nil && !containsError(err, ErrReclaimShortfall) {
					select {
					case errCh <- fmt.Errorf("preempt: %w", err):
					default:
					}
				}
			}
			time.Sleep(time.Microsecond)
		}
	}()

	// Auditors independently recompute subtree totals from snapshots.
	var auditors sync.WaitGroup
	for auditor := 0; auditor < 4; auditor++ {
		auditors.Add(1)
		go func() {
			defer auditors.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if err := calc.Check(); err != nil {
					select {
					case errCh <- fmt.Errorf("check: %w", err):
					default:
					}
					return
				}
				if err := verifySnapshotError(calc.Snapshot(), topo); err != nil {
					select {
					case errCh <- err:
					default:
					}
					return
				}
			}
		}()
	}

	wg.Wait()
	close(stop)
	auditors.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}

	for _, hold := range calc.Holds() {
		if _, err := calc.Release(hold.ID); err != nil {
			t.Fatalf("final release %s: %v", hold.ID, err)
		}
	}
	if err := calc.Check(); err != nil {
		t.Fatalf("final Check: %v", err)
	}
	for _, node := range calc.Nodes() {
		usage, err := calc.NodeUsage(node)
		if err != nil {
			t.Fatalf("NodeUsage(%s): %v", node, err)
		}
		if !usage.Used.IsZero() || !usage.Allocated.IsZero() || !usage.Reserved.IsZero() {
			t.Fatalf("node %s not empty after final releases: %+v", node, usage)
		}
	}
}

func verifySnapshotError(snap Snapshot, topo topology) error {
	used := make(map[string]Resources)
	allocated := make(map[string]Resources)
	reserved := make(map[string]Resources)
	for id := range topo.parents {
		used[id] = Resources{}
		allocated[id] = Resources{}
		reserved[id] = Resources{}
	}
	for _, hold := range snap.Holds {
		if hold.State != Reserved && hold.State != Allocated {
			return fmt.Errorf("hold %s has invalid state %q", hold.ID, hold.State)
		}
		for resource, amount := range hold.Granted {
			if amount < 0 {
				return fmt.Errorf("hold %s has negative grant %v", hold.ID, hold.Granted)
			}
			for node := hold.Node; node != ""; node = topo.parents[node] {
				used[node][resource] += amount
				if hold.State == Allocated {
					allocated[node][resource] += amount
				} else {
					reserved[node][resource] += amount
				}
			}
		}
	}
	for node, usage := range snap.Usage {
		if !resourcesEqual(usage.Used, used[node]) {
			return fmt.Errorf("node %s used %v, holds sum %v", node, usage.Used, used[node])
		}
		if !resourcesEqual(usage.Allocated, allocated[node]) {
			return fmt.Errorf("node %s allocated %v, holds sum %v", node, usage.Allocated, allocated[node])
		}
		if !resourcesEqual(usage.Reserved, reserved[node]) {
			return fmt.Errorf("node %s reserved %v, holds sum %v", node, usage.Reserved, reserved[node])
		}
		for resource, amount := range usage.Used {
			if amount != usage.Allocated[resource]+usage.Reserved[resource] {
				return fmt.Errorf("node %s resource %s: used %d != allocated %d + reserved %d",
					node, resource, amount, usage.Allocated[resource], usage.Reserved[resource])
			}
			if limit, ok := topo.limits[node][resource]; ok && amount > limit {
				return fmt.Errorf("node %s resource %s used %d exceeds limit %d", node, resource, amount, limit)
			}
		}
	}
	return nil
}
