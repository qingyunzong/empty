package dataeng

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func mustNodes(t *testing.T, c *Catalog, nodes ...Node) {
	t.Helper()
	if err := c.AddNodes(nodes...); err != nil {
		t.Fatalf("AddNodes: %v", err)
	}
}

func mustEdges(t *testing.T, c *Catalog, edges ...Edge) {
	t.Helper()
	if err := c.AddEdges(edges...); err != nil {
		t.Fatalf("AddEdges: %v", err)
	}
}

func nodeIDs(nodes []Node) []NodeID {
	out := make([]NodeID, len(nodes))
	for i, n := range nodes {
		out[i] = n.ID
	}
	return out
}

func TestUpstreamDepthPathsAndTruncation(t *testing.T) {
	c := NewCatalog()
	mustNodes(t, c,
		Node{ID: "raw", Type: NodeTable},
		Node{ID: "clean", Type: NodeView},
		Node{ID: "report", Type: NodeView},
	)
	mustEdges(t, c,
		Edge{From: "raw", To: "clean", Type: EdgeDerivedFrom},
		Edge{From: "clean", To: "report", Type: EdgeDerivedFrom},
	)

	res, err := c.Upstream("report", 2)
	if err != nil {
		t.Fatalf("Upstream: %v", err)
	}
	if res.Version != c.Version() {
		t.Fatalf("version = %d, want %d", res.Version, c.Version())
	}
	wantNodes := []NodeID{"clean", "raw", "report"}
	if got := nodeIDs(res.Nodes); !equalIDs(got, wantNodes) {
		t.Fatalf("nodes = %v, want %v", got, wantNodes)
	}
	if len(res.Paths) != 3 {
		t.Fatalf("paths = %d, want 3: %#v", len(res.Paths), res.Paths)
	}
	if got := res.Paths[2].Nodes; !equalIDs(got, []NodeID{"report", "clean", "raw"}) {
		t.Fatalf("longest path = %v", got)
	}
	if res.Paths[2].Length != 2 {
		t.Fatalf("longest path length = %d, want 2", res.Paths[2].Length)
	}
	if res.Truncated || len(res.Cycles) != 0 {
		t.Fatalf("unexpected truncation/cycles: %#v", res)
	}

	shallow, err := c.Upstream("report", 1)
	if err != nil {
		t.Fatalf("Upstream shallow: %v", err)
	}
	if len(shallow.Paths) != 2 {
		t.Fatalf("shallow paths = %d, want 2", len(shallow.Paths))
	}
	if !shallow.Truncated || len(shallow.Frontier) != 1 || shallow.Frontier[0] != "clean" {
		t.Fatalf("shallow truncation = %v frontier=%v", shallow.Truncated, shallow.Frontier)
	}
}

func TestEdgeTypeFilterAndDownstream(t *testing.T) {
	c := NewCatalog()
	mustNodes(t, c,
		Node{ID: "start"},
		Node{ID: "read_source"},
		Node{ID: "write_source"},
		Node{ID: "read_consumer"},
		Node{ID: "write_consumer"},
	)
	mustEdges(t, c,
		Edge{From: "read_source", To: "start", Type: EdgeReads},
		Edge{From: "write_source", To: "start", Type: EdgeWrites},
		Edge{From: "start", To: "read_consumer", Type: EdgeReads},
		Edge{From: "start", To: "write_consumer", Type: EdgeWrites},
	)

	up, err := c.QueryUpstream("start", 1, EdgeReads)
	if err != nil {
		t.Fatalf("QueryUpstream: %v", err)
	}
	if got := nodeIDs(up.Nodes); !equalIDs(got, []NodeID{"read_source", "start"}) {
		t.Fatalf("filtered upstream nodes = %v", got)
	}

	down, err := c.QueryDownstream("start", 1, EdgeWrites)
	if err != nil {
		t.Fatalf("QueryDownstream: %v", err)
	}
	if got := nodeIDs(down.Nodes); !equalIDs(got, []NodeID{"start", "write_consumer"}) {
		t.Fatalf("filtered downstream nodes = %v", got)
	}
}

func TestSelfReferencingViewCycle(t *testing.T) {
	c := NewCatalog()
	mustNodes(t, c, Node{ID: "v", Type: NodeView})
	mustEdges(t, c, Edge{From: "v", To: "v", Type: EdgeReferences})

	res, err := c.Upstream("v", 1)
	if err != nil {
		t.Fatalf("Upstream: %v", err)
	}
	if len(res.Cycles) != 1 {
		t.Fatalf("cycles = %d, want 1: %#v", len(res.Cycles), res.Cycles)
	}
	cy := res.Cycles[0]
	if !equalIDs(cy.Nodes, []NodeID{"v", "v"}) {
		t.Fatalf("cycle nodes = %v", cy.Nodes)
	}
	if cy.Length != 1 || len(cy.Edges) != 1 || cy.EdgeTypes[0] != EdgeReferences {
		t.Fatalf("cycle = %#v", cy)
	}
}

func TestRecursiveCTECycle(t *testing.T) {
	c := NewCatalog()
	mustNodes(t, c,
		Node{ID: "cte", Type: NodeCTE},
		Node{ID: "base", Type: NodeTable},
	)
	mustEdges(t, c,
		Edge{From: "base", To: "cte", Type: EdgeFeeds},
		Edge{From: "cte", To: "cte", Type: EdgeRecursive},
	)

	res, err := c.Upstream("cte", 20)
	if err != nil {
		t.Fatalf("Upstream: %v", err)
	}
	if !res.HasCycles() || len(res.Cycles) != 1 {
		t.Fatalf("cycles = %#v", res.Cycles)
	}
	if got := nodeIDs(res.Nodes); !equalIDs(got, []NodeID{"base", "cte"}) {
		t.Fatalf("nodes = %v", got)
	}
	if !containsID(res.Cycles[0].Nodes, "cte") {
		t.Fatalf("cycle lacks cte: %#v", res.Cycles[0])
	}
}

func TestJobCycleAndNodeEdgeTypeState(t *testing.T) {
	c := NewCatalog()
	mustNodes(t, c,
		Node{ID: "job_a", Type: NodeJob},
		Node{ID: "job_b", Type: NodeJob},
		Node{ID: "job_c", Type: NodeJob},
	)
	mustEdges(t, c,
		Edge{From: "job_a", To: "job_b", Type: EdgeDependsOn},
		Edge{From: "job_b", To: "job_c", Type: EdgeDependsOn},
		Edge{From: "job_c", To: "job_a", Type: EdgeDependsOn},
	)

	res, err := c.Upstream("job_a", UnlimitedDepth)
	if err != nil {
		t.Fatalf("Upstream: %v", err)
	}
	if len(res.Cycles) != 1 {
		t.Fatalf("cycles = %d, want 1: %#v", len(res.Cycles), res.Cycles)
	}
	cy := res.Cycles[0]
	if cy.Length != 3 || len(cy.Edges) != 3 {
		t.Fatalf("cycle length = %d edges=%d", cy.Length, len(cy.Edges))
	}
	if !equalIDs(cy.Nodes, []NodeID{"job_a", "job_c", "job_b", "job_a"}) {
		t.Fatalf("cycle nodes = %v", cy.Nodes)
	}
	exact, err := c.Upstream("job_a", 3)
	if err != nil {
		t.Fatalf("Upstream exact depth: %v", err)
	}
	if len(exact.Cycles) != 1 {
		t.Fatalf("cycle within exact depth not retained: %#v", exact.Cycles)
	}

	// A different edge type is a different state; it must be explored before
	// the walker calls the state a cycle.
	d := NewCatalog()
	mustNodes(t, d, Node{ID: "a"}, Node{ID: "b"})
	mustEdges(t, d,
		Edge{From: "a", To: "b", Type: EdgeReads},
		Edge{From: "b", To: "a", Type: EdgeWrites},
	)
	typed, err := d.Upstream("a", UnlimitedDepth)
	if err != nil {
		t.Fatalf("Upstream typed: %v", err)
	}
	if len(typed.Cycles) != 1 {
		t.Fatalf("typed cycles = %#v", typed.Cycles)
	}
	if !equalIDs(typed.Cycles[0].Nodes, []NodeID{"a", "b", "a"}) {
		t.Fatalf("typed cycle starts at repeated state: %v", typed.Cycles[0].Nodes)
	}
	if got := typed.Cycles[0].EdgeTypes; len(got) != 2 || got[0] != EdgeWrites || got[1] != EdgeReads {
		t.Fatalf("typed cycle edge types = %v", got)
	}
}

func TestDownstreamCycleUsesSameStateRules(t *testing.T) {
	c := NewCatalog()
	mustNodes(t, c, Node{ID: "a"}, Node{ID: "b"})
	mustEdges(t, c,
		Edge{From: "a", To: "b", Type: EdgeFeeds},
		Edge{From: "b", To: "a", Type: EdgeFeeds},
	)
	res, err := c.Downstream("a", 2)
	if err != nil {
		t.Fatalf("Downstream: %v", err)
	}
	if len(res.Cycles) != 1 {
		t.Fatalf("cycles = %#v", res.Cycles)
	}
	if !equalIDs(res.Cycles[0].Nodes, []NodeID{"a", "b", "a"}) {
		t.Fatalf("cycle nodes = %v", res.Cycles[0].Nodes)
	}
}

func TestFirstCycleEvidenceDeduplicatedAcrossRotations(t *testing.T) {
	c := NewCatalog()
	mustNodes(t, c,
		Node{ID: "a"}, Node{ID: "b"}, Node{ID: "c"}, Node{ID: "d"}, Node{ID: "s"},
	)
	mustEdges(t, c,
		Edge{From: "a", To: "b", Type: EdgeFeeds},
		Edge{From: "b", To: "c", Type: EdgeFeeds},
		Edge{From: "c", To: "d", Type: EdgeFeeds},
		Edge{From: "d", To: "a", Type: EdgeFeeds},
		Edge{From: "a", To: "s", Type: EdgeFeeds},
		Edge{From: "b", To: "s", Type: EdgeFeeds},
	)

	res, err := c.Upstream("s", UnlimitedDepth)
	if err != nil {
		t.Fatalf("Upstream: %v", err)
	}
	if len(res.Cycles) != 1 {
		t.Fatalf("cycles = %d, want one canonical first evidence: %#v", len(res.Cycles), res.Cycles)
	}
	if res.Cycles[0].Length != 4 {
		t.Fatalf("cycle length = %d, want 4", res.Cycles[0].Length)
	}
}

func TestVersionSnapshotIsolation(t *testing.T) {
	c := NewCatalog()
	mustNodes(t, c, Node{ID: "a"}, Node{ID: "b"}, Node{ID: "c"})
	v1 := c.Version()
	if v1 != 1 {
		t.Fatalf("node version = %d, want 1", v1)
	}

	mustEdges(t, c, Edge{From: "a", To: "b", Type: EdgeFeeds})
	v2 := c.Version()
	if v2 != 2 {
		t.Fatalf("edge version = %d, want 2", v2)
	}

	old, err := c.SnapshotAt(v1)
	if err != nil {
		t.Fatalf("SnapshotAt: %v", err)
	}
	if old.EdgeCount() != 0 {
		t.Fatalf("old snapshot has %d edges", old.EdgeCount())
	}
	if c.Snapshot().EdgeCount() != 1 {
		t.Fatalf("current snapshot has %d edges", c.Snapshot().EdgeCount())
	}

	oldRes, err := c.QueryAt(context.Background(), v1, Query{Start: "b", Depth: 5, Direction: Upstream})
	if err != nil {
		t.Fatalf("QueryAt: %v", err)
	}
	if len(oldRes.Paths) != 1 {
		t.Fatalf("old query paths = %#v", oldRes.Paths)
	}

	// One batch is one version, even when it contains a no-op plus a change.
	mustEdges(t, c,
		Edge{From: "a", To: "b", Type: EdgeFeeds},
		Edge{From: "b", To: "c", Type: EdgeFeeds},
	)
	v3 := c.Version()
	if v3 != v2+1 {
		t.Fatalf("batch version = %d, want %d", v3, v2+1)
	}
	mustEdges(t, c, Edge{From: "a", To: "b", Type: EdgeFeeds})
	if c.Version() != v3 {
		t.Fatalf("no-op bumped version to %d", c.Version())
	}
}

func TestHistoryWindow(t *testing.T) {
	c := NewCatalog(WithoutVersionHistory())
	mustNodes(t, c, Node{ID: "a"})
	v1 := c.Version()
	mustEdges(t, c, Edge{From: "a", To: "a", Type: EdgeReferences})
	v2 := c.Version()
	if _, err := c.SnapshotAt(v1); !errors.Is(err, ErrVersionAbsent) {
		t.Fatalf("old snapshot error = %v", err)
	}
	if _, err := c.SnapshotAt(v2); err != nil {
		t.Fatalf("current snapshot unavailable: %v", err)
	}
	if got := c.Versions(); len(got) != 1 || got[0] != v2 {
		t.Fatalf("versions = %v", got)
	}
}

func TestAtomicBatchNeverExposesHalfUpdate(t *testing.T) {
	c := NewCatalog()
	mustNodes(t, c, Node{ID: "a"}, Node{ID: "b"}, Node{ID: "c"})
	edges := []Edge{
		{From: "a", To: "b", Type: EdgeFeeds},
		{From: "b", To: "c", Type: EdgeFeeds},
	}
	mustEdges(t, c, edges...)

	var wg sync.WaitGroup
	stop := make(chan struct{})
	errCh := make(chan error, 8)

	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				res, err := c.Upstream("c", 3)
				if err != nil {
					errCh <- err
					return
				}
				switch len(res.Paths) {
				case 1, 3:
					// 1: both edges absent; 3: both edges present.
				default:
					errCh <- errors.New("observed a partially applied edge batch")
					return
				}
			}
		}()
	}

	for i := 0; i < 300; i++ {
		if i%2 == 0 {
			if err := c.RemoveEdges(edges...); err != nil {
				t.Fatal(err)
			}
		} else {
			mustEdges(t, c, edges...)
		}
	}
	close(stop)
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
}

func TestJSONAliasesAndRoundTrip(t *testing.T) {
	const input = `{
		"version": 7,
		"nodes": [{"id":"t","kind":"table","label":"T"},{"id":"v","type":"view"}],
		"edges": [{"source":"t","target":"v","kind":"derived_from"}]
	}`
	c, err := ParseJSON([]byte(input))
	if err != nil {
		t.Fatalf("ParseJSON: %v", err)
	}
	if c.Version() != 7 {
		t.Fatalf("version = %d", c.Version())
	}
	n, ok := c.Node("t")
	if !ok || n.Type != NodeTable || n.Name != "T" {
		t.Fatalf("node = %#v, %v", n, ok)
	}
	res, err := c.Upstream("v", 1)
	if err != nil {
		t.Fatalf("Upstream: %v", err)
	}
	if got := nodeIDs(res.Nodes); !equalIDs(got, []NodeID{"t", "v"}) {
		t.Fatalf("nodes = %v", got)
	}

	data, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	text := string(data)
	if !strings.Contains(text, `"from":"t"`) || strings.Contains(text, `"source"`) {
		t.Fatalf("non-canonical JSON: %s", text)
	}
	c2, err := ParseJSON(data)
	if err != nil {
		t.Fatalf("round-trip ParseJSON: %v", err)
	}
	if c2.Version() != 7 || c2.Snapshot().EdgeCount() != 1 {
		t.Fatalf("round trip lost data: %#v", c2.Export())
	}
}

func TestDepthZeroMaxPathsAndErrors(t *testing.T) {
	c := NewCatalog()
	mustNodes(t, c, Node{ID: "a"}, Node{ID: "b"})
	mustEdges(t, c, Edge{From: "a", To: "b"})

	res, err := c.Upstream("b", 0)
	if err != nil {
		t.Fatalf("Upstream: %v", err)
	}
	if len(res.Paths) != 1 || res.Paths[0].Length != 0 || !res.Truncated {
		t.Fatalf("depth zero result = %#v", res)
	}

	res, err = c.Query(context.Background(), Query{Start: "b", Depth: 5, Direction: Upstream, MaxPaths: 1})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(res.Paths) != 1 || !res.Truncated {
		t.Fatalf("max paths result = %#v", res)
	}

	if _, err := c.Upstream("missing", 1); !errors.Is(err, ErrNodeNotFound) {
		t.Fatalf("missing node error = %v", err)
	}
}

func TestPlaceholderNodesAndRemoveNode(t *testing.T) {
	c := NewCatalog()
	mustEdges(t, c, Edge{From: "a", To: "b"})
	if !c.HasNode("a") || !c.HasNode("b") {
		t.Fatal("edge endpoints were not materialized")
	}
	if !c.RemoveNode("a") {
		t.Fatal("RemoveNode returned false")
	}
	if c.Snapshot().EdgeCount() != 0 {
		t.Fatalf("incident edges remain: %d", c.Snapshot().EdgeCount())
	}
	if c.RemoveNode("a") {
		t.Fatal("second RemoveNode returned true")
	}
}

func TestUnlimitedDepthTerminatesOnMixedTypeCycle(t *testing.T) {
	c := NewCatalog()
	mustNodes(t, c, Node{ID: "a"}, Node{ID: "b"})
	mustEdges(t, c,
		Edge{From: "a", To: "b", Type: EdgeReads},
		Edge{From: "b", To: "a", Type: EdgeWrites},
	)
	done := make(chan struct{})
	go func() {
		_, _ = c.Upstream("a", UnlimitedDepth)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("unlimited-depth traversal did not terminate")
	}
}

func equalIDs(a, b []NodeID) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func containsID(ids []NodeID, want NodeID) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}
