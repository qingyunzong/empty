package formal

import (
	"errors"
	"fmt"
	"sort"
	"testing"
)

type topology struct {
	parents  map[string]string
	limits   map[string]Resources
	config   Config
	children map[string][]string
}

func smallTopology() topology {
	nodes := []Node{
		{ID: "root", Limit: Resources{"cpu": 5, "mem": 5}},
		{ID: "a", Parent: "root", Limit: Resources{"cpu": 3, "mem": 4}},
		{ID: "b", Parent: "root", Limit: Resources{"cpu": 2, "mem": 3}},
		{ID: "c", Parent: "a"},
		{ID: "d", Parent: "b"},
	}
	t := topology{
		parents:  make(map[string]string, len(nodes)),
		limits:   make(map[string]Resources, len(nodes)),
		config:   Config{Nodes: nodes},
		children: make(map[string][]string),
	}
	for _, node := range nodes {
		t.parents[node.ID] = node.Parent
		t.limits[node.ID] = node.Limit
		if node.Parent != "" {
			t.children[node.Parent] = append(t.children[node.Parent], node.ID)
		}
	}
	return t
}

func verifySnapshot(t *testing.T, snap Snapshot, topo topology) {
	t.Helper()
	used := make(map[string]Resources)
	allocated := make(map[string]Resources)
	reserved := make(map[string]Resources)
	for id := range topo.parents {
		used[id] = Resources{}
		allocated[id] = Resources{}
		reserved[id] = Resources{}
	}
	for _, hold := range snap.Holds {
		for resource, amount := range hold.Granted {
			if amount < 0 {
				t.Fatalf("hold %s has negative grant %v", hold.ID, hold.Granted)
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
			t.Fatalf("node %s used %v, holds sum %v", node, usage.Used, used[node])
		}
		if !resourcesEqual(usage.Allocated, allocated[node]) {
			t.Fatalf("node %s allocated %v, holds sum %v", node, usage.Allocated, allocated[node])
		}
		if !resourcesEqual(usage.Reserved, reserved[node]) {
			t.Fatalf("node %s reserved %v, holds sum %v", node, usage.Reserved, reserved[node])
		}
		for resource, amount := range usage.Used {
			if amount != usage.Allocated[resource]+usage.Reserved[resource] {
				t.Fatalf("node %s resource %s: used %d != allocated %d + reserved %d",
					node, resource, amount, usage.Allocated[resource], usage.Reserved[resource])
			}
			if limit, ok := topo.limits[node][resource]; ok && amount > limit {
				t.Fatalf("node %s resource %s used %d exceeds limit %d", node, resource, amount, limit)
			}
		}
	}
}

func permutations(n int) [][]int {
	values := make([]int, n)
	for i := range values {
		values[i] = i
	}
	var out [][]int
	var generate func(int)
	generate = func(at int) {
		if at == len(values) {
			out = append(out, append([]int(nil), values...))
			return
		}
		for i := at; i < len(values); i++ {
			values[at], values[i] = values[i], values[at]
			generate(at + 1)
			values[at], values[i] = values[i], values[at]
		}
	}
	generate(0)
	return out
}

func TestExhaustiveReservationSequences(t *testing.T) {
	topo := smallTopology()
	requests := []Request{
		{ID: "r0", Node: "c", Resources: Resources{"cpu": 2, "mem": 1}},
		{ID: "r1", Node: "d", Resources: Resources{"cpu": 1, "mem": 2}},
		{ID: "r2", Node: "c", Resources: Resources{"cpu": 1, "mem": 2}},
		{ID: "r3", Node: "d", Resources: Resources{"cpu": 2, "mem": 1}},
	}

	for _, order := range permutations(len(requests)) {
		calc, err := NewCalculator(topo.config)
		if err != nil {
			t.Fatalf("NewCalculator: %v", err)
		}
		admitted := make([]string, 0, len(order))
		for _, index := range order {
			request := requests[index]
			hold, err := calc.Reserve(request)
			if err == nil {
				admitted = append(admitted, hold.ID)
			} else if !isQuotaError(err) {
				t.Fatalf("order %v request %s: %v", order, request.ID, err)
			}
			if err := calc.Check(); err != nil {
				t.Fatalf("order %v after %s: %v", order, request.ID, err)
			}
			verifySnapshot(t, calc.Snapshot(), topo)
			for _, node := range calc.Nodes() {
				usage, err := calc.NodeUsage(node)
				if err != nil {
					t.Fatalf("NodeUsage(%s): %v", node, err)
				}
				for resource, limit := range topo.limits[node] {
					if usage.Used[resource] > limit {
						t.Fatalf("order %v node %s resource %s: %d > %d",
							order, node, resource, usage.Used[resource], limit)
					}
				}
			}
		}

		// Release in reverse admission order. Every prefix must remain
		// accounted, and the final state must be empty.
		sort.Sort(sort.Reverse(sort.StringSlice(admitted)))
		for _, id := range admitted {
			if _, err := calc.Release(id); err != nil {
				t.Fatalf("order %v release %s: %v", order, id, err)
			}
			if err := calc.Check(); err != nil {
				t.Fatalf("order %v release %s: %v", order, id, err)
			}
			verifySnapshot(t, calc.Snapshot(), topo)
		}
		for _, node := range calc.Nodes() {
			usage, _ := calc.NodeUsage(node)
			if !usage.Used.IsZero() || !usage.Allocated.IsZero() || !usage.Reserved.IsZero() {
				t.Fatalf("order %v node %s not empty: %+v", order, node, usage)
			}
		}
	}
}

type operation struct {
	kind string
	id   string
}

func TestExhaustiveOperationSequences(t *testing.T) {
	topo := topology{
		config: Config{Nodes: []Node{
			{ID: "root", Limit: Resources{"cpu": 4}},
			{ID: "a", Parent: "root", Limit: Resources{"cpu": 3}},
			{ID: "b", Parent: "root", Limit: Resources{"cpu": 3}},
		}},
		parents:  map[string]string{"root": "", "a": "root", "b": "root"},
		limits:   map[string]Resources{"root": {"cpu": 4}, "a": {"cpu": 3}, "b": {"cpu": 3}},
		children: map[string][]string{"root": {"a", "b"}},
	}
	ops := []operation{
		{kind: "reserve", id: "a"},
		{kind: "reserve", id: "b"},
		{kind: "commit", id: "a"},
		{kind: "commit", id: "b"},
		{kind: "release", id: "a"},
		{kind: "release", id: "b"},
	}
	const depth = 4
	indices := make([]int, depth)
	var run func(int)
	run = func(at int) {
		if at == depth {
			sequence := make([]operation, depth)
			for i, index := range indices {
				sequence[i] = ops[index]
			}
			calc, err := NewCalculator(topo.config)
			if err != nil {
				t.Fatalf("NewCalculator: %v", err)
			}
			for step, op := range sequence {
				var opErr error
				switch op.kind {
				case "reserve":
					_, opErr = calc.Reserve(Request{
						ID:        op.id,
						Node:      op.id,
						Resources: Resources{"cpu": 2},
					})
				case "commit":
					_, opErr = calc.Commit(op.id)
				case "release":
					_, opErr = calc.Release(op.id)
				}
				if opErr != nil && !isQuotaError(opErr) && !isHoldError(opErr) {
					t.Fatalf("sequence %v step %d: %v", describe(sequence), step, opErr)
				}
				if err := calc.Check(); err != nil {
					t.Fatalf("sequence %v step %d after %s(%s): %v",
						describe(sequence), step, op.kind, op.id, err)
				}
				verifySnapshot(t, calc.Snapshot(), topo)
			}
			for _, hold := range calc.Holds() {
				if _, err := calc.Release(hold.ID); err != nil {
					t.Fatalf("cleanup: %v", err)
				}
			}
			return
		}
		for i := range ops {
			indices[at] = i
			run(at + 1)
		}
	}
	run(0)
}

func describe(sequence []operation) string {
	parts := make([]string, len(sequence))
	for i, op := range sequence {
		parts[i] = fmt.Sprintf("%s(%s)", op.kind, op.id)
	}
	return fmt.Sprint(parts)
}

func isQuotaError(err error) bool {
	return err != nil && (containsError(err, ErrInsufficientQuota) ||
		containsError(err, ErrReclaimShortfall))
}

func isHoldError(err error) bool {
	return err != nil && (containsError(err, ErrUnknownHold) || containsError(err, ErrDuplicateID))
}

func containsError(err, target error) bool {
	return errors.Is(err, target)
}
