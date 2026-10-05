package statlabels

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

// 构建测试树:
//
//	root
//	├── a
//	│   ├── a1
//	│   └── a2
//	└── b
//	    └── b1
func buildTree(t *testing.T) *Tree {
	t.Helper()
	tr := NewTree()
	for _, e := range [][2]string{
		{"root", "a"}, {"root", "b"},
		{"a", "a1"}, {"a", "a2"}, {"b", "b1"},
	} {
		if err := tr.AddEdge(e[0], e[1]); err != nil {
			t.Fatalf("AddEdge(%q, %q): %v", e[0], e[1], err)
		}
	}
	return tr
}

func TestAncestorCountsEventOnce(t *testing.T) {
	tr := buildTree(t)
	s := NewStats(tr)
	// e1 命中 a 子树的两个标签，汇总到 a 和 root 时只能计一次。
	mustEvent(t, s, "e1", "a1", "a2")
	mustEvent(t, s, "e2", "a1")
	mustEvent(t, s, "e3", "b1")
	mustEvent(t, s, "e4", "a1", "b1") // 跨子树

	if got := s.Count("a"); got != 3 { // e1, e2, e4（e1 命中两个标签仍只计一次）
		t.Errorf("Count(a) = %d, want 3", got)
	}
	if got := s.Count("root"); got != 4 {
		t.Errorf("Count(root) = %d, want 4", got)
	}
	if got := s.Count("a1"); got != 3 { // e1, e2, e4
		t.Errorf("Count(a1) = %d, want 3", got)
	}
	if err := s.Verify("root"); err != nil {
		t.Errorf("Verify(root): %v", err)
	}
}

func TestContributionEvidence(t *testing.T) {
	tr := buildTree(t)
	s := NewStats(tr)
	mustEvent(t, s, "e1", "a1", "a2", "b1")
	mustEvent(t, s, "e2", "b")

	got := s.Contributions("a")
	want := []Contribution{
		{EventID: "e1", MatchedLabels: []string{"a1", "a2"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Contributions(a) = %+v, want %+v", got, want)
	}
	// 证据只含命中子树的标签，b1 不应出现在 a 的证据里。
	got = s.Contributions("root")
	want = []Contribution{
		{EventID: "e1", MatchedLabels: []string{"a1", "a2", "b1"}},
		{EventID: "e2", MatchedLabels: []string{"b"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Contributions(root) = %+v, want %+v", got, want)
	}
}

func TestDeleteEdgeChangesAttributionNotLabels(t *testing.T) {
	tr := buildTree(t)
	s := NewStats(tr)
	mustEvent(t, s, "e1", "a1", "a2")
	mustEvent(t, s, "e2", "b1")

	if err := tr.DeleteEdge("root", "a"); err != nil {
		t.Fatalf("DeleteEdge: %v", err)
	}
	// 归属改变：a 子树不再属于 root。
	if got := s.Count("root"); got != 1 { // 只剩 e2
		t.Errorf("after delete, Count(root) = %d, want 1", got)
	}
	// a 自身子树内部统计不变。
	if got := s.Count("a"); got != 1 { // e1 仍只计一次
		t.Errorf("after delete, Count(a) = %d, want 1", got)
	}
	// 原始标签不变。
	if got := s.Labels("e1"); !reflect.DeepEqual(got, []string{"a1", "a2"}) {
		t.Errorf("Labels(e1) = %v, want [a1 a2]", got)
	}
	// 证据同步变化。
	got := s.Contributions("root")
	if len(got) != 1 || got[0].EventID != "e2" {
		t.Errorf("after delete, Contributions(root) = %+v, want only e2", got)
	}
	// 删除不存在的边报错。
	if err := tr.DeleteEdge("root", "a"); err == nil {
		t.Error("DeleteEdge twice: want error, got nil")
	}
	if err := s.Verify("root"); err != nil {
		t.Errorf("Verify(root) after delete: %v", err)
	}
}

func TestDeleteEdgeForest(t *testing.T) {
	tr := buildTree(t)
	s := NewStats(tr)
	mustEvent(t, s, "e1", "a1")
	if err := tr.DeleteEdge("a", "a1"); err != nil {
		t.Fatalf("DeleteEdge: %v", err)
	}
	// a1 脱离后成为森林中独立的根，a 的汇总不再包含它。
	if got := s.Count("a"); got != 0 {
		t.Errorf("Count(a) = %d, want 0", got)
	}
	if got := s.Count("a1"); got != 1 {
		t.Errorf("Count(a1) = %d, want 1", got)
	}
}

func TestAddEdgeValidation(t *testing.T) {
	tr := buildTree(t)
	if err := tr.AddEdge("a1", "root"); err == nil {
		t.Error("cycle edge: want error, got nil")
	}
	if err := tr.AddEdge("root", "a1"); err == nil {
		t.Error("second parent: want error, got nil")
	}
	if err := tr.AddEdge("x", "x"); err == nil {
		t.Error("self edge: want error, got nil")
	}
	s := NewStats(tr)
	if err := s.AddEvent("bad", "nope"); err == nil {
		t.Error("unknown label: want error, got nil")
	}
}

// TestRandomSmallTrees 对随机小树反复做加边/删边/加事件，
// 每个节点都用逐事件可达性重算核对主统计路径。
func TestRandomSmallTrees(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 200; trial++ {
		tr := NewTree()
		tr.AddNode("n0")
		s := NewStats(tr)
		nodeCount := 1
		var edges [][2]string

		ops := 5 + rng.Intn(40)
		for op := 0; op < ops; op++ {
			switch rng.Intn(3) {
			case 0: // 加边：随机挂到现有节点下
				child := fmt.Sprintf("n%d", nodeCount)
				nodeCount++
				parent := fmt.Sprintf("n%d", rng.Intn(nodeCount-1))
				if err := tr.AddEdge(parent, child); err == nil {
					edges = append(edges, [2]string{parent, child})
				}
			case 1: // 删边
				if len(edges) > 0 {
					i := rng.Intn(len(edges))
					e := edges[i]
					if err := tr.DeleteEdge(e[0], e[1]); err == nil {
						edges = append(edges[:i], edges[i+1:]...)
					}
				}
			case 2: // 加事件：随机 1~3 个标签
				id := fmt.Sprintf("e%d", rng.Intn(8))
				var labels []string
				for k := 0; k < 1+rng.Intn(3); k++ {
					labels = append(labels, fmt.Sprintf("n%d", rng.Intn(nodeCount)))
				}
				if err := s.AddEvent(id, labels...); err != nil {
					t.Fatalf("trial %d: AddEvent: %v", trial, err)
				}
			}
		}
		for n := 0; n < nodeCount; n++ {
			node := fmt.Sprintf("n%d", n)
			if err := s.Verify(node); err != nil {
				t.Fatalf("trial %d: %v", trial, err)
			}
		}
	}
}

func mustEvent(t *testing.T, s *Stats, id string, labels ...string) {
	t.Helper()
	if err := s.AddEvent(id, labels...); err != nil {
		t.Fatalf("AddEvent(%q): %v", id, err)
	}
}
