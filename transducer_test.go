package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"testing"
)

type kv struct {
	key   []byte
	value uint64
}

func cloneEntries(keys [][]byte, values []uint64) []kv {
	if len(keys) != len(values) {
		panic("mismatched test data")
	}
	out := make([]kv, len(keys))
	for i := range keys {
		out[i] = kv{key: append([]byte(nil), keys[i]...), value: values[i]}
	}
	return out
}

// The reference implementation deliberately uses a plain trie first, lifts
// each subtree minimum into the parent edge, and then merges complete state
// signatures. It shares no construction code with the online builder.
type refChild struct {
	output uint64
	node   *refNode
}

type refNode struct {
	final       bool
	value       uint64
	min         uint64
	finalOutput uint64
	children    map[byte]*refChild
}

type refEdge struct {
	b      byte
	output uint64
	target int
}

type refState struct {
	final       bool
	finalOutput uint64
	edges       []refEdge
}

type refGraph struct {
	initial uint64
	states  []refState
	root    int
}

func newRefNode() *refNode {
	return &refNode{children: make(map[byte]*refChild)}
}

func buildReference(entries []kv) *refGraph {
	root := newRefNode()
	for _, entry := range entries {
		n := root
		for _, by := range entry.key {
			child := n.children[by]
			if child == nil {
				child = &refChild{node: newRefNode()}
				n.children[by] = child
			}
			n = child.node
		}
		n.final = true
		n.value = entry.value
	}
	if len(entries) == 0 {
		return &refGraph{initial: 0, states: []refState{{}}, root: 0}
	}

	refMin(root)
	initial := root.min
	refLift(root)

	reg := make(map[string]int)
	var states []refState
	var canonicalize func(*refNode) int
	canonicalize = func(n *refNode) int {
		edges := make([]refEdge, 0, len(n.children))
		sortedBytes := make([]byte, 0, len(n.children))
		for by := range n.children {
			sortedBytes = append(sortedBytes, by)
		}
		sort.Slice(sortedBytes, func(i, j int) bool { return sortedBytes[i] < sortedBytes[j] })
		for _, by := range sortedBytes {
			child := n.children[by]
			edges = append(edges, refEdge{
				b:      by,
				output: child.output,
				target: canonicalize(child.node),
			})
		}
		sig := refSignature(n.final, n.finalOutput, edges)
		if id, ok := reg[sig]; ok {
			return id
		}
		id := len(states)
		states = append(states, refState{
			final:       n.final,
			finalOutput: n.finalOutput,
			edges:       edges,
		})
		reg[sig] = id
		return id
	}
	rootID := canonicalize(root)
	return &refGraph{initial: initial, states: states, root: rootID}
}

func refMin(n *refNode) uint64 {
	m := uint64(math.MaxUint64)
	has := false
	if n.final {
		m = n.value
		has = true
	}
	for _, child := range n.children {
		if cm := refMin(child.node); !has || cm < m {
			m = cm
			has = true
		}
	}
	if !has {
		m = 0
	}
	n.min = m
	return m
}

func refLift(n *refNode) {
	if n.final {
		n.finalOutput = n.value - n.min
	}
	for _, child := range n.children {
		child.output = child.node.min - n.min
		refLift(child.node)
	}
}

func refSignature(final bool, finalOutput uint64, edges []refEdge) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%t|%d|", final, finalOutput)
	for _, edge := range edges {
		fmt.Fprintf(&b, "%d,%d,%d;", edge.b, edge.output, edge.target)
	}
	return b.String()
}

func refEdgeCount(g *refGraph) int {
	n := 0
	for _, state := range g.states {
		n += len(state.edges)
	}
	return n
}

func rankReference(entries []kv, query []byte) uint64 {
	i := sort.Search(len(entries), func(i int) bool {
		return bytes.Compare(entries[i].key, query) >= 0
	})
	return uint64(i)
}

func collectProbes(entries []kv) [][]byte {
	probes := [][]byte{
		nil,
		{},
		{0},
		{255},
		{0, 0},
		{255, 255},
		{128},
	}
	for _, entry := range entries {
		probes = append(probes, entry.key)
		if len(entry.key) > 0 {
			prefix := append([]byte(nil), entry.key[:len(entry.key)-1]...)
			probes = append(probes, prefix)
			changed := append([]byte(nil), entry.key...)
			changed[len(changed)-1] = changed[len(changed)-1] + 1
			probes = append(probes, changed)
			changed2 := append([]byte(nil), entry.key...)
			changed2[len(changed2)-1] = changed2[len(changed2)-1] - 1
			probes = append(probes, changed2)
		}
		probes = append(probes, append(append([]byte(nil), entry.key...), 0))
		probes = append(probes, append(append([]byte(nil), entry.key...), 255))
	}
	return probes
}

func checkAgainstReference(t *testing.T, entries []kv) {
	t.Helper()
	ref := buildReference(entries)

	b := NewBuilder()
	for _, entry := range entries {
		if err := b.Add(entry.key, entry.value); err != nil {
			t.Fatalf("Add(%q, %d): %v", entry.key, entry.value, err)
		}
		stats := b.Stats()
		if stats.MutableStates != len(entry.key)+1 {
			t.Fatalf("after Add(%q): mutable states = %d, want %d", entry.key, stats.MutableStates, len(entry.key)+1)
		}
		if stats.MutableStates > len(entry.key)+1 {
			t.Fatalf("after Add(%q): mutable states exceed last key length + 1", entry.key)
		}
		if stats.RetainedKeys != 1 {
			t.Fatalf("after Add(%q): retained complete keys = %d, want 1", entry.key, stats.RetainedKeys)
		}
		if len(entries) > 0 && stats.RegisteredStates < 0 {
			t.Fatalf("after Add(%q): negative registered state count", entry.key)
		}
	}

	g, err := b.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	g2, err := b.Finish()
	if err != nil {
		t.Fatalf("second Finish: %v", err)
	}
	if g2 != g {
		t.Fatalf("Finish is not idempotent")
	}
	if err := b.Add([]byte{0}, 1); !errors.Is(err, ErrFrozen) {
		t.Fatalf("Add after Finish error = %v, want ErrFrozen", err)
	}

	if g.InitialOutput() != ref.initial {
		t.Fatalf("initial output = %d, want %d", g.InitialOutput(), ref.initial)
	}
	if g.StateCount() != len(ref.states) {
		t.Fatalf("state count = %d, reference = %d", g.StateCount(), len(ref.states))
	}
	if g.EdgeCount() != refEdgeCount(ref) {
		t.Fatalf("edge count = %d, reference = %d", g.EdgeCount(), refEdgeCount(ref))
	}
	checkNormalizedGraph(t, g, len(entries) == 0)

	for _, entry := range entries {
		got, ok, err := g.Lookup(entry.key)
		if err != nil {
			t.Fatalf("Lookup(%q): %v", entry.key, err)
		}
		if !ok || got != entry.value {
			t.Fatalf("Lookup(%q) = (%d, %t), want (%d, true)", entry.key, got, ok, entry.value)
		}
	}

	for i, entry := range entries {
		key, got, ok, err := g.Select(uint64(i))
		if err != nil {
			t.Fatalf("Select(%d): %v", i, err)
		}
		if !ok {
			t.Fatalf("Select(%d) not found", i)
		}
		if !bytes.Equal(key, entry.key) || got != entry.value {
			t.Fatalf("Select(%d) = (%q, %d), want (%q, %d)", i, key, got, entry.key, entry.value)
		}
	}
	if _, _, ok, err := g.Select(uint64(len(entries))); err != nil || ok {
		t.Fatalf("Select out of range = (found=%t, err=%v)", ok, err)
	}

	for _, probe := range collectProbes(entries) {
		wantRank := rankReference(entries, probe)
		gotRank, err := g.Rank(probe)
		if err != nil {
			t.Fatalf("Rank(%q): %v", probe, err)
		}
		if gotRank != wantRank {
			t.Fatalf("Rank(%q) = %d, want %d", probe, gotRank, wantRank)
		}

		_, found, err := g.Lookup(probe)
		if err != nil {
			t.Fatalf("Lookup probe %q: %v", probe, err)
		}
		if found != rankReferenceContains(entries, probe) {
			t.Fatalf("Lookup probe %q found=%t", probe, found)
		}
	}
}

func rankReferenceContains(entries []kv, query []byte) bool {
	i := sort.Search(len(entries), func(i int) bool {
		return bytes.Compare(entries[i].key, query) >= 0
	})
	return i < len(entries) && bytes.Equal(entries[i].key, query)
}

func checkNormalizedGraph(t *testing.T, g *Graph, emptyDictionary bool) {
	t.Helper()
	reachable := make([]bool, len(g.nodes))
	stack := []int{g.root}
	reachable[g.root] = true
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, edge := range g.nodes[id].edges {
			if !reachable[edge.target] {
				reachable[edge.target] = true
				stack = append(stack, edge.target)
			}
		}
	}
	for id, ok := range reachable {
		if !ok {
			t.Fatalf("state %d is stored in the graph but unreachable from the root", id)
		}
	}

	for id, state := range g.nodes {
		if len(state.edges) == 0 && state.final {
			continue
		}
		last := byte(0)
		for i, edge := range state.edges {
			if i > 0 && edge.b <= last {
				t.Fatalf("state %d has non-strict byte order or duplicate edges", id)
			}
			last = edge.b
		}
	}

	memo := make(map[int]uint64)
	visiting := make(map[int]bool)
	var residualMin func(int) uint64
	residualMin = func(id int) uint64 {
		if v, ok := memo[id]; ok {
			return v
		}
		if visiting[id] {
			t.Fatalf("cycle detected at state %d", id)
		}
		visiting[id] = true
		state := g.nodes[id]
		m := uint64(math.MaxUint64)
		has := false
		if state.final {
			m = state.finalOutput
			has = true
		}
		for _, edge := range state.edges {
			childMin := residualMin(edge.target)
			sum, err := checkedAdd(edge.output, childMin)
			if err != nil {
				t.Fatalf("state %d edge output overflows", id)
			}
			if !has || sum < m {
				m = sum
				has = true
			}
		}
		if !has {
			m = 0
		}
		visiting[id] = false
		memo[id] = m
		return m
	}

	if emptyDictionary {
		if g.initialOutput != 0 || len(g.nodes) != 1 || g.nodes[0].final || len(g.nodes[0].edges) != 0 {
			t.Fatalf("empty dictionary is not the required single non-final root")
		}
		return
	}
	for id := range g.nodes {
		if got := residualMin(id); got != 0 {
			t.Fatalf("state %d residual minimum = %d, want 0", id, got)
		}
		if id != g.root && g.nodes[id].count == 0 {
			t.Fatalf("non-root state %d has no accepting suffix", id)
		}
	}

	// Distinct non-root states must not have identical complete signatures.
	seen := make(map[string]int)
	for id := 1; id < len(g.nodes); id++ {
		state := g.nodes[id]
		edges := make([]canonicalEdge, len(state.edges))
		for i, edge := range state.edges {
			edges[i] = canonicalEdge{b: edge.b, output: edge.output, target: edge.target - 1}
		}
		sig := stateSignature(state.final, state.finalOutput, edges)
		if other, ok := seen[sig]; ok {
			t.Fatalf("states %d and %d have identical signatures but were not merged", other, id)
		}
		seen[sig] = id
	}
}

func TestReferenceSharedSubgraphAndOutputPush(t *testing.T) {
	tests := []struct {
		name    string
		entries []kv
	}{
		{
			name: "later decrease pushes output to the old branch",
			entries: cloneEntries(
				[][]byte{[]byte("ab"), []byte("ac")},
				[]uint64{10, 5},
			),
		},
		{
			name: "two prefixes reach one residual subgraph",
			entries: cloneEntries(
				[][]byte{[]byte("ab"), []byte("ac"), []byte("zb"), []byte("zc")},
				[]uint64{7, 9, 9, 11},
			),
		},
		{
			name: "prefix itself is a key and minima decrease",
			entries: cloneEntries(
				[][]byte{[]byte("ab"), []byte("abc"), []byte("abd")},
				[]uint64{10, 5, 7},
			),
		},
		{
			name: "prefix value is below all extensions",
			entries: cloneEntries(
				[][]byte{[]byte("a"), []byte("ab"), []byte("ac")},
				[]uint64{2, 10, 9},
			),
		},
		{
			name: "nested shared suffixes",
			entries: cloneEntries(
				[][]byte{
					[]byte("aa"), []byte("ab"), []byte("ba"), []byte("bb"),
					[]byte("ca"), []byte("cb"),
				},
				[]uint64{5, 7, 6, 8, 300, 302},
			),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			checkAgainstReference(t, test.entries)
		})
	}
}

func TestBytesZeroAndMax(t *testing.T) {
	entries := cloneEntries(
		[][]byte{
			{0},
			{0, 0},
			{0, 255},
			{255},
			{255, 0},
			{255, 255},
		},
		[]uint64{100, 0, 200, math.MaxUint64, 1, 50},
	)
	checkAgainstReference(t, entries)
}

func TestDifferentPrefixesShareOneResidualSubgraph(t *testing.T) {
	entries := cloneEntries(
		[][]byte{[]byte("ab"), []byte("ac"), []byte("zb"), []byte("zc")},
		[]uint64{7, 9, 9, 11},
	)
	checkAgainstReference(t, entries)

	b := NewBuilder()
	for _, entry := range entries {
		if err := b.Add(entry.key, entry.value); err != nil {
			t.Fatal(err)
		}
	}
	g, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}

	root := g.nodes[g.root]
	if len(root.edges) != 2 {
		t.Fatalf("root has %d edges, want 2", len(root.edges))
	}
	if root.edges[0].target != root.edges[1].target {
		t.Fatalf("prefix a and z do not share their residual subgraph")
	}
	shared := g.nodes[root.edges[1].target]
	if len(shared.edges) != 2 {
		t.Fatalf("shared suffix state has %d edges, want 2", len(shared.edges))
	}
	if shared.edges[0].target != shared.edges[1].target {
		t.Fatalf("shared suffix leaves were not merged")
	}
	if root.edges[0].output == root.edges[1].output {
		t.Fatalf("test does not exercise different incoming outputs for the shared state")
	}
}

func TestValueDecreasePushesOutputToTheOldBranch(t *testing.T) {
	b := NewBuilder()
	if err := b.Add([]byte("ab"), 10); err != nil {
		t.Fatal(err)
	}
	if err := b.Add([]byte("ac"), 5); err != nil {
		t.Fatal(err)
	}
	g, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}

	root := g.nodes[g.root]
	if len(root.edges) != 1 {
		t.Fatalf("root edge count = %d", len(root.edges))
	}
	aState := g.nodes[root.edges[0].target]
	if len(aState.edges) != 2 {
		t.Fatalf("a state edge count = %d", len(aState.edges))
	}
	if aState.edges[0].b != 'b' || aState.edges[1].b != 'c' {
		t.Fatalf("a state edges are not in byte order")
	}
	if aState.edges[0].output != 5 || aState.edges[1].output != 0 {
		t.Fatalf("decrease did not push 5 onto the old b branch: %d, %d",
			aState.edges[0].output, aState.edges[1].output)
	}
	if aState.edges[0].target != aState.edges[1].target {
		t.Fatalf("terminal leaf was modified or not merged into the shared canonical target")
	}
	if value, ok, err := g.Lookup([]byte("ab")); err != nil || !ok || value != 10 {
		t.Fatalf("Lookup(ab) = (%d, %t, %v)", value, ok, err)
	}
}

func TestLookupRejectsNonFinalPrefixState(t *testing.T) {
	b := NewBuilder()
	for _, entry := range cloneEntries(
		[][]byte{[]byte("abc"), []byte("abd"), []byte("z")},
		[]uint64{5, 7, 9},
	) {
		if err := b.Add(entry.key, entry.value); err != nil {
			t.Fatal(err)
		}
	}
	g, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}

	for _, prefix := range [][]byte{[]byte("a"), []byte("ab")} {
		if _, ok, err := g.Lookup(prefix); err != nil || ok {
			t.Fatalf("Lookup(%q) reached a non-final state but reported success", prefix)
		}
	}
	if value, ok, err := g.Lookup([]byte("abc")); err != nil || !ok || value != 5 {
		t.Fatalf("Lookup(abc) = (%d, %t, %v)", value, ok, err)
	}
	if rank, err := g.Rank([]byte("ab")); err != nil || rank != 0 {
		t.Fatalf("Rank(ab) = (%d, %v), want 0", rank, err)
	}
	if rank, err := g.Rank([]byte("abd")); err != nil || rank != 1 {
		t.Fatalf("Rank(abd) = (%d, %v), want 1", rank, err)
	}
}

func TestFullUint64Endpoints(t *testing.T) {
	t.Run("mixed endpoints", func(t *testing.T) {
		entries := cloneEntries(
			[][]byte{[]byte("a"), []byte("ab"), []byte("b")},
			[]uint64{math.MaxUint64, 0, math.MaxUint64 - 1},
		)
		checkAgainstReference(t, entries)
	})
	t.Run("single maximum", func(t *testing.T) {
		entries := cloneEntries([][]byte{[]byte("x")}, []uint64{math.MaxUint64})
		checkAgainstReference(t, entries)
	})
	t.Run("decrease from maximum to zero", func(t *testing.T) {
		entries := cloneEntries(
			[][]byte{[]byte("a"), []byte("ab")},
			[]uint64{math.MaxUint64, 0},
		)
		checkAgainstReference(t, entries)
	})
	t.Run("edge output at maximum", func(t *testing.T) {
		entries := cloneEntries(
			[][]byte{[]byte("z"), []byte("zz")},
			[]uint64{0, math.MaxUint64},
		)
		checkAgainstReference(t, entries)
	})
}

func TestEmptyDictionaryAndEmptyKey(t *testing.T) {
	t.Run("empty dictionary", func(t *testing.T) {
		b := NewBuilder()
		g, err := b.Finish()
		if err != nil {
			t.Fatalf("Finish: %v", err)
		}
		checkNormalizedGraph(t, g, true)
		if _, ok, err := g.Lookup(nil); err != nil || ok {
			t.Fatalf("Lookup(empty) = (%t, %v)", ok, err)
		}
		if r, err := g.Rank([]byte("a")); err != nil || r != 0 {
			t.Fatalf("Rank(a) = (%d, %v)", r, err)
		}
		if _, _, ok, err := g.Select(0); err != nil || ok {
			t.Fatalf("Select(0) = (%t, %v)", ok, err)
		}
	})

	t.Run("empty key first", func(t *testing.T) {
		entries := cloneEntries(
			[][]byte{{}, []byte("a"), []byte("ab")},
			[]uint64{10, 5, 20},
		)
		checkAgainstReference(t, entries)
	})

	t.Run("empty key after another key is rejected without effect", func(t *testing.T) {
		b := NewBuilder()
		if err := b.Add([]byte("a"), 1); err != nil {
			t.Fatal(err)
		}
		before := b.Stats()
		if err := b.Add(nil, 2); !errors.Is(err, ErrEmptyKeyNotFirst) {
			t.Fatalf("empty Add error = %v", err)
		}
		if b.Stats() != before {
			t.Fatalf("failed empty Add changed stats: %+v -> %+v", before, b.Stats())
		}
	})
}

func TestIllegalAddsLeaveNoEffectAndBuildingContinues(t *testing.T) {
	b := NewBuilder()
	if err := b.Add([]byte("b"), 7); err != nil {
		t.Fatal(err)
	}
	before := b.Stats()

	if err := b.Add([]byte("b"), 9); !errors.Is(err, ErrDuplicateKey) {
		t.Fatalf("duplicate error = %v, want ErrDuplicateKey", err)
	}
	if b.Stats() != before {
		t.Fatalf("duplicate Add changed stats")
	}
	if err := b.Add([]byte("a"), 3); !errors.Is(err, ErrKeyOrder) {
		t.Fatalf("order error = %v, want ErrKeyOrder", err)
	}
	if b.Stats() != before {
		t.Fatalf("order Add changed stats")
	}
	if err := b.Add(nil, 1); !errors.Is(err, ErrEmptyKeyNotFirst) {
		t.Fatalf("late empty error = %v", err)
	}
	if b.Stats() != before {
		t.Fatalf("late empty Add changed stats")
	}

	if err := b.Add([]byte("ba"), 4); err != nil {
		t.Fatalf("valid Add after errors: %v", err)
	}
	if err := b.Add([]byte{255, 0}, math.MaxUint64); err != nil {
		t.Fatalf("high-byte Add: %v", err)
	}
	entries := cloneEntries(
		[][]byte{[]byte("b"), []byte("ba"), {255, 0}},
		[]uint64{7, 4, math.MaxUint64},
	)
	checkAgainstReference(t, entries)

	// Rebuild with exactly the valid sequence and compare the frozen graphs,
	// proving the failed calls left no hidden state behind.
	b2 := NewBuilder()
	for _, entry := range entries {
		if err := b2.Add(entry.key, entry.value); err != nil {
			t.Fatal(err)
		}
	}
	g1, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}
	g2, err := b2.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if g1.StateCount() != g2.StateCount() || g1.EdgeCount() != g2.EdgeCount() || g1.InitialOutput() != g2.InitialOutput() {
		t.Fatalf("failed Adds changed the final graph shape")
	}
}

func TestRejectsNonIncreasingSequenceWithoutEffect(t *testing.T) {
	b := NewBuilder()
	if err := b.Add([]byte{0x10}, 1); err != nil {
		t.Fatal(err)
	}
	// This key is larger only if bytes were compared as signed values.
	if err := b.Add([]byte{0x80}, 2); err != nil {
		t.Fatalf("0x80 must sort after 0x10: %v", err)
	}
	if b.Stats().MutableStates != 2 {
		t.Fatalf("unexpected stats after unsigned-byte order: %+v", b.Stats())
	}
	beforeFailure := b.Stats()
	if err := b.Add([]byte{0x7f}, 3); !errors.Is(err, ErrKeyOrder) {
		t.Fatalf("0x7f order error = %v", err)
	}
	if b.Stats() != beforeFailure {
		t.Fatalf("failed Add changed stats: %+v -> %+v", beforeFailure, b.Stats())
	}
}

func TestExhaustiveValueAssignmentsAgainstReference(t *testing.T) {
	keysets := [][][]byte{
		{[]byte("a"), []byte("ab"), []byte("ac"), []byte("b")},
		{[]byte("ab"), []byte("ac"), []byte("zb"), []byte("zc")},
		{{0}, {0, 255}, {255}},
	}
	values := []uint64{0, 1, 7, math.MaxUint64}

	for _, keys := range keysets {
		total := 1
		for range keys {
			total *= len(values)
		}
		for combo := 0; combo < total; combo++ {
			entryValues := make([]uint64, len(keys))
			n := combo
			for i := range entryValues {
				entryValues[i] = values[n%len(values)]
				n /= len(values)
			}
			checkAgainstReference(t, cloneEntries(keys, entryValues))
		}
	}
}

func TestExhaustiveSmallKeyUniverseAgainstReference(t *testing.T) {
	universe := [][]byte{
		{0}, {1}, {255},
		{0, 0}, {0, 1}, {0, 255},
		{1, 0}, {1, 1}, {1, 255},
		{255, 0}, {255, 1}, {255, 255},
	}
	sort.Slice(universe, func(i, j int) bool {
		return bytes.Compare(universe[i], universe[j]) < 0
	})
	valuePattern := []uint64{0, math.MaxUint64, 1, 7, 3}

	for mask := 1; mask < 1<<len(universe); mask++ {
		entries := make([]kv, 0, len(universe))
		for i, key := range universe {
			if mask&(1<<i) == 0 {
				continue
			}
			entries = append(entries, kv{
				key:   append([]byte(nil), key...),
				value: valuePattern[(i+mask)%len(valuePattern)],
			})
		}
		checkAgainstReference(t, entries)
	}
}
