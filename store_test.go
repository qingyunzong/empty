package indexrebuild

import (
	"fmt"
	"math/rand"
	"sync"
	"testing"
)

// assertIndexMatchesMain 用主表全扫描构建基准索引，与给定索引逐项对照。
func assertIndexMatchesMain(t *testing.T, s *Store, idx *Index) {
	t.Helper()
	want := BuildIndex(s.Main().FullScan())
	if !idx.Equal(want) {
		t.Fatalf("index mismatch with main-table full scan")
	}
}

func TestRebuildMatchesFullScan(t *testing.T) {
	s := NewStore()
	s.Put("k1", "a")
	s.Put("k2", "a")
	s.Put("k3", "b")
	s.RebuildIndex(nil)
	assertIndexMatchesMain(t, s, s.currentIndex())
	if got := s.Query("a"); len(got) != 2 || got[0] != "k1" || got[1] != "k2" {
		t.Fatalf("unexpected query result: %v", got)
	}
}

// 冻结后、重放前发生的删除必须被增量重放捕获，不能漏。
func TestDeleteDuringRebuildNotMissed(t *testing.T) {
	s := NewStore()
	s.Put("victim", "x")
	s.Put("keeper", "x")

	hooks := &RebuildHooks{
		AfterFreeze: func(uint64) { s.Delete("victim") }, // 屏障：冻结与重放之间删除
	}
	s.RebuildIndex(hooks)

	if got := s.Query("x"); len(got) != 1 || got[0] != "keeper" {
		t.Fatalf("delete lost during rebuild, query x = %v", got)
	}
	assertIndexMatchesMain(t, s, s.currentIndex())
}

// 构建完成后、切换前对已有 key 的更新也必须被重放。
func TestUpdateDuringRebuildReplayed(t *testing.T) {
	s := NewStore()
	s.Put("k1", "old")

	hooks := &RebuildHooks{
		AfterBuild: func() { s.Put("k1", "new") },
	}
	s.RebuildIndex(hooks)

	if got := s.Query("old"); len(got) != 0 {
		t.Fatalf("stale value still indexed: %v", got)
	}
	if got := s.Query("new"); len(got) != 1 || got[0] != "k1" {
		t.Fatalf("update lost during rebuild: %v", got)
	}
	assertIndexMatchesMain(t, s, s.currentIndex())
}

// 用 channel 屏障确定性地把写入交错进重建各阶段之间，最后与全扫描对照。
func TestBarrierInterleavedWritesAndSwitch(t *testing.T) {
	s := NewStore()
	s.Put("a1", "A")
	s.Put("b1", "B")
	s.Put("c1", "C")

	type barrier struct{ enter, leave chan struct{} }
	newBarrier := func() barrier { return barrier{make(chan struct{}), make(chan struct{})} }
	atFreeze, atBuild, atCommit := newBarrier(), newBarrier(), newBarrier()
	block := func(b barrier) { close(b.enter); <-b.leave }

	hooks := &RebuildHooks{
		AfterFreeze:  func(uint64) { block(atFreeze) },
		AfterBuild:   func() { block(atBuild) },
		BeforeCommit: func() { block(atCommit) },
	}
	done := make(chan struct{})
	go func() { s.RebuildIndex(hooks); close(done) }()

	oldIdx := s.currentIndex()

	<-atFreeze.enter
	s.Delete("a1")    // 冻结后删除
	s.Put("b1", "B2") // 冻结后更新
	close(atFreeze.leave)

	<-atBuild.enter
	s.Put("d1", "D") // 构建期间新增
	s.Delete("c1")   // 构建期间删除
	close(atBuild.leave)

	<-atCommit.enter
	if s.currentIndex() != oldIdx {
		t.Fatal("index switched before BeforeCommit barrier released")
	}
	s.Put("e1", "E") // 切换前最后一笔写入，必须被最终重放捕获
	close(atCommit.leave)

	<-done
	if s.currentIndex() == oldIdx {
		t.Fatal("index pointer not switched after rebuild")
	}
	assertIndexMatchesMain(t, s, s.currentIndex())
	for value, want := range map[string][]string{
		"B2": {"b1"}, "D": {"d1"}, "E": {"e1"},
	} {
		if got := s.Query(value); len(got) != 1 || got[0] != want[0] {
			t.Fatalf("query %q = %v, want %v", value, got, want)
		}
	}
	for _, gone := range []string{"A", "B", "C"} {
		if got := s.Query(gone); len(got) != 0 {
			t.Fatalf("deleted/updated value %q still visible: %v", gone, got)
		}
	}
}

// 切换完成前，查询必须由旧索引服务，且旧索引持续跟进最新提交。
func TestQueriesServedByOldIndexUntilSwitch(t *testing.T) {
	s := NewStore()
	s.Put("k1", "v1")
	oldIdx := s.currentIndex()

	release := make(chan struct{})
	entered := make(chan struct{})
	hooks := &RebuildHooks{
		BeforeCommit: func() { close(entered); <-release },
	}
	done := make(chan struct{})
	go func() { s.RebuildIndex(hooks); close(done) }()

	<-entered // 重建已重放完毕、停在切换前
	s.Put("k2", "v2")
	s.Delete("k1")

	if s.currentIndex() != oldIdx {
		t.Fatal("query path switched to new index before atomic switch")
	}
	if got := s.Query("v2"); len(got) != 1 || got[0] != "k2" {
		t.Fatalf("old index not tracking live writes: %v", got)
	}
	if got := s.Query("v1"); len(got) != 0 {
		t.Fatalf("old index served deleted entry: %v", got)
	}

	close(release)
	<-done
	if s.currentIndex() == oldIdx {
		t.Fatal("switch did not happen")
	}
	assertIndexMatchesMain(t, s, s.currentIndex())
}

// 并发压力：多写者 + 反复重建，静默后在线索引与主表全扫描必须一致。
func TestConcurrentStress(t *testing.T) {
	s := NewStore()
	const writers = 4
	const opsPerWriter = 500

	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(seed))
			for i := 0; i < opsPerWriter; i++ {
				key := fmt.Sprintf("key-%d", rng.Intn(50))
				if rng.Intn(3) == 0 {
					s.Delete(key)
				} else {
					s.Put(key, fmt.Sprintf("val-%d", rng.Intn(10)))
				}
			}
		}(int64(w) + 1)
	}
	for r := 0; r < 3; r++ {
		s.RebuildIndex(nil)
	}
	wg.Wait()
	s.RebuildIndex(nil) // 静默后再重建一次并校验
	assertIndexMatchesMain(t, s, s.currentIndex())
}
