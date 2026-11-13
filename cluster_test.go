package dataeng

import (
	"errors"
	"math"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

func TestDescendingScoreAndPublicTieKey(t *testing.T) {
	g, err := New(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err := g.Cluster([]Candidate{
		{Left: "b", Right: "c", Score: 0.5},
		{Left: "a", Right: "d", Score: 0.5},
		{Left: "d", Right: "a", Score: 0.9},
		{Left: "x", Right: "y", Score: 0.5},
	})
	if err != nil {
		t.Fatal(err)
	}

	want := [][2]string{{"d", "a"}, {"a", "d"}, {"b", "c"}, {"x", "y"}}
	for i, d := range got.Decisions {
		if d.Candidate.Left != want[i][0] || d.Candidate.Right != want[i][1] {
			t.Fatalf("decision %d = %s-%s, want %s-%s",
				i, d.Candidate.Left, d.Candidate.Right, want[i][0], want[i][1])
		}
		if d.TieKey.Left > d.TieKey.Right {
			t.Fatalf("tie key %v is not canonical", d.TieKey)
		}
	}
}

func TestCannotLinkClosureThroughMustAndMerge(t *testing.T) {
	g, err := New(
		[]Pair{{"a", "b"}, {"c", "d"}},
		[]Pair{{"b", "c"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	got, err := g.Cluster([]Candidate{
		{Left: "a", Right: "d", Score: 0.99},
		{Left: "a", Right: "c", Score: 0.90},
		{Left: "a", Right: "b", Score: 0.80},
		{Left: "a", Right: "e", Score: 0.70},
		{Left: "e", Right: "c", Score: 0.60},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Rejected) != 3 {
		t.Fatalf("got %d rejections, want 3", len(got.Rejected))
	}

	if got.Decisions[0].Accepted {
		t.Fatal("a-d must be rejected")
	}
	if n := got.Decisions[0].Conflict.Length(); n != 3 {
		t.Fatalf("a-d conflict length = %d, want 3: %v", n, got.Decisions[0].Conflict)
	}
	if got.Decisions[1].Accepted {
		t.Fatal("a-c must be rejected")
	}
	if n := got.Decisions[1].Conflict.Length(); n != 2 {
		t.Fatalf("a-c conflict length = %d, want 2: %v", n, got.Decisions[1].Conflict)
	}
	if !got.Decisions[2].Accepted || !got.Decisions[2].AlreadyMerged {
		t.Fatal("a-b must be accepted as already merged")
	}
	if got.Decisions[4].Accepted {
		t.Fatal("e-c must be rejected after e joined a's component")
	}
	if n := got.Decisions[4].Conflict.Length(); n != 3 {
		t.Fatalf("e-c conflict length = %d, want 3: %v", n, got.Decisions[4].Conflict)
	}

	for i, r := range got.Rejected {
		if err := r.Path.Validate(); err != nil {
			t.Fatalf("rejection %d path invalid: %v", i, err)
		}
	}
}

func TestEnemySetPropagatesOnAcceptedMerge(t *testing.T) {
	g, err := New(nil, []Pair{{"a", "b"}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := g.Cluster([]Candidate{
		{Left: "a", Right: "c", Score: 0.9},
		{Left: "b", Right: "c", Score: 0.8},
		{Left: "b", Right: "d", Score: 0.7},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Decisions[0].Accepted {
		t.Fatal("a-c should be accepted")
	}
	if got.Decisions[1].Accepted {
		t.Fatal("b-c must be rejected because a-c merged a's enemy closure")
	}
	p := got.Decisions[1].Conflict
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if p.Length() != 2 {
		t.Fatalf("conflict length = %d, want 2: %v", p.Length(), p)
	}
	if !got.Decisions[2].Accepted {
		t.Fatal("b-d should be accepted")
	}
}

func TestMinimumConflictPathUsesMustCycleShortcut(t *testing.T) {
	g, err := New(
		[]Pair{{"a", "b"}, {"b", "c"}, {"a", "c"}},
		[]Pair{{"c", "d"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	got, err := g.Cluster([]Candidate{{Left: "a", Right: "d", Score: 0.5}})
	if err != nil {
		t.Fatal(err)
	}
	if got.Decisions[0].Accepted {
		t.Fatal("a-d must be rejected")
	}
	p := got.Decisions[0].Conflict
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if p.Length() != 2 {
		t.Fatalf("conflict length = %d, want 2: %v", p.Length(), p)
	}
	if p.Nodes[0] != "a" || p.Nodes[len(p.Nodes)-1] != "d" {
		t.Fatalf("path endpoints = %v, want a..d", p.Nodes)
	}
}

func TestConflictPathLexicographicTieBreak(t *testing.T) {
	g, err := New(
		[]Pair{{"a", "b"}, {"a", "c"}, {"b", "d"}, {"c", "d"}},
		[]Pair{{"d", "e"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	got, err := g.Cluster([]Candidate{{Left: "a", Right: "e", Score: 0.5}})
	if err != nil {
		t.Fatal(err)
	}
	p := got.Decisions[0].Conflict
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	want := []string{"a", "b", "d", "e"}
	if len(p.Nodes) != len(want) {
		t.Fatalf("path nodes = %v, want %v", p.Nodes, want)
	}
	for i := range want {
		if p.Nodes[i] != want[i] {
			t.Fatalf("path nodes = %v, want %v", p.Nodes, want)
		}
	}
}

func TestInconsistentHardConstraints(t *testing.T) {
	_, err := New(
		[]Pair{{"a", "b"}, {"b", "c"}},
		[]Pair{{"a", "c"}},
	)
	if !errors.Is(err, ErrInconsistent) {
		t.Fatalf("got %v, want ErrInconsistent", err)
	}
	var inc *InconsistentError
	if !errors.As(err, &inc) {
		t.Fatalf("error type %T does not expose InconsistentError", err)
	}
	if len(inc.MustPath) < 2 {
		t.Fatalf("must path = %v, want a path between a and c", inc.MustPath)
	}
}

func TestCannotLinkSelfIsInconsistent(t *testing.T) {
	_, err := New(nil, []Pair{{"a", "a"}})
	if !errors.Is(err, ErrInconsistent) {
		t.Fatalf("got %v, want ErrInconsistent", err)
	}
}

func TestNaNCandidateIsRejected(t *testing.T) {
	g, err := New(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Cluster([]Candidate{{Left: "a", Right: "b", Score: math.NaN()}})
	if err == nil {
		t.Fatal("NaN score must return an error")
	}
}

func TestClustersAreCanonical(t *testing.T) {
	g, err := New([]Pair{{"z", "a"}, {"b", "z"}}, []Pair{{"a", "b"}})
	if err == nil {
		t.Fatal("a,b,z must-link path should make the cannot-link inconsistent")
	}

	g, err = New([]Pair{{"z", "a"}, {"m", "b"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err := g.Cluster(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Clusters) != 2 {
		t.Fatalf("clusters = %v, want 2", got.Clusters)
	}
	if got.Clusters[0][0] != "a" || got.Clusters[1][0] != "b" {
		t.Fatalf("clusters are not sorted: %v", got.Clusters)
	}
	if got.Clusters[0][len(got.Clusters[0])-1] != "z" {
		t.Fatalf("members are not sorted: %v", got.Clusters[0])
	}
}

func TestGraphIsReusableAcrossRuns(t *testing.T) {
	g, err := New([]Pair{{"a", "b"}}, []Pair{{"b", "c"}})
	if err != nil {
		t.Fatal(err)
	}
	candidates := []Candidate{
		{Left: "a", Right: "c", Score: 0.9},
		{Left: "c", Right: "d", Score: 0.8},
	}
	first, err := g.Cluster(candidates)
	if err != nil {
		t.Fatal(err)
	}
	second, err := g.Cluster(candidates)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("repeated runs differ:\n%+v\n%+v", first, second)
	}
}

// TestGreedyMatchesPartitionOracle verifies each decision independently:
// accepting an edge must leave at least one hard-constraint-feasible partition
// that extends the clusters built so far and co-locates the edge endpoints;
// rejecting one must leave none.
func TestGreedyMatchesPartitionOracle(t *testing.T) {
	must := []Pair{{"a", "b"}, {"d", "e"}}
	cannot := []Pair{{"b", "c"}, {"a", "d"}, {"c", "e"}}
	g, err := New(must, cannot)
	if err != nil {
		t.Fatal(err)
	}
	g.Register("a", "b", "c", "d", "e", "f")
	partitions, err := g.EnumeratePartitions()
	if err != nil {
		t.Fatal(err)
	}

	candidates := []Candidate{
		{Left: "a", Right: "c", Score: 0.9},
		{Left: "b", Right: "d", Score: 0.8},
		{Left: "c", Right: "d", Score: 0.8},
		{Left: "c", Right: "f", Score: 0.7},
		{Left: "f", Right: "a", Score: 0.6},
		{Left: "e", Right: "f", Score: 0.5},
	}
	got, err := g.Cluster(candidates)
	if err != nil {
		t.Fatal(err)
	}
	checkAgainstOracle(t, g, partitions, got)
}

func TestRandomGreedyMatchesPartitionOracle(t *testing.T) {
	ids := []string{"a", "b", "c", "d", "e"}
	rng := rand.New(rand.NewSource(42))

	for round := 0; round < 120; round++ {
		var must, cannot []Pair
		for i := 0; i < len(ids); i++ {
			for j := i + 1; j < len(ids); j++ {
				switch rng.Intn(10) {
				case 0, 1:
					must = append(must, Pair{ids[i], ids[j]})
				case 2:
					cannot = append(cannot, Pair{ids[i], ids[j]})
				}
			}
		}
		g, err := New(must, cannot)
		if err != nil {
			continue
		}
		g.Register(ids...)
		partitions, err := g.EnumeratePartitions()
		if err != nil {
			t.Fatal(err)
		}

		var candidates []Candidate
		for i := 0; i < len(ids); i++ {
			for j := i + 1; j < len(ids); j++ {
				if rng.Intn(3) == 0 {
					score := float64(rng.Intn(4)) / 3
					candidates = append(candidates, Candidate{
						Left: ids[i], Right: ids[j], Score: score,
					})
				}
			}
		}
		got, err := g.Cluster(candidates)
		if err != nil {
			t.Fatal(err)
		}
		checkAgainstOracle(t, g, partitions, got)
	}
}

func TestConflictPathsAreMinimumLength(t *testing.T) {
	ids := []string{"a", "b", "c", "d", "e"}
	rng := rand.New(rand.NewSource(7))

	for round := 0; round < 300; round++ {
		var must, cannot []Pair
		for i := 0; i < len(ids); i++ {
			for j := i + 1; j < len(ids); j++ {
				switch rng.Intn(12) {
				case 0, 1:
					must = append(must, Pair{ids[i], ids[j]})
				case 2:
					cannot = append(cannot, Pair{ids[i], ids[j]})
				}
			}
		}

		g, err := New(must, cannot)
		if err != nil {
			continue
		}
		for _, id := range ids {
			g.register(id)
		}

		var candidates []Candidate
		for i := 0; i < len(ids); i++ {
			for j := i + 1; j < len(ids); j++ {
				if rng.Intn(2) == 0 {
					candidates = append(candidates, Candidate{
						Left: ids[i], Right: ids[j], Score: float64(rng.Intn(5)),
					})
				}
			}
		}
		got, err := g.Cluster(candidates)
		if err != nil {
			t.Fatal(err)
		}

		adj := newBruteAdjacency(g.MustLinks(), g.CannotLinks())
		for _, d := range got.Decisions {
			if d.Accepted {
				if !d.AlreadyMerged {
					adj.add(d.Candidate.Left, d.Candidate.Right, LinkMerge)
				}
				continue
			}
			want := bruteMinConflictLength(adj, d.Candidate.Left, d.Candidate.Right)
			if want < 0 {
				t.Fatalf("round %d: no conflict proof for %v", round, d.Candidate)
			}
			if d.Conflict.Length() != want {
				t.Fatalf("round %d: conflict for %v has length %d, want %d: %v",
					round, d.Candidate, d.Conflict.Length(), want, d.Conflict)
			}
		}
	}
}

type bruteAdjacency map[string]map[string]struct {
	must   bool
	cannot bool
}

func newBruteAdjacency(must, cannot []Pair) bruteAdjacency {
	adj := make(bruteAdjacency)
	for _, p := range must {
		adj.add(p.Left, p.Right, LinkMust)
	}
	for _, p := range cannot {
		adj.add(p.Left, p.Right, LinkCannot)
	}
	return adj
}

func (a bruteAdjacency) add(x, y string, kind LinkKind) {
	if a[x] == nil {
		a[x] = make(map[string]struct {
			must   bool
			cannot bool
		})
	}
	if a[y] == nil {
		a[y] = make(map[string]struct {
			must   bool
			cannot bool
		})
	}
	xy := a[x][y]
	yx := a[y][x]
	if kind == LinkCannot {
		xy.cannot, yx.cannot = true, true
	} else {
		xy.must, yx.must = true, true
	}
	a[x][y], a[y][x] = xy, yx
}

func bruteMinConflictLength(adj bruteAdjacency, from, to string) int {
	const infinity = int(^uint(0) >> 1)
	best := infinity
	visited := map[string]bool{from: true}

	var walk func(string, int, int)
	walk = func(cur string, length, cannot int) {
		if cannot > 1 || length >= best {
			return
		}
		if cur == to {
			if cannot == 1 {
				best = length
			}
			return
		}
		for next, kind := range adj[cur] {
			if visited[next] {
				continue
			}
			nextCannot := cannot
			if kind.cannot {
				nextCannot++
			}
			if nextCannot > 1 {
				continue
			}
			visited[next] = true
			walk(next, length+1, nextCannot)
			delete(visited, next)
		}
	}
	walk(from, 0, 0)
	if best == infinity {
		return -1
	}
	return best
}

func checkAgainstOracle(t *testing.T, g *Graph, partitions []Partition, result *Result) {
	t.Helper()
	// Start from the hard must-link components, not the final result.
	hard, err := g.Cluster(nil)
	if err != nil {
		t.Fatal(err)
	}
	base := hard.Clusters

	for i, d := range result.Decisions {
		possible := existsExtension(partitions, base, d.Candidate.Left, d.Candidate.Right)
		if d.Accepted {
			if !possible {
				t.Fatalf("decision %d accepted %v but no hard-feasible partition extends %v and co-locates endpoints",
					i, d.Candidate, base)
			}
			base = mergeBlocks(base, d.Candidate.Left, d.Candidate.Right)
			continue
		}
		if possible {
			t.Fatalf("decision %d rejected %v but an extension exists from %v",
				i, d.Candidate, base)
		}
		if err := d.Conflict.Validate(); err != nil {
			t.Fatalf("decision %d conflict invalid: %v", i, err)
		}
		if d.Conflict.Nodes[0] != d.Candidate.Left ||
			d.Conflict.Nodes[len(d.Conflict.Nodes)-1] != d.Candidate.Right {
			t.Fatalf("decision %d conflict endpoints = %v, want %s..%s",
				i, d.Conflict.Nodes, d.Candidate.Left, d.Candidate.Right)
		}
	}

	if got, want := Partition(result.Clusters).Canonical().String(), Partition(base).Canonical().String(); got != want {
		t.Fatalf("final clusters = %s, want %s", got, want)
	}
	if !satisfiesHard(Partition(result.Clusters), g.MustLinks(), g.CannotLinks()) {
		t.Fatalf("final clusters %v violate hard constraints", result.Clusters)
	}
	for i, d := range result.Decisions {
		inSameCluster := coLocates(Partition(result.Clusters), d.Candidate.Left, d.Candidate.Right)
		if d.Accepted != inSameCluster {
			t.Fatalf("decision %d %v accepted=%v but final co-located=%v",
				i, d.Candidate, d.Accepted, inSameCluster)
		}
	}
}

func existsExtension(partitions []Partition, base [][]string, a, b string) bool {
	for _, p := range partitions {
		if !extendsPartition(p, base) {
			continue
		}
		if coLocates(p, a, b) {
			return true
		}
	}
	return false
}

func extendsPartition(p Partition, base [][]string) bool {
	for _, block := range base {
		if len(block) == 0 {
			continue
		}
		first, ok := blockIndex(p, block[0])
		if !ok {
			return false
		}
		for _, id := range block[1:] {
			idx, ok := blockIndex(p, id)
			if !ok || idx != first {
				return false
			}
		}
	}
	return true
}

func coLocates(p Partition, a, b string) bool {
	if a == b {
		return true
	}
	ia, oka := blockIndex(p, a)
	ib, okb := blockIndex(p, b)
	return oka && okb && ia == ib
}

func blockIndex(p Partition, id string) (int, bool) {
	for i, block := range p {
		for _, member := range block {
			if member == id {
				return i, true
			}
		}
	}
	return 0, false
}

func mergeBlocks(base [][]string, a, b string) [][]string {
	out := make([][]string, 0, len(base))
	var merged []string
	for _, block := range base {
		containsA := contains(block, a)
		containsB := contains(block, b)
		switch {
		case containsA || containsB:
			merged = append(merged, block...)
		default:
			out = append(out, append([]string(nil), block...))
		}
	}
	if merged == nil {
		merged = []string{a, b}
	}
	merged = uniqueSorted(merged)
	out = append(out, merged)
	return canonicalBlocks(out)
}

func contains(block []string, id string) bool {
	for _, member := range block {
		if member == id {
			return true
		}
	}
	return false
}

func uniqueSorted(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, id := range in {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func canonicalBlocks(in [][]string) [][]string {
	out := make([][]string, 0, len(in))
	for _, block := range in {
		if len(block) == 0 {
			continue
		}
		out = append(out, uniqueSorted(block))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i][0] < out[j][0]
	})
	return out
}
