package formal

import (
	"fmt"
	"sort"
	"testing"
)

// naiveSplit is a deliberately simple linear reference for one node: floor
// proportional shares followed by one largest-remainder pass.
func naiveSplit(budget int64, names []string, demand map[string]int64) map[string]int64 {
	shares := make(map[string]int64, len(names))
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)

	var total int64
	for _, name := range sorted {
		total += demand[name]
	}
	if total == 0 || budget <= 0 {
		return shares
	}
	if total <= budget {
		for _, name := range sorted {
			shares[name] = demand[name]
		}
		return shares
	}

	type remainder struct {
		name  string
		value int64
	}
	remainders := make([]remainder, 0, len(sorted))
	var allocated int64
	for _, name := range sorted {
		share := budget * demand[name] / total
		shares[name] = share
		allocated += share
		remainders = append(remainders, remainder{name: name, value: (budget * demand[name]) % total})
	}
	sort.SliceStable(remainders, func(i, j int) bool {
		if remainders[i].value != remainders[j].value {
			return remainders[i].value > remainders[j].value
		}
		return remainders[i].name < remainders[j].name
	})
	for i := 0; allocated < budget; i++ {
		shares[remainders[i%len(remainders)].name]++
		allocated++
	}
	return shares
}

// naiveTreeShares is an independent top-down reference that assumes only the
// root is capacity-constrained. It returns subtree totals at every node.
func naiveTreeShares(root string, rootLimit int64, demand map[string]int64, children map[string][]string) map[string]int64 {
	totalDemand := make(map[string]int64)
	var accumulate func(string) int64
	accumulate = func(node string) int64 {
		total := demand[node]
		for _, child := range children[node] {
			total += accumulate(child)
		}
		totalDemand[node] = total
		return total
	}
	accumulate(root)

	result := make(map[string]int64)
	var distribute func(string, int64)
	distribute = func(node string, budget int64) {
		kids := children[node]
		if len(kids) == 0 {
			result[node] = budget
			return
		}
		if totalDemand[node] < budget {
			budget = totalDemand[node]
		}
		shares := naiveSplit(budget, kids, totalDemand)
		var subtreeTotal int64
		for _, child := range kids {
			distribute(child, shares[child])
			subtreeTotal += result[child]
		}
		result[node] = subtreeTotal
	}
	budget := rootLimit
	if totalDemand[root] < budget {
		budget = totalDemand[root]
	}
	distribute(root, budget)
	return result
}

func TestFairShareMatchesNaiveLinearReference(t *testing.T) {
	calc, err := NewCalculator(Config{Nodes: []Node{
		{ID: "root", Limit: Resources{"cpu": 7}},
		{ID: "a", Parent: "root"},
		{ID: "a1", Parent: "a"},
		{ID: "a2", Parent: "a"},
		{ID: "b", Parent: "root"},
		{ID: "b1", Parent: "b"},
	}})
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}
	children := map[string][]string{
		"root": {"a", "b"},
		"a":    {"a1", "a2"},
		"b":    {"b1"},
	}
	leaves := []string{"a1", "a2", "b1"}

	for first := int64(0); first <= 4; first++ {
		for second := int64(0); second <= 4; second++ {
			for third := int64(0); third <= 4; third++ {
				demand := map[string]int64{
					"a1": first,
					"a2": second,
					"b1": third,
				}
				demands := make([]Demand, 0, len(leaves))
				for _, leaf := range leaves {
					demands = append(demands, Demand{
						Node:      leaf,
						Resources: Resources{"cpu": demand[leaf]},
					})
				}
				got, err := calc.FairShareFresh(demands)
				if err != nil {
					t.Fatalf("FairShareFresh(%v): %v", demand, err)
				}
				want := naiveTreeShares("root", 7, demand, children)
				for node, amount := range want {
					if got[node]["cpu"] != amount {
						t.Fatalf("demand %v: node %s grant %d, naive %d (all: got=%v want=%v)",
							demand, node, got[node]["cpu"], amount, flattened(got, "cpu"), want)
					}
				}
			}
		}
	}
}

func flattened(shares map[string]Resources, resource Resource) map[string]int64 {
	out := make(map[string]int64, len(shares))
	for node, vector := range shares {
		out[node] = vector[resource]
	}
	return out
}

func TestNaiveReferenceFeasibilityProperties(t *testing.T) {
	// This guards the reference itself and gives failures more context when
	// extending the exhaustive test above.
	for first := int64(0); first <= 3; first++ {
		for second := int64(0); second <= 3; second++ {
			for third := int64(0); third <= 3; third++ {
				demand := map[string]int64{"a1": first, "a2": second, "b1": third}
				children := map[string][]string{
					"root": {"a", "b"},
					"a":    {"a1", "a2"},
					"b":    {"b1"},
				}
				shares := naiveTreeShares("root", 7, demand, children)
				if shares["root"] > 7 {
					t.Fatalf("%v: root grant %d exceeds limit", demand, shares["root"])
				}
				for leaf, amount := range demand {
					if shares[leaf] > amount {
						t.Fatalf("%v: leaf %s grant %d exceeds demand", demand, leaf, shares[leaf])
					}
				}
				if shares["a"] != shares["a1"]+shares["a2"] {
					t.Fatalf("%v: namespace total mismatch: %s", demand, fmt.Sprint(shares))
				}
			}
		}
	}
}
