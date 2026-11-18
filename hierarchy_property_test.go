package formal

import (
	"math/rand"
	"testing"
)

func TestRandomHierarchyInvariants(t *testing.T) {
	rng := rand.New(rand.NewSource(20261119))
	for round := 0; round < 800; round++ {
		count := 1 + rng.Intn(8)
		nodes := make([]Node, count)
		parents := make(map[string]string, count)
		children := make(map[string][]string, count)
		limits := make(map[string]int64, count)
		nodes[0] = Node{ID: "n0"}
		if rng.Intn(4) != 0 {
			nodes[0].Limit = Resources{"cpu": int64(rng.Intn(15))}
		}
		if nodes[0].Limit != nil {
			limits["n0"] = nodes[0].Limit["cpu"]
		}
		for i := 1; i < count; i++ {
			id := "n" + string(rune('0'+i))
			parent := "n" + string(rune('0'+rng.Intn(i)))
			nodes[i] = Node{ID: id, Parent: parent}
			if rng.Intn(3) != 0 {
				nodes[i].Limit = Resources{"cpu": int64(rng.Intn(12))}
				limits[id] = nodes[i].Limit["cpu"]
			}
			parents[id] = parent
			children[parent] = append(children[parent], id)
		}
		parents["n0"] = ""

		calc, err := NewCalculator(Config{Nodes: nodes})
		if err != nil {
			t.Fatalf("round %d: NewCalculator: %v", round, err)
		}

		demands := make([]Demand, 0, count)
		demandByNode := make(map[string]int64, count)
		for i := 0; i < count; i++ {
			id := "n" + string(rune('0'+i))
			if rng.Intn(2) == 0 {
				continue
			}
			amount := int64(rng.Intn(10))
			demands = append(demands, Demand{Node: id, Resources: Resources{"cpu": amount}})
			demandByNode[id] = amount
		}
		got, err := calc.FairShareFresh(demands)
		if err != nil {
			t.Fatalf("round %d: FairShareFresh: %v", round, err)
		}

		subtreeDemand := make(map[string]int64, count)
		var accumulate func(string) int64
		accumulate = func(id string) int64 {
			total := demandByNode[id]
			for _, child := range children[id] {
				total += accumulate(child)
			}
			subtreeDemand[id] = total
			return total
		}
		accumulate("n0")

		for i := 0; i < count; i++ {
			id := "n" + string(rune('0'+i))
			grant := got[id]["cpu"]
			if grant < 0 {
				t.Fatalf("round %d: node %s negative grant %d", round, id, grant)
			}
			if grant > subtreeDemand[id] {
				t.Fatalf("round %d: node %s grant %d exceeds subtree demand %d",
					round, id, grant, subtreeDemand[id])
			}
			if limit, ok := limits[id]; ok && grant > limit {
				t.Fatalf("round %d: node %s grant %d exceeds limit %d", round, id, grant, limit)
			}
			childTotal := int64(0)
			for _, child := range children[id] {
				childTotal += got[child]["cpu"]
			}
			ownGrant := grant - childTotal
			if ownGrant < 0 {
				t.Fatalf("round %d: node %s children consume %d > parent grant %d",
					round, id, childTotal, grant)
			}
			if ownGrant > demandByNode[id] {
				t.Fatalf("round %d: node %s own grant %d exceeds demand %d",
					round, id, ownGrant, demandByNode[id])
			}
		}
	}
}

func TestFairShareNeverExceedsFreeCapacity(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for round := 0; round < 200; round++ {
		calc, err := NewCalculator(Config{Nodes: []Node{
			{ID: "root", Limit: Resources{"cpu": 12, "mem": 9}},
			{ID: "a", Parent: "root", Limit: Resources{"cpu": 8, "mem": 7}},
			{ID: "a1", Parent: "a"},
			{ID: "b", Parent: "root", Limit: Resources{"cpu": 6, "mem": 5}},
			{ID: "b1", Parent: "b"},
		}})
		if err != nil {
			t.Fatalf("NewCalculator: %v", err)
		}
		leaves := []string{"a1", "b1"}
		for i := 0; i < 4; i++ {
			id := "h" + string(rune('0'+i))
			_, _ = calc.TryReserve(Request{
				ID:   id,
				Node: leaves[rng.Intn(len(leaves))],
				Resources: Resources{
					"cpu": int64(rng.Intn(5)),
					"mem": int64(rng.Intn(4)),
				},
			})
		}
		demands := []Demand{
			{Node: "a1", Resources: Resources{"cpu": int64(rng.Intn(8)), "mem": int64(rng.Intn(8))}},
			{Node: "b1", Resources: Resources{"cpu": int64(rng.Intn(8)), "mem": int64(rng.Intn(8))}},
		}
		got, err := calc.FairShare(demands)
		if err != nil {
			t.Fatalf("FairShare: %v", err)
		}
		for _, node := range calc.Nodes() {
			usage, err := calc.NodeUsage(node)
			if err != nil {
				t.Fatalf("NodeUsage: %v", err)
			}
			for resource, grant := range got[node] {
				if limit, ok := calc.Limits()[node][resource]; ok {
					if usage.Used[resource]+grant > limit {
						t.Fatalf("round %d node %s resource %s: used %d + new %d > limit %d",
							round, node, resource, usage.Used[resource], grant, limit)
					}
				}
			}
		}
	}
}
