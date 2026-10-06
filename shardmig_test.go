package shardmig_test

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"shardmig"
)

func newStoreWithSrc(t *testing.T) (*shardmig.Store, *shardmig.Shard, *shardmig.Shard) {
	t.Helper()
	st := shardmig.NewStore()
	src := shardmig.NewShard("src", 1)
	dst := shardmig.NewShard("dst", 1)
	if err := st.AddShard(src, shardmig.Range{Lo: "a", Hi: "z"}); err != nil {
		t.Fatalf("AddShard: %v", err)
	}
	return st, src, dst
}

// 边界键归右区间：分裂点属于右侧区间。
func TestBoundaryKeyBelongsToRightInterval(t *testing.T) {
	left := shardmig.Range{Lo: "a", Hi: "m"}
	right := shardmig.Range{Lo: "m", Hi: "z"}

	if left.Contains("m") {
		t.Fatal("boundary key m must not belong to the left interval")
	}
	if !right.Contains("m") {
		t.Fatal("boundary key m must belong to the right interval")
	}
	if !left.Contains("a") || left.Contains("z") || right.Contains("z") {
		t.Fatal("half-open interval semantics broken")
	}
	if !left.Contains("b") || !right.Contains("y") {
		t.Fatal("interior keys misrouted")
	}
}

// 迁移期间旧分片转发，且只有新世代可提交。
func TestMigrationForwardsAndFencesOldGeneration(t *testing.T) {
	st, src, dst := newStoreWithSrc(t)

	mig, err := st.BeginMigration(src, dst, shardmig.Range{Lo: "m", Hi: "z"})
	if err != nil {
		t.Fatalf("BeginMigration: %v", err)
	}
	if mig.NewEpoch <= 1 {
		t.Fatalf("new generation must advance, got %d", mig.NewEpoch)
	}

	// 路由仍指向旧分片（由旧分片转发）。
	owner, err := st.Owner("p")
	if err != nil {
		t.Fatalf("Owner: %v", err)
	}
	if owner != src {
		t.Fatal("during migration the route must still point at the old shard")
	}

	// 旧世代提交被 fence。
	err = st.Process(shardmig.Message{ID: "old", Key: "p", Value: "x", Epoch: 1})
	if !errors.Is(err, shardmig.ErrStaleEpoch) {
		t.Fatalf("old generation must be fenced, got %v", err)
	}
	if _, ok := dst.Get("p"); ok {
		t.Fatal("fenced message must not commit")
	}

	// 新世代经旧分片转发后在新分片提交。
	if err := st.Process(shardmig.Message{ID: "new", Key: "p", Value: "v", Epoch: mig.NewEpoch}); err != nil {
		t.Fatalf("new generation must commit: %v", err)
	}
	if v, ok := dst.Get("p"); !ok || v != "v" {
		t.Fatal("forwarded message must commit on the new shard")
	}
	if _, ok := src.Get("p"); ok {
		t.Fatal("forwarded message must not commit on the old shard")
	}

	// 未迁移区间仍在旧分片按原世代提交。
	if err := st.Process(shardmig.Message{ID: "stay", Key: "b", Value: "s", Epoch: 1}); err != nil {
		t.Fatalf("unmigrated range must keep committing: %v", err)
	}
	if _, ok := src.Get("b"); !ok {
		t.Fatal("unmigrated key must commit on the old shard")
	}
}

// 已处理 ID 随区间一并迁移，迁移后重投不产生重复效果。
func TestProcessedIDsMigrateWithRange(t *testing.T) {
	st, src, dst := newStoreWithSrc(t)

	if err := st.Process(shardmig.Message{ID: "m1", Key: "p", Value: "v1", Epoch: 1}); err != nil {
		t.Fatalf("Process: %v", err)
	}

	mig, err := st.BeginMigration(src, dst, shardmig.Range{Lo: "m", Hi: "z"})
	if err != nil {
		t.Fatalf("BeginMigration: %v", err)
	}
	if err := st.Complete(mig); err != nil {
		t.Fatalf("Complete: %v", err)
	}

	if src.Processed("m1") {
		t.Fatal("processed ID must move off the old shard")
	}
	if !dst.Processed("m1") {
		t.Fatal("processed ID must migrate to the new shard")
	}
	if _, ok := src.Get("p"); ok {
		t.Fatal("data must move off the old shard")
	}
	if v, ok := dst.Get("p"); !ok || v != "v1" {
		t.Fatal("data must migrate to the new shard")
	}

	// 迁移后重投同一消息：确认但不重复生效。
	if err := st.Process(shardmig.Message{ID: "m1", Key: "p", Value: "v2", Epoch: mig.NewEpoch}); err != nil {
		t.Fatalf("redelivery must be acknowledged: %v", err)
	}
	if v, _ := dst.Get("p"); v != "v1" {
		t.Fatalf("duplicate delivery must not re-apply the effect, got %q", v)
	}
}

// 离散消息：重复投递只产生单次业务效果。
func TestDuplicateDeliverySingleEffect(t *testing.T) {
	st, src, _ := newStoreWithSrc(t)

	msg := shardmig.Message{ID: "d1", Key: "b", Value: "first", Epoch: 1}
	if err := st.Process(msg); err != nil {
		t.Fatalf("Process: %v", err)
	}
	dup := shardmig.Message{ID: "d1", Key: "b", Value: "second", Epoch: 1}
	if err := st.Process(dup); err != nil {
		t.Fatalf("duplicate must be acknowledged: %v", err)
	}
	if v, _ := src.Get("b"); v != "first" {
		t.Fatalf("effect must apply exactly once, got %q", v)
	}
}

// 中断回滚：已接受的状态完整回迁，转发清除，世代恢复。
func TestAbortMigrationRestoresCompleteState(t *testing.T) {
	st, src, dst := newStoreWithSrc(t)

	if err := st.Process(shardmig.Message{ID: "a1", Key: "p", Value: "before", Epoch: 1}); err != nil {
		t.Fatalf("Process: %v", err)
	}

	mig, err := st.BeginMigration(src, dst, shardmig.Range{Lo: "m", Hi: "z"})
	if err != nil {
		t.Fatalf("BeginMigration: %v", err)
	}
	// 迁移窗口内新分片已接受一条新世代消息。
	if err := st.Process(shardmig.Message{ID: "a2", Key: "q", Value: "during", Epoch: mig.NewEpoch}); err != nil {
		t.Fatalf("Process during migration: %v", err)
	}

	if err := st.Abort(mig); err != nil {
		t.Fatalf("Abort: %v", err)
	}

	// 状态完整：两条消息及其已处理 ID 都在旧分片上。
	for id, key := range map[string]string{"a1": "p", "a2": "q"} {
		if !src.Processed(id) {
			t.Fatalf("processed ID %s lost after abort", id)
		}
		if dst.Processed(id) {
			t.Fatalf("processed ID %s left behind on new shard", id)
		}
		if _, ok := src.Get(key); !ok {
			t.Fatalf("data for key %s lost after abort", key)
		}
		if _, ok := dst.Get(key); ok {
			t.Fatalf("data for key %s left behind on new shard", key)
		}
	}
	if dst.Epoch() != 1 {
		t.Fatalf("new shard generation must be restored, got %d", dst.Epoch())
	}

	// 转发已清除：区间内消息重新在旧分片按原世代提交。
	if err := st.Process(shardmig.Message{ID: "a3", Key: "p", Value: "after", Epoch: 1}); err != nil {
		t.Fatalf("Process after abort: %v", err)
	}
	if v, _ := src.Get("p"); v != "after" {
		t.Fatal("after abort the old shard must commit the range again")
	}
	// 回迁后重投迁移窗口内的消息：幂等，不重复生效。
	if err := st.Process(shardmig.Message{ID: "a2", Key: "q", Value: "replay", Epoch: 1}); err != nil {
		t.Fatalf("replay must be acknowledged: %v", err)
	}
	if v, _ := src.Get("q"); v != "during" {
		t.Fatalf("replayed message must not re-apply, got %q", v)
	}
}

// 中断验收：Complete 可安全重试，收敛到同一完整状态。
func TestCompleteIsIdempotentAfterInterruption(t *testing.T) {
	st, src, dst := newStoreWithSrc(t)

	if err := st.Process(shardmig.Message{ID: "c1", Key: "p", Value: "v", Epoch: 1}); err != nil {
		t.Fatalf("Process: %v", err)
	}
	mig, err := st.BeginMigration(src, dst, shardmig.Range{Lo: "m", Hi: "z"})
	if err != nil {
		t.Fatalf("BeginMigration: %v", err)
	}
	if err := st.Complete(mig); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	// 模拟确认中断后的重试。
	if err := st.Complete(mig); err != nil {
		t.Fatalf("retried Complete must succeed: %v", err)
	}

	if !dst.Processed("c1") || src.Processed("c1") {
		t.Fatal("processed IDs must migrate exactly once")
	}
	if v, ok := dst.Get("p"); !ok || v != "v" {
		t.Fatal("data must migrate exactly once")
	}

	// 路由已切换：边界键 m 归右区间（新分片），m 左侧留在旧分片。
	owner, err := st.Owner("m")
	if err != nil {
		t.Fatalf("Owner: %v", err)
	}
	if owner != dst {
		t.Fatal("boundary key m must route to the new shard after cutover")
	}
	if owner, _ := st.Owner("l"); owner != src {
		t.Fatal("key left of the boundary must stay on the old shard")
	}
	if owner, _ := st.Owner("y"); owner != dst {
		t.Fatal("key in migrated range must route to the new shard")
	}
}

// 并发重复投递：单次业务效果，状态完整（配合 -race）。
func TestConcurrentDuplicateDelivery(t *testing.T) {
	st, src, _ := newStoreWithSrc(t)

	const workers = 32
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			msg := shardmig.Message{ID: "shared", Key: "b", Value: fmt.Sprintf("w%d", i), Epoch: 1}
			if err := st.Process(msg); err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent Process: %v", err)
	}
	if !src.Processed("shared") {
		t.Fatal("message must be recorded as processed")
	}
}

// 迁移窗口内并发转发与 fence。
func TestConcurrentMigrationWindow(t *testing.T) {
	st, src, dst := newStoreWithSrc(t)

	mig, err := st.BeginMigration(src, dst, shardmig.Range{Lo: "m", Hi: "z"})
	if err != nil {
		t.Fatalf("BeginMigration: %v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := fmt.Sprintf("w%d", i)
			// 旧世代被 fence，新世代经转发提交。
			_ = st.Process(shardmig.Message{ID: id, Key: "p", Value: "old", Epoch: 1})
			if err := st.Process(shardmig.Message{ID: id, Key: "p", Value: "new", Epoch: mig.NewEpoch}); err != nil {
				t.Errorf("new generation must commit: %v", err)
			}
		}(i)
	}
	wg.Wait()

	if err := st.Complete(mig); err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if v, ok := dst.Get("p"); !ok || v != "new" {
		t.Fatalf("migrated value must come from the new generation, got %q", v)
	}
	for i := 0; i < 16; i++ {
		if !dst.Processed(fmt.Sprintf("w%d", i)) {
			t.Fatalf("processed ID w%d must migrate with the range", i)
		}
	}
}
