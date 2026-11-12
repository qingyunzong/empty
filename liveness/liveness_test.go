package liveness

import (
	"errors"
	"reflect"
	"testing"
)

func mustGraph(t *testing.T, commits ...Commit) *Graph {
	t.Helper()
	g, err := NewGraph(commits...)
	if err != nil {
		t.Fatalf("NewGraph: %v", err)
	}
	return g
}

func checkLive(t *testing.T, g *Graph, commit string, want map[string]string) {
	t.Helper()
	got, err := g.LiveFiles(commit)
	if err != nil {
		t.Fatalf("LiveFiles(%q): %v", commit, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("LiveFiles(%q) = %v, want %v", commit, got, want)
	}
}

func fileIDs(files []File) []string {
	ids := make([]string, 0, len(files))
	for _, f := range files {
		ids = append(ids, f.ID)
	}
	return ids
}

// 分叉：同一基础提交分出两支，各自独立演化。
func TestFork(t *testing.T) {
	g := mustGraph(t,
		Commit{ID: "c1", Adds: []File{{"a", "da"}, {"b", "db"}}},
		Commit{ID: "c2", Parents: []string{"c1"}, Adds: []File{{"c", "dc"}}},
		Commit{ID: "c3", Parents: []string{"c1"}, Removes: []string{"a"}, Adds: []File{{"d", "dd"}}},
	)
	checkLive(t, g, "c1", map[string]string{"a": "da", "b": "db"})
	checkLive(t, g, "c2", map[string]string{"a": "da", "b": "db", "c": "dc"})
	checkLive(t, g, "c3", map[string]string{"b": "db", "d": "dd"})
}

// 合并：多父取活文件并集；合并后的提交删除文件，只影响其后代。
func TestMergeThenDelete(t *testing.T) {
	g := mustGraph(t,
		Commit{ID: "c1", Adds: []File{{"a", "da"}}},
		Commit{ID: "c2", Parents: []string{"c1"}, Adds: []File{{"b", "db"}}},
		Commit{ID: "c3", Parents: []string{"c1"}, Adds: []File{{"c", "dc"}}},
		Commit{ID: "c4", Parents: []string{"c2", "c3"}},
		Commit{ID: "c5", Parents: []string{"c4"}, Removes: []string{"b"}},
	)
	checkLive(t, g, "c4", map[string]string{"a": "da", "b": "db", "c": "dc"})
	checkLive(t, g, "c5", map[string]string{"a": "da", "c": "dc"})
	checkLive(t, g, "c2", map[string]string{"a": "da", "b": "db"})
}

// 复活：文件被删除后以相同摘要重新加入，恢复存活；
// 证据路径指向复活提交而非最初的引入提交。
func TestResurrection(t *testing.T) {
	g := mustGraph(t,
		Commit{ID: "c1", Adds: []File{{"a", "da"}, {"b", "db"}}},
		Commit{ID: "c2", Parents: []string{"c1"}, Removes: []string{"a"}},
		Commit{ID: "c3", Parents: []string{"c2"}, Adds: []File{{"a", "da"}}},
	)
	checkLive(t, g, "c2", map[string]string{"b": "db"})
	checkLive(t, g, "c3", map[string]string{"a": "da", "b": "db"})

	ret, err := g.Retain([]string{"c3"})
	if err != nil {
		t.Fatalf("Retain: %v", err)
	}
	if got := ret.Evidence["a"].Path; !reflect.DeepEqual(got, []string{"c3"}) {
		t.Errorf("evidence path for resurrected a = %v, want [c3]", got)
	}
	if got := ret.Evidence["b"].Path; !reflect.DeepEqual(got, []string{"c3", "c2", "c1"}) {
		t.Errorf("evidence path for b = %v, want [c3 c2 c1]", got)
	}
}

// 同 ID 不同摘要拒绝整份图，即使出现在互不相关的提交中。
func TestDigestConflict(t *testing.T) {
	_, err := NewGraph(
		Commit{ID: "c1", Adds: []File{{"a", "d1"}}},
		Commit{ID: "c2", Parents: []string{"c1"}, Adds: []File{{"a", "d2"}}},
	)
	if !errors.Is(err, ErrDigestConflict) {
		t.Fatalf("err = %v, want ErrDigestConflict", err)
	}
}

func TestMissingParent(t *testing.T) {
	_, err := NewGraph(Commit{ID: "c1", Parents: []string{"nope"}})
	if !errors.Is(err, ErrMissingParent) {
		t.Fatalf("err = %v, want ErrMissingParent", err)
	}
}

func TestCycle(t *testing.T) {
	_, err := NewGraph(
		Commit{ID: "c1", Parents: []string{"c2"}},
		Commit{ID: "c2", Parents: []string{"c1"}},
	)
	if !errors.Is(err, ErrCycle) {
		t.Fatalf("err = %v, want ErrCycle", err)
	}
	_, err = NewGraph(Commit{ID: "c1", Parents: []string{"c1"}})
	if !errors.Is(err, ErrCycle) {
		t.Fatalf("self-loop err = %v, want ErrCycle", err)
	}
}

// 同提交重复操作：重复加入、重复移除、既加入又移除，均报错。
func TestDuplicateOperations(t *testing.T) {
	cases := map[string]Commit{
		"add twice":    {ID: "c1", Adds: []File{{"a", "d1"}, {"a", "d1"}}},
		"remove twice": {ID: "c1", Removes: []string{"a", "a"}},
		"add+remove":   {ID: "c1", Adds: []File{{"a", "d1"}}, Removes: []string{"a"}},
	}
	for name, c := range cases {
		if _, err := NewGraph(c); !errors.Is(err, ErrDuplicateOperation) {
			t.Errorf("%s: err = %v, want ErrDuplicateOperation", name, err)
		}
	}
}

// 保留判定：并集取自保留提交的活文件集合；证据路径从保留提交出发；
// 只存活于非保留祖先中的文件不算保留。
func TestRetention(t *testing.T) {
	g := mustGraph(t,
		Commit{ID: "c1", Adds: []File{{"a", "da"}, {"b", "db"}}},
		Commit{ID: "c2", Parents: []string{"c1"}, Removes: []string{"b"}, Adds: []File{{"c", "dc"}}},
		Commit{ID: "c3", Parents: []string{"c1"}, Adds: []File{{"d", "dd"}}},
		Commit{ID: "c4", Parents: []string{"c2", "c3"}, Removes: []string{"a"}},
	)

	ret, err := g.Retain([]string{"c4"})
	if err != nil {
		t.Fatalf("Retain: %v", err)
	}
	if got, want := fileIDs(ret.Files), []string{"b", "c", "d"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("retained files = %v, want %v", got, want)
	}
	wantPaths := map[string][]string{
		"b": {"c4", "c3", "c1"},
		"c": {"c4", "c2"},
		"d": {"c4", "c3"},
	}
	for id, want := range wantPaths {
		if got := ret.Evidence[id].Path; !reflect.DeepEqual(got, want) {
			t.Errorf("evidence path for %s = %v, want %v", id, got, want)
		}
	}

	// 只保留 c2：b 只存活于非保留祖先 c1 中，不应保留。
	ret, err = g.Retain([]string{"c2"})
	if err != nil {
		t.Fatalf("Retain: %v", err)
	}
	if got, want := fileIDs(ret.Files), []string{"a", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("retained files for [c2] = %v, want %v", got, want)
	}
	if got := ret.Evidence["a"].Path; !reflect.DeepEqual(got, []string{"c2", "c1"}) {
		t.Errorf("evidence path for a = %v, want [c2 c1]", got)
	}

	// 多个保留提交取并集。
	ret, err = g.Retain([]string{"c2", "c3"})
	if err != nil {
		t.Fatalf("Retain: %v", err)
	}
	if got, want := fileIDs(ret.Files), []string{"a", "b", "c", "d"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("retained files for [c2 c3] = %v, want %v", got, want)
	}
	for id, ev := range ret.Evidence {
		root := ev.Path[0]
		if root != "c2" && root != "c3" {
			t.Errorf("evidence path for %s starts at %q, not a retained commit", id, root)
		}
	}
}

func TestRetainUnknownCommit(t *testing.T) {
	g := mustGraph(t, Commit{ID: "c1", Adds: []File{{"a", "da"}}})
	if _, err := g.Retain([]string{"nope"}); !errors.Is(err, ErrUnknownCommit) {
		t.Fatalf("err = %v, want ErrUnknownCommit", err)
	}
	if _, err := g.LiveFiles("nope"); !errors.Is(err, ErrUnknownCommit) {
		t.Fatalf("err = %v, want ErrUnknownCommit", err)
	}
}
