package dataeng

import (
	"reflect"
	"testing"
)

// scenarioEvents 是一份手工编排的时间线，刻意覆盖：
//   - 正常 请求 -> 在途 -> 完成 生命周期；
//   - 同时间戳下 完成 > 回滚 > 清洁 > 在途 > 请求 的优先级；
//   - 回滚只失效在途瞬间，已完成瞬间不受影响；
//   - 清洁只删调用方点名的文件，且受完成瞬间引用的文件被保护；
//   - 同类型事件的稳定顺序（稳定排序）。
//
// 下面所有期望均按规则人工推导后硬编码，不调用被测包来生成期望值。
func scenarioEvents() []Event {
	return []Event{
		NewRequest(1, "a"),
		NewInflight(2, "a"),
		NewComplete(3, "a", []string{"f1", "f2"}),

		NewRequest(4, "b"),
		NewInflight(5, "b"),

		// t=6：两条同刻清洁，验证同类型事件的稳定顺序与重复点名。
		NewClean(6, "clean-1", []string{"f1", "stale1", "f2", "stale2"}),
		NewClean(6, "clean-2", []string{"stale1", "stale3"}),

		NewRequest(7, "c"),
		NewInflight(8, "c"),
		NewRollback(9, "rb-c", "c"),

		// t=10：同时间戳混合事件，验证 完成 > 回滚 > 清洁 > 在途 > 请求。
		NewRequest(10, "d"),
		NewInflight(10, "d"),
		NewComplete(10, "b", []string{"f3"}),
		NewRollback(10, "rb-d", "d"),
		NewClean(10, "clean-3", []string{"f1", "stale1", "f3"}),
	}
}

func TestReplayVisibilityAndState(t *testing.T) {
	tl := NewTimeline(scenarioEvents())
	view, trace := tl.Replay()

	if len(trace) != len(scenarioEvents()) {
		t.Fatalf("trace length = %d, want %d", len(trace), len(scenarioEvents()))
	}

	// 可见提交：a 在 t=3 完成，b 在 t=10 完成（完成先于同刻回滚）。
	gotCommitIDs := make([]string, 0)
	for _, commit := range view.Commits() {
		gotCommitIDs = append(gotCommitIDs, commit.ID)
	}
	wantCommitIDs := []string{"a", "b"}
	if !reflect.DeepEqual(gotCommitIDs, wantCommitIDs) {
		t.Fatalf("commit IDs = %v, want %v", gotCommitIDs, wantCommitIDs)
	}

	wantVisible := []string{"f1", "f2", "f3"}
	if got := view.VisibleFiles(); !reflect.DeepEqual(got, wantVisible) {
		t.Fatalf("visible files = %v, want %v", got, wantVisible)
	}
	for _, name := range wantVisible {
		if !view.IsVisible(name) {
			t.Errorf("file %q must remain visible", name)
		}
	}
	if view.IsVisible("stale1") {
		t.Errorf("stale1 must not be visible")
	}

	// 状态核对。
	cases := []struct {
		id          string
		wantState   State
		wantInvalid bool
		wantFound   bool
	}{
		{"a", Completed, false, true},
		{"b", Completed, false, true},
		{"c", Inflight, true, true},   // 回滚失效，保留失效前的在途状态
		{"d", Requested, false, true}, // 完成先于回滚，但 d 仍是请求态，回滚不命中
		{"missing", 0, false, false},
	}
	for _, tc := range cases {
		state, invalid, found := view.State(tc.id)
		if found != tc.wantFound || invalid != tc.wantInvalid || (found && state != tc.wantState) {
			t.Errorf("State(%q) = (%s,%v,%v), want (%s,%v,%v)",
				tc.id, state, invalid, found, tc.wantState, tc.wantInvalid, tc.wantFound)
		}
	}

	if got := view.InvalidIDs(); !reflect.DeepEqual(got, []string{"c"}) {
		t.Errorf("invalid IDs = %v, want [c]", got)
	}
	if got := view.RequestedIDs(); !reflect.DeepEqual(got, []string{"d"}) {
		t.Errorf("requested IDs = %v, want [d]", got)
	}
	if got := view.InflightIDs(); len(got) != 0 {
		t.Errorf("inflight IDs = %v, want empty", got)
	}
}

func TestReplayCleanProtection(t *testing.T) {
	view, _ := NewTimeline(scenarioEvents()).Replay()
	reports := view.CleanReports()
	if len(reports) != 3 {
		t.Fatalf("clean reports = %d, want 3", len(reports))
	}

	// t=6 时只有 a 已完成（f1,f2 受保护）。
	if !reflect.DeepEqual(reports[0].Deleted, []string{"stale1", "stale2"}) {
		t.Errorf("clean-1 deleted = %v, want [stale1 stale2]", reports[0].Deleted)
	}
	if !reflect.DeepEqual(reports[0].Protected, []string{"f1", "f2"}) {
		t.Errorf("clean-1 protected = %v, want [f1 f2]", reports[0].Protected)
	}

	// 第二次清洁同刻执行，f1/f2 仍受保护，本次未点名它们。
	if !reflect.DeepEqual(reports[1].Deleted, []string{"stale1", "stale3"}) {
		t.Errorf("clean-2 deleted = %v, want [stale1 stale3]", reports[1].Deleted)
	}
	if len(reports[1].Protected) != 0 {
		t.Errorf("clean-2 protected = %v, want empty", reports[1].Protected)
	}

	// t=10 时 a、b 都已完成，f1/f3 受保护；stale1 无人引用可删。
	if !reflect.DeepEqual(reports[2].Deleted, []string{"stale1"}) {
		t.Errorf("clean-3 deleted = %v, want [stale1]", reports[2].Deleted)
	}
	if !reflect.DeepEqual(reports[2].Protected, []string{"f1", "f3"}) {
		t.Errorf("clean-3 protected = %v, want [f1 f3]", reports[2].Protected)
	}
}

func TestSameTimestampPriorityOrdering(t *testing.T) {
	// 打乱优先级顺序传入，期望重放顺序为 完成、回滚、清洁、在途、请求。
	events := []Event{
		NewRequest(10, "x"),
		NewClean(10, "cl", nil),
		NewRollback(10, "rb", "x"),
		NewComplete(10, "x", nil),
		NewInflight(10, "x"),
	}
	_, trace := NewTimeline(events).Replay()
	gotKinds := make([]Kind, len(trace))
	for i, point := range trace {
		gotKinds[i] = point.Event.Kind
	}
	wantKinds := []Kind{KindComplete, KindRollback, KindClean, KindInflight, KindRequest}
	if !reflect.DeepEqual(gotKinds, wantKinds) {
		t.Fatalf("order = %v, want %v", gotKinds, wantKinds)
	}
}

func TestRollbackOnlyInvalidatesInflight(t *testing.T) {
	events := []Event{
		NewRequest(1, "done"),
		NewInflight(2, "done"),
		NewComplete(3, "done", []string{"keep"}),
		NewRollback(4, "rb-done", "done"), // 已完成：不受影响

		NewRequest(5, "waiting"),
		NewRollback(6, "rb-waiting", "waiting"), // 请求态：回滚不命中

		NewRollback(7, "rb-ghost", "ghost"), // 未知瞬间：无操作
	}
	view, _ := NewTimeline(events).Replay()

	if state, invalid, found := view.State("done"); !found || invalid || state != Completed {
		t.Errorf("completed instant must survive rollback: (%s,%v,%v)", state, invalid, found)
	}
	if state, invalid, found := view.State("waiting"); !found || invalid || state != Requested {
		t.Errorf("requested instant must be untouched by rollback: (%s,%v,%v)", state, invalid, found)
	}
	if len(view.InvalidIDs()) != 0 {
		t.Errorf("no inflight rollback expected, got invalid %v", view.InvalidIDs())
	}
	if !view.IsVisible("keep") {
		t.Errorf("file of completed instant must stay visible")
	}
}

func TestReplayUntilCheckpoints(t *testing.T) {
	tl := NewTimeline(scenarioEvents())

	checkpoints := []struct {
		at            int64
		wantCommits   []string
		wantVisible   []string
		wantInvalid   []string
		wantRequested []string
		wantInflight  []string
	}{
		{2, nil, nil, nil, nil, []string{"a"}},
		{3, []string{"a"}, []string{"f1", "f2"}, nil, nil, nil},
		{9, []string{"a"}, []string{"f1", "f2"}, []string{"c"}, nil, []string{"b"}},
		{10, []string{"a", "b"}, []string{"f1", "f2", "f3"}, []string{"c"}, []string{"d"}, nil},
	}
	for _, cp := range checkpoints {
		view := tl.ReplayUntil(cp.at)
		gotCommits := make([]string, 0)
		for _, commit := range view.Commits() {
			gotCommits = append(gotCommits, commit.ID)
		}
		if !sameStringSet(gotCommits, cp.wantCommits) {
			t.Errorf("at=%d commits = %v, want %v", cp.at, gotCommits, cp.wantCommits)
		}
		if got := view.VisibleFiles(); !sameStringSet(got, cp.wantVisible) {
			t.Errorf("at=%d visible = %v, want %v", cp.at, got, cp.wantVisible)
		}
		if got := view.InvalidIDs(); !sameStringSet(got, cp.wantInvalid) {
			t.Errorf("at=%d invalid = %v, want %v", cp.at, got, cp.wantInvalid)
		}
		if got := view.RequestedIDs(); !sameStringSet(got, cp.wantRequested) {
			t.Errorf("at=%d requested = %v, want %v", cp.at, got, cp.wantRequested)
		}
		if got := view.InflightIDs(); !sameStringSet(got, cp.wantInflight) {
			t.Errorf("at=%d inflight = %v, want %v", cp.at, got, cp.wantInflight)
		}
	}
}

// sameStringSet 忽略 nil 与空切片的差异，按集合（顺序敏感场景不用它）比较。
func sameStringSet(a, b []string) bool {
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

func TestReplayDoesNotMutateOrShareStorage(t *testing.T) {
	events := scenarioEvents()
	tl := NewTimeline(events)
	view1, _ := tl.Replay()
	view2, _ := tl.Replay()

	// 两次重放相互独立：篡改 view1 不影响 view2。
	view1.Commits()[0].Files[0] = "tampered"
	if view2.Commits()[0].Files[0] != "f1" {
		t.Fatal("replays must return independent copies")
	}

	// 外部修改原始事件切片不影响已构造的时间线。
	events[0].InstantID = "changed"
	view3, _ := tl.Replay()
	if _, _, found := view3.State("changed"); found {
		t.Fatal("timeline must keep its own copy of events")
	}
	if _, _, found := view3.State("a"); !found {
		t.Fatal("instant a must still exist after external mutation")
	}
}

func TestStringersAndStableSameKindOrder(t *testing.T) {
	if Requested.String() != "requested" || Inflight.String() != "inflight" || Completed.String() != "completed" {
		t.Fatal("unexpected state string")
	}
	kinds := []Kind{KindRequest, KindInflight, KindComplete, KindRollback, KindClean}
	want := []string{"request", "inflight", "complete", "rollback", "clean"}
	for i, kind := range kinds {
		if kind.String() != want[i] {
			t.Fatalf("kind %d string = %q, want %q", kind, kind.String(), want[i])
		}
	}

	// 同时间戳、同类型事件保持调用方给定顺序。
	events := []Event{
		NewRequest(1, "first"),
		NewRequest(1, "second"),
		NewRequest(1, "third"),
	}
	_, trace := NewTimeline(events).Replay()
	gotOrder := []string{trace[0].Event.InstantID, trace[1].Event.InstantID, trace[2].Event.InstantID}
	if !reflect.DeepEqual(gotOrder, []string{"first", "second", "third"}) {
		t.Fatalf("stable order = %v", gotOrder)
	}
}
