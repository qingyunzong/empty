package shardmig

import (
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"
)

// setKV 返回一个把 key 置为 val 的业务效果。
func setKV(key, val string) Effect {
	return func(kv map[string]string) error {
		kv[key] = val
		return nil
	}
}

// bump 返回一个把 key 的整数值加一的业务效果，用于统计生效次数。
func bump(key string) Effect {
	return func(kv map[string]string) error {
		n, _ := strconv.Atoi(kv[key])
		kv[key] = strconv.Itoa(n + 1)
		return nil
	}
}

// mustAccept 按当前路由验收消息，失败即终止测试。
func mustAccept(t *testing.T, c *Cluster, msg Message) {
	t.Helper()
	shardID, gen, err := c.Route(msg.Key)
	if err != nil {
		t.Fatalf("Route(%q): %v", msg.Key, err)
	}
	if err := c.Accept(shardID, gen, msg); err != nil {
		t.Fatalf("Accept(%q via %s gen=%d): %v", msg.Key, shardID, gen, err)
	}
}

// 边界键归右区间：等于分割点的键属于右侧区间。
func TestBoundaryKeyBelongsToRightInterval(t *testing.T) {
	if (Range{Start: "a", End: "m"}).Contains("m") {
		t.Fatal("left interval must not contain its End boundary")
	}
	if !(Range{Start: "m", End: "z"}).Contains("m") {
		t.Fatal("right interval must contain its Start boundary")
	}

	c := NewCluster()
	if _, err := c.AddShard("left", Range{Start: "", End: "m"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddShard("right", Range{Start: "m", End: ""}); err != nil {
		t.Fatal(err)
	}

	for key, want := range map[string]string{"a": "left", "lzzz": "left", "m": "right", "m0": "right", "zz": "right"} {
		got, _, err := c.Route(key)
		if err != nil {
			t.Fatalf("Route(%q): %v", key, err)
		}
		if got != want {
			t.Fatalf("Route(%q) = %s, want %s", got, want, want)
		}
	}
}

// 迁移把区间内的 KV 状态与已处理 ID 一并搬到新分片。
func TestMigrateMovesStateAndProcessedIDs(t *testing.T) {
	c := NewCluster()
	from, err := c.AddShard("A", Range{Start: "", End: ""})
	if err != nil {
		t.Fatal(err)
	}
	to, err := c.AddShard("B")
	if err != nil {
		t.Fatal(err)
	}

	mustAccept(t, c, Message{ID: "m-in", Key: "e", Apply: setKV("e", "1")})
	mustAccept(t, c, Message{ID: "m-out", Key: "x", Apply: setKV("x", "9")})

	mig, err := c.BeginMigration("A", "B", Range{Start: "d", End: "h"})
	if err != nil {
		t.Fatal(err)
	}
	if err := mig.Commit(); err != nil {
		t.Fatal(err)
	}

	if _, ok := from.Get("e"); ok {
		t.Fatal("source still holds migrated key e")
	}
	if from.Processed("m-in") {
		t.Fatal("source still holds migrated processed ID")
	}
	if v, _ := to.Get("e"); v != "1" {
		t.Fatalf("target missing migrated state, got %q", v)
	}
	if !to.Processed("m-in") {
		t.Fatal("target missing migrated processed ID")
	}
	// 区间外的状态与已处理 ID 留在旧分片。
	if v, _ := from.Get("x"); v != "9" {
		t.Fatalf("source lost out-of-range state, got %q", v)
	}
	if !from.Processed("m-out") {
		t.Fatal("source lost out-of-range processed ID")
	}

	// 迁移后路由指向新分片。
	if id, _, err := c.Route("e"); err != nil || id != "B" {
		t.Fatalf("Route(e) = %q, %v; want B", id, err)
	}
	if id, _, err := c.Route("x"); err != nil || id != "A" {
		t.Fatalf("Route(x) = %q, %v; want A", id, err)
	}

	// 已迁移的已处理 ID 重投到新分片：不产生第二次业务效果。
	mustAccept(t, c, Message{ID: "m-in", Key: "e", Apply: setKV("e", "2")})
	if v, _ := to.Get("e"); v != "1" {
		t.Fatalf("duplicate message caused a second effect, got %q", v)
	}
}

// 迁移期间：旧分片转发，且只有新世代可以提交。
func TestForwardingAndNewGenerationDuringMigration(t *testing.T) {
	c := NewCluster()
	if _, err := c.AddShard("A", Range{Start: "", End: ""}); err != nil {
		t.Fatal(err)
	}
	to, err := c.AddShard("B")
	if err != nil {
		t.Fatal(err)
	}

	oldGen := to.Generation()
	mig, err := c.BeginMigration("A", "B", Range{Start: "d", End: "h"})
	if err != nil {
		t.Fatal(err)
	}
	// 不 Commit：处于“迁移期间”，路由表仍指向旧分片。

	id, gen, err := c.Route("e")
	if err != nil {
		t.Fatal(err)
	}
	if id != "A" {
		t.Fatalf("before Commit, Route(e) = %s, want A", id)
	}

	// 旧世代直接提交到新分片：必须被拒绝。
	err = c.Accept("B", oldGen, Message{ID: "stale", Key: "e", Apply: setKV("e", "bad")})
	if !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale generation commit = %v, want ErrStaleGeneration", err)
	}
	if _, ok := to.Get("e"); ok {
		t.Fatal("stale generation commit took effect")
	}

	// 客户端仍拿旧路由把消息发给旧分片：旧分片转发，以新世代提交成功。
	if err := c.Accept("A", gen, Message{ID: "fwd", Key: "e", Apply: setKV("e", "ok")}); err != nil {
		t.Fatalf("forwarded accept: %v", err)
	}
	if v, _ := to.Get("e"); v != "ok" {
		t.Fatalf("forwarded message not committed on target, got %q", v)
	}
	if _, ok := to.cluster.shards["A"].Get("e"); ok {
		t.Fatal("forwarded message must not be committed on source")
	}

	if err := mig.Commit(); err != nil {
		t.Fatal(err)
	}
}

// 迁移完成后，迟到的旧路由请求仍被旧分片转发到新分片。
func TestLateRequestForwardedAfterCommit(t *testing.T) {
	c := NewCluster()
	if _, err := c.AddShard("A", Range{Start: "", End: ""}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddShard("B"); err != nil {
		t.Fatal(err)
	}
	mig, err := c.BeginMigration("A", "B", Range{Start: "d", End: "h"})
	if err != nil {
		t.Fatal(err)
	}
	if err := mig.Commit(); err != nil {
		t.Fatal(err)
	}

	// 客户端持有迁移前的旧路由（A 及其世代），直接发给 A。
	if err := c.Accept("A", 0, Message{ID: "late", Key: "e", Apply: setKV("e", "fwd")}); err != nil {
		t.Fatalf("late accept via old shard: %v", err)
	}
	to := c.shards["B"]
	if v, _ := to.Get("e"); v != "fwd" {
		t.Fatalf("late request not forwarded, got %q", v)
	}
}

// 中断验收：提交前中断则业务效果与已处理 ID 都不落盘，
// 重试后只产生一次业务效果，状态完整。
func TestInterruptedAcceptExactlyOnce(t *testing.T) {
	c := NewCluster()
	s, err := c.AddShard("A", Range{Start: "", End: ""})
	if err != nil {
		t.Fatal(err)
	}

	boom := errors.New("injected interruption")
	fail := true
	c.SetInterruptHook(func(stage string) error {
		if fail {
			return boom
		}
		return nil
	})

	msg := Message{ID: "tx", Key: "k", Apply: bump("count")}
	if err := c.Accept("A", s.Generation(), msg); !errors.Is(err, boom) {
		t.Fatalf("interrupted accept = %v, want injected error", err)
	}
	// 中断后状态完整：没有效果、没有已处理 ID。
	if _, ok := s.Get("count"); ok {
		t.Fatal("interrupted accept left a partial effect")
	}
	if s.Processed("tx") {
		t.Fatal("interrupted accept recorded the processed ID")
	}

	// 恢复后重试同一条消息：成功；再重投：去重。
	fail = false
	if err := c.Accept("A", s.Generation(), msg); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if err := c.Accept("A", s.Generation(), msg); err != nil {
		t.Fatalf("redelivery: %v", err)
	}
	if v, _ := s.Get("count"); v != "1" {
		t.Fatalf("business effect applied %s times, want exactly 1", v)
	}
	if !s.Processed("tx") {
		t.Fatal("processed ID missing after successful accept")
	}
}

// 离散消息去重：同一 ID 重复投递只产生一次业务效果。
func TestDuplicateMessageSingleEffect(t *testing.T) {
	c := NewCluster()
	s, err := c.AddShard("A", Range{Start: "", End: ""})
	if err != nil {
		t.Fatal(err)
	}
	msg := Message{ID: "dup", Key: "k", Apply: bump("n")}
	for i := 0; i < 3; i++ {
		if err := c.Accept("A", s.Generation(), msg); err != nil {
			t.Fatal(err)
		}
	}
	if v, _ := s.Get("n"); v != "1" {
		t.Fatalf("effect applied %s times, want 1", v)
	}
}

// 并发重复投递：只产生一次业务效果（配合 -race 检查数据竞争）。
func TestConcurrentDuplicateAccepts(t *testing.T) {
	c := NewCluster()
	s, err := c.AddShard("A", Range{Start: "", End: ""})
	if err != nil {
		t.Fatal(err)
	}
	msg := Message{ID: "race", Key: "k", Apply: bump("n")}
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := c.Accept("A", s.Generation(), msg); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if v, _ := s.Get("n"); v != "1" {
		t.Fatalf("effect applied %s times, want 1", v)
	}
}

// 已处理 ID 随区间迁移后，跨分片重投仍然去重。
func TestProcessedIDsDeduplicateAcrossShards(t *testing.T) {
	c := NewCluster()
	if _, err := c.AddShard("A", Range{Start: "", End: ""}); err != nil {
		t.Fatal(err)
	}
	to, err := c.AddShard("B")
	if err != nil {
		t.Fatal(err)
	}

	mustAccept(t, c, Message{ID: "x1", Key: "e", Apply: bump("e")})

	mig, err := c.BeginMigration("A", "B", Range{Start: "d", End: "h"})
	if err != nil {
		t.Fatal(err)
	}
	if err := mig.Commit(); err != nil {
		t.Fatal(err)
	}

	// 同一条消息重投：无论走新路由还是旧分片转发，都不再生效。
	mustAccept(t, c, Message{ID: "x1", Key: "e", Apply: bump("hits")})
	if err := c.Accept("A", 0, Message{ID: "x1", Key: "e", Apply: bump("hits")}); err != nil {
		t.Fatal(err)
	}
	if v, _ := to.Get("e"); v != "1" {
		t.Fatalf("effect applied %s times after migration, want 1", v)
	}
}

// 非法与越界迁移被拒绝。
func TestMigrationValidation(t *testing.T) {
	c := NewCluster()
	if _, err := c.AddShard("A", Range{Start: "", End: "m"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddShard("B", Range{Start: "m", End: ""}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddShard("C", Range{Start: "a", End: "b"}); err == nil {
		t.Fatal("overlapping shard ranges accepted")
	}
	if _, err := c.BeginMigration("A", "B", Range{Start: "h", End: "z"}); err == nil {
		t.Fatal("migration of range not owned by source accepted")
	}
	if _, err := c.BeginMigration("A", "B", Range{Start: "h", End: "d"}); err == nil {
		t.Fatal("empty range accepted")
	}
	if _, err := c.BeginMigration("A", "nope", Range{Start: "a", End: "b"}); !errors.Is(err, ErrUnknownShard) {
		t.Fatalf("got %v, want ErrUnknownShard", err)
	}
}

// 区间内的键在迁移后仍可用新世代正常读写。
func TestAcceptAfterMigrationUsesNewGeneration(t *testing.T) {
	c := NewCluster()
	if _, err := c.AddShard("A", Range{Start: "", End: ""}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddShard("B"); err != nil {
		t.Fatal(err)
	}
	mig, err := c.BeginMigration("A", "B", Range{Start: "d", End: "h"})
	if err != nil {
		t.Fatal(err)
	}
	if err := mig.Commit(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		mustAccept(t, c, Message{ID: fmt.Sprintf("post-%d", i), Key: "e", Apply: bump("n")})
	}
	if v, _ := c.shards["B"].Get("n"); v != "5" {
		t.Fatalf("got %q, want 5", v)
	}
}
