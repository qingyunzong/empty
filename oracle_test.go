package dataeng

import (
	"go/parser"
	"go/token"
	"math/rand"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// 本文件提供一个与被测实现完全独立编写的参考模型（oracle）。
// 它使用不同的数据结构与控制流重放同一条时间线，再与被测包的输出逐项
// 比对。随机场景的期望值全部由 oracle 计算，绝不取自被测包。

type oracleStatus int

const (
	oracleRequested oracleStatus = iota
	oracleInflight
	oracleCompleted
	oracleInvalid
)

type oracleInstant struct {
	status oracleStatus
	files  []string
}

type oracleClean struct {
	deleted   []string
	protected []string
}

type oracleState struct {
	instants map[string]oracleInstant
	commits  []string
	cleans   []oracleClean
}

// oraclePriority 独立给出同刻顺序：完成 0、回滚 1、清洁 2、在途 3、请求 4。
func oraclePriority(kind Kind) int {
	switch kind {
	case KindComplete:
		return 0
	case KindRollback:
		return 1
	case KindClean:
		return 2
	case KindInflight:
		return 3
	default:
		return 4
	}
}

func oracleOrder(events []Event) []Event {
	ordered := append([]Event(nil), events...)
	sort.SliceStable(ordered, func(a, b int) bool {
		if ordered[a].At != ordered[b].At {
			return ordered[a].At < ordered[b].At
		}
		return oraclePriority(ordered[a].Kind) < oraclePriority(ordered[b].Kind)
	})
	return ordered
}

func oracleReplay(events []Event) oracleState {
	state := oracleState{instants: map[string]oracleInstant{}}
	for _, ev := range oracleOrder(events) {
		switch ev.Kind {
		case KindRequest:
			if _, exists := state.instants[ev.InstantID]; !exists {
				state.instants[ev.InstantID] = oracleInstant{status: oracleRequested}
			}
		case KindInflight:
			if cur, ok := state.instants[ev.InstantID]; ok && cur.status == oracleRequested {
				cur.status = oracleInflight
				state.instants[ev.InstantID] = cur
			}
		case KindComplete:
			if cur, ok := state.instants[ev.InstantID]; ok && cur.status == oracleInflight {
				cur.status = oracleCompleted
				cur.files = append([]string(nil), ev.Files...)
				state.instants[ev.InstantID] = cur
				state.commits = append(state.commits, ev.InstantID)
			}
		case KindRollback:
			if cur, ok := state.instants[ev.RollbackID]; ok && cur.status == oracleInflight {
				cur.status = oracleInvalid
				state.instants[ev.RollbackID] = cur
			}
		case KindClean:
			protected := map[string]bool{}
			for _, commitID := range state.commits {
				for _, name := range state.instants[commitID].files {
					protected[name] = true
				}
			}
			report := oracleClean{deleted: []string{}, protected: []string{}}
			seenDel, seenProt := map[string]bool{}, map[string]bool{}
			for _, name := range ev.Files {
				if protected[name] {
					if !seenProt[name] {
						report.protected = append(report.protected, name)
						seenProt[name] = true
					}
					continue
				}
				if !seenDel[name] {
					report.deleted = append(report.deleted, name)
					seenDel[name] = true
				}
			}
			state.cleans = append(state.cleans, report)
		}
	}
	return state
}

func (s oracleState) visibleFiles() []string {
	seen := map[string]bool{}
	var out []string
	for _, commitID := range s.commits {
		for _, name := range s.instants[commitID].files {
			if !seen[name] {
				seen[name] = true
				out = append(out, name)
			}
		}
	}
	return out
}

// sameSet 按集合比较，忽略顺序以及 nil 与空切片的表示差异。
func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	counts := map[string]int{}
	for _, x := range a {
		counts[x]++
	}
	for _, y := range b {
		counts[y]--
		if counts[y] < 0 {
			return false
		}
	}
	return true
}

func (s oracleState) idsByStatus(want oracleStatus) []string {
	var out []string
	for id, ins := range s.instants {
		if ins.status == want {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

func randomEvents(rng *rand.Rand) []Event {
	var events []Event
	ids := []string{"i0", "i1", "i2", "i3", "i4"}
	files := []string{"p0", "p1", "p2", "p3", "p4", "p5"}
	var clock int64
	for _, id := range ids {
		clock += 1 + int64(rng.Intn(3)) // 保证同一瞬间的生命周期事件严格递增
		events = append(events, NewRequest(clock, id))
		clock += 1 + int64(rng.Intn(3))
		events = append(events, NewInflight(clock, id))

		// 约三分之一的在途瞬间会被回滚，其余完成。
		if rng.Intn(3) == 0 {
			clock += 1 + int64(rng.Intn(3)) // 回滚必须晚于任何同刻完成事件
			events = append(events, NewRollback(clock, "rb-"+id, id))
			continue
		}
		clock += int64(rng.Intn(3))
		picked := rng.Perm(len(files))[:1+rng.Intn(3)]
		commitFiles := make([]string, len(picked))
		for i, idx := range picked {
			commitFiles[i] = files[idx]
		}
		events = append(events, NewComplete(clock, id, commitFiles))

		// 完成后插入清洁，候选文件从文件池随机点名。
		if rng.Intn(2) == 0 {
			cleanFiles := append([]string(nil), files[rng.Intn(len(files))])
			if rng.Intn(2) == 0 {
				cleanFiles = append(cleanFiles, files[rng.Intn(len(files))])
			}
			events = append(events, NewClean(clock, "clean-"+id, cleanFiles))
		}
	}
	return events
}

func TestOracleCrossCheckRandomTimelines(t *testing.T) {
	rng := rand.New(rand.NewSource(20261113))
	for iteration := 0; iteration < 200; iteration++ {
		events := randomEvents(rng)
		expected := oracleReplay(events)
		view, _ := NewTimeline(events).Replay()

		gotCommits := make([]string, 0, len(view.Commits()))
		for _, commit := range view.Commits() {
			gotCommits = append(gotCommits, commit.ID)
		}
		if !sameSet(gotCommits, expected.commits) {
			t.Fatalf("iter %d commits = %v, want %v", iteration, gotCommits, expected.commits)
		}
		if got := view.VisibleFiles(); !sameSet(got, expected.visibleFiles()) {
			t.Fatalf("iter %d visible = %v, want %v", iteration, got, expected.visibleFiles())
		}
		if got := view.InvalidIDs(); !sameSet(got, expected.idsByStatus(oracleInvalid)) {
			t.Fatalf("iter %d invalid = %v, want %v", iteration, got, expected.idsByStatus(oracleInvalid))
		}
		if got := view.InflightIDs(); !sameSet(got, expected.idsByStatus(oracleInflight)) {
			t.Fatalf("iter %d inflight = %v, want %v", iteration, got, expected.idsByStatus(oracleInflight))
		}
		if got := view.RequestedIDs(); !sameSet(got, expected.idsByStatus(oracleRequested)) {
			t.Fatalf("iter %d requested = %v, want %v", iteration, got, expected.idsByStatus(oracleRequested))
		}

		reports := view.CleanReports()
		if len(reports) != len(expected.cleans) {
			t.Fatalf("iter %d clean count = %d, want %d", iteration, len(reports), len(expected.cleans))
		}
		for i, report := range reports {
			want := expected.cleans[i]
			if !reflect.DeepEqual(report.Deleted, want.deleted) || !reflect.DeepEqual(report.Protected, want.protected) {
				t.Fatalf("iter %d clean[%d] = (%v,%v), want (%v,%v)",
					iteration, i, report.Deleted, report.Protected, want.deleted, want.protected)
			}
		}

		// 抽查中间时刻视图与 oracle 前缀重放一致。
		maxAt := events[len(events)-1].At
		checkAt := rng.Int63n(maxAt + 1)
		prefix := make([]Event, 0)
		for _, ev := range events {
			if ev.At <= checkAt {
				prefix = append(prefix, ev)
			}
		}
		expectedPrefix := oracleReplay(prefix)
		checkpoint := NewTimeline(events).ReplayUntil(checkAt)
		if got := checkpoint.VisibleFiles(); !reflect.DeepEqual(got, expectedPrefix.visibleFiles()) {
			t.Fatalf("iter %d checkpoint visible = %v, want %v", iteration, got, expectedPrefix.visibleFiles())
		}
	}
}

// TestPackageNeverTouchesFilesystem 静态保证：非测试源码不得引入任何文件
// 系统相关的包，从而确保“解释时间线但不打开数据文件”。
func TestPackageNeverTouchesFilesystem(t *testing.T) {
	forbidden := map[string]bool{
		"os": true, "io": true, "io/fs": true,
		"net/http": true, "os/exec": true,
	}
	pkgs, err := parser.ParseDir(token.NewFileSet(), ".", nil, parser.ImportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	for _, pkg := range pkgs {
		for file, astFile := range pkg.Files {
			name := file
			if idx := strings.LastIndex(name, "/"); idx >= 0 {
				name = name[idx+1:]
			}
			if strings.HasSuffix(name, "_test.go") || name == "doc.go" {
				continue
			}
			for _, spec := range astFile.Imports {
				path := spec.Path.Value[1 : len(spec.Path.Value)-1]
				if forbidden[path] {
					t.Errorf("%s imports forbidden package %q", name, path)
				}
			}
		}
	}
}
