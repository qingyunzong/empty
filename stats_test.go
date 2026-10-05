package stats

import (
	"fmt"
	"slices"
	"sync"
	"testing"
)

func mustUpsert(t *testing.T, s *Store, ev Event) []Snapshot {
	t.Helper()
	out, err := s.Upsert(ev)
	if err != nil {
		t.Fatalf("Upsert(%+v) 出错: %v", ev, err)
	}
	return out
}

func mustCorrect(t *testing.T, s *Store, ev Event) []Snapshot {
	t.Helper()
	out, err := s.Correct(ev)
	if err != nil {
		t.Fatalf("Correct(%+v) 出错: %v", ev, err)
	}
	return out
}

func snapMap(snaps []Snapshot) map[string]Snapshot {
	out := map[string]Snapshot{}
	for _, sn := range snaps {
		out[sn.Owner] = sn
	}
	return out
}

// 窗口保留最近 n 个事件，偶数窗口取中间两项平均。
func TestWindowAndEvenMedian(t *testing.T) {
	s := New(2)
	mustUpsert(t, s, Event{ID: "a", User: "u1", Time: 1, Score: 1})
	mustUpsert(t, s, Event{ID: "b", User: "u1", Time: 2, Score: 2})
	got := s.Snapshot("u1")
	if got.Count != 2 || got.Median != 1.5 || !slices.Equal(got.Window, []string{"a", "b"}) {
		t.Fatalf("快照不符: %+v", got)
	}
	// 新事件挤掉最旧的
	mustUpsert(t, s, Event{ID: "c", User: "u1", Time: 3, Score: 3})
	got = s.Snapshot("u1")
	if got.Count != 2 || got.Median != 2.5 || !slices.Equal(got.Window, []string{"b", "c"}) {
		t.Fatalf("窗口滚动后快照不符: %+v", got)
	}
	// 更旧的事件不改变窗口
	snaps := mustUpsert(t, s, Event{ID: "d", User: "u1", Time: 0, Score: 0})
	if len(snaps) != 0 {
		t.Fatalf("旧事件不应引起快照变动: %+v", snaps)
	}
	got = s.Snapshot("u1")
	if got.Count != 2 || got.Median != 2.5 {
		t.Fatalf("旧事件不应改变窗口: %+v", got)
	}
	// 更正窗口内事件
	mustUpsert(t, s, Event{ID: "b", User: "u1", Time: 4, Score: 5})
	got = s.Snapshot("u1")
	if got.Count != 2 || got.Median != 4 || !slices.Equal(got.Window, []string{"c", "b"}) {
		t.Fatalf("更正后快照不符: %+v", got)
	}
}

// 奇数窗口取中间值；业务时间相同按 ID 决胜。
func TestOddMedianAndTieBreak(t *testing.T) {
	s := New(3)
	for _, ev := range []Event{
		{ID: "a", User: "u1", Time: 1, Score: 30},
		{ID: "b", User: "u1", Time: 2, Score: 10},
		{ID: "c", User: "u1", Time: 3, Score: 20},
	} {
		mustUpsert(t, s, ev)
	}
	if got := s.Snapshot("u1"); got.Median != 20 || got.Count != 3 {
		t.Fatalf("奇数窗口中位数不符: %+v", got)
	}

	s1 := New(1)
	mustUpsert(t, s1, Event{ID: "a", User: "u1", Time: 5, Score: 1})
	mustUpsert(t, s1, Event{ID: "b", User: "u1", Time: 5, Score: 2})
	if got := s1.Snapshot("u1"); !slices.Equal(got.Window, []string{"b"}) {
		t.Fatalf("同时间应按 ID 决胜保留 b: %+v", got)
	}
	// 把 b 更正走，a 应回到窗口
	mustCorrect(t, s1, Event{ID: "b", User: "u2", Time: 5, Score: 2})
	if got := s1.Snapshot("u1"); !slices.Equal(got.Window, []string{"a"}) {
		t.Fatalf("b 移走后窗口应回退到 a: %+v", got)
	}
}

// 全局更正可以把事件移动到其他用户，变动双方都应输出快照。
func TestCorrectionMovesUser(t *testing.T) {
	s := New(2)
	mustUpsert(t, s, Event{ID: "x", User: "u1", Time: 1, Score: 10})
	mustUpsert(t, s, Event{ID: "y", User: "u1", Time: 2, Score: 20})

	snaps := mustCorrect(t, s, Event{ID: "x", User: "u2", Time: 3, Score: 30})
	m := snapMap(snaps)
	if len(m) != 2 {
		t.Fatalf("移动应影响两个用户: %+v", snaps)
	}
	if got := m["u1"]; got.Count != 1 || got.Median != 20 || !slices.Equal(got.Window, []string{"y"}) {
		t.Fatalf("u1 快照不符: %+v", got)
	}
	if got := m["u2"]; got.Count != 1 || got.Median != 30 || !slices.Equal(got.Window, []string{"x"}) {
		t.Fatalf("u2 快照不符: %+v", got)
	}
	// 同用户重复上报同 ID 是原地更正而非新增
	mustCorrect(t, s, Event{ID: "x", User: "u2", Time: 9, Score: 99})
	if got := s.Snapshot("u2"); got.Count != 1 || got.Median != 99 {
		t.Fatalf("原地更正不符: %+v", got)
	}
	// Upsert 不移动其他用户的事件：u3 可持有自己的 x 副本
	mustUpsert(t, s, Event{ID: "x", User: "u3", Time: 5, Score: 50})
	if got := s.Snapshot("u2"); got.Count != 1 || got.Median != 99 {
		t.Fatalf("u3 的副本不应影响 u2: %+v", got)
	}
	if got := s.Snapshot("u3"); got.Count != 1 || got.Median != 50 {
		t.Fatalf("u3 副本不符: %+v", got)
	}
}

// 归并：重组顺序、同 ID 去重、冲突隔离；拆分：回到原来源，历史快照保持。
func TestMergeDedupeConflictSplitRestore(t *testing.T) {
	s := New(3)
	mustUpsert(t, s, Event{ID: "e1", User: "u1", Time: 1, Score: 10})
	mustUpsert(t, s, Event{ID: "e2", User: "u1", Time: 2, Score: 20})
	mustUpsert(t, s, Event{ID: "e2", User: "u2", Time: 2, Score: 20}) // 与 u1 完全一致的重复
	mustUpsert(t, s, Event{ID: "e3", User: "u2", Time: 3, Score: 30})
	mustUpsert(t, s, Event{ID: "e2", User: "u3", Time: 9, Score: 99}) // 与 u1 冲突的同 ID

	before := map[string]Snapshot{}
	for _, u := range []string{"u1", "u2", "u3"} {
		before[u] = s.Snapshot(u)
	}

	snaps, err := s.Merge("g1", []string{"u1", "u2", "u3"})
	if err != nil {
		t.Fatalf("Merge 出错: %v", err)
	}
	m := snapMap(snaps)
	// 组内去重后为 e1,e2,e3，中位数 20
	if got := m["g1"]; got.Count != 3 || got.Median != 20 || !slices.Equal(got.Window, []string{"e1", "e2", "e3"}) {
		t.Fatalf("组快照不符: %+v", got)
	}
	// 成员被清空
	for _, u := range []string{"u1", "u2", "u3"} {
		if got := m[u]; got.Count != 0 || got.Median != 0 {
			t.Fatalf("成员 %s 应被清空: %+v", u, got)
		}
	}
	// 冲突与重复副本被隔离
	q := s.Quarantine("g1")
	if len(q["e2"]) != 2 {
		t.Fatalf("e2 应有两份隔离副本: %+v", q)
	}
	// 别名查询解析到组
	if got := s.Snapshot("u2"); got.Owner != "g1" || got.Median != 20 {
		t.Fatalf("别名应解析到组: %+v", got)
	}
	// 组存续期间发生更正，历史快照应记录
	mustUpsert(t, s, Event{ID: "e4", User: "u3", Time: 4, Score: 40})
	if got := s.Snapshot("g1"); got.Count != 3 || got.Median != 30 {
		t.Fatalf("组内更正后快照不符: %+v", got)
	}

	// 拆分：各用户回到原来源（u3 的 e2 仍是冲突版本，e4 归 u3）
	if _, err := s.Split("g1"); err != nil {
		t.Fatalf("Split 出错: %v", err)
	}
	if got := s.Snapshot("u1"); !slices.Equal(got.Window, before["u1"].Window) || got.Median != before["u1"].Median {
		t.Fatalf("u1 未恢复: %+v vs %+v", got, before["u1"])
	}
	if got := s.Snapshot("u2"); !slices.Equal(got.Window, before["u2"].Window) || got.Median != before["u2"].Median {
		t.Fatalf("u2 未恢复: %+v vs %+v", got, before["u2"])
	}
	// u3 原有 e2(冲突版)，存续期间又贡献了 e4，按 (Time, ID) 排序 e4 在前
	got3 := s.Snapshot("u3")
	if !slices.Equal(got3.Window, []string{"e4", "e2"}) {
		t.Fatalf("u3 恢复不符: %+v", got3)
	}
	// 历史快照保持：组已删除，但其快照仍在历史中
	var foundGroup bool
	for _, h := range s.History() {
		if h.Owner == "g1" {
			foundGroup = true
		}
	}
	if !foundGroup {
		t.Fatal("拆分后历史快照中应保留组的快照")
	}
	if got := s.Snapshot("g1"); got.Count != 0 {
		t.Fatalf("组已拆分应返回零值快照: %+v", got)
	}
}

// 拆分后再次归并应正常工作。
func TestSplitThenRemerge(t *testing.T) {
	s := New(2)
	mustUpsert(t, s, Event{ID: "a", User: "u1", Time: 1, Score: 1})
	mustUpsert(t, s, Event{ID: "b", User: "u2", Time: 2, Score: 2})
	if _, err := s.Merge("g", []string{"u1", "u2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Split("g"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Merge("g2", []string{"u1", "u2"}); err != nil {
		t.Fatalf("拆分后重新归并失败: %v", err)
	}
	if got := s.Snapshot("g2"); got.Count != 2 || got.Median != 1.5 {
		t.Fatalf("重新归并后快照不符: %+v", got)
	}
}

func TestMergeSplitErrors(t *testing.T) {
	s := New(2)
	mustUpsert(t, s, Event{ID: "a", User: "u1", Time: 1, Score: 1})
	cases := []struct {
		name    string
		group   string
		members []string
	}{
		{"空组ID", "", []string{"u1"}},
		{"空成员", "g", nil},
		{"成员含自身", "g", []string{"g"}},
		{"成员重复", "g", []string{"u1", "u1"}},
		{"组ID已存在", "u1", []string{"u2"}},
	}
	for _, c := range cases {
		if _, err := s.Merge(c.group, c.members); err == nil {
			t.Fatalf("%s: 应返回错误", c.name)
		}
	}
	if _, err := s.Merge("g", []string{"u1", "u2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Merge("h", []string{"u1", "u3"}); err == nil {
		t.Fatal("成员已在组中应报错")
	}
	if _, err := s.Split("nope"); err == nil {
		t.Fatal("拆分不存在的组应报错")
	}
	if _, err := s.Upsert(Event{ID: "z", User: "g", Time: 1, Score: 1}); err == nil {
		t.Fatal("以组为用户上报应报错")
	}
	if _, err := s.Upsert(Event{ID: "", User: "u1"}); err == nil {
		t.Fatal("空 ID 应报错")
	}
}

// 并发上报与查询不应产生数据竞争（配合 -race 运行）。
func TestConcurrentAccess(t *testing.T) {
	s := New(3)
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			user := fmt.Sprintf("u%d", w)
			for i := 0; i < 200; i++ {
				_, _ = s.Upsert(Event{ID: fmt.Sprintf("e%d-%d", w, i%20), User: user, Time: int64(i), Score: float64(i)})
				_ = s.Snapshot(user)
			}
		}(w)
	}
	wg.Wait()
	for w := 0; w < 8; w++ {
		if got := s.Snapshot(fmt.Sprintf("u%d", w)); got.Count != 3 {
			t.Fatalf("u%d 窗口大小不符: %+v", w, got)
		}
	}
}
