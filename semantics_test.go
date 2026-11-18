package formal

import (
	"context"
	"testing"
)

// TestRollbackPinsInFlight 用确定性序列验证回滚语义：
// 回滚只让新请求切换到新版本，回滚前的在途请求保持原版本直到 Release，
// 且正式计数每个请求只计一次，不因切换而重复。
func TestRollbackPinsInFlight(t *testing.T) {
	v1Cfg := Config{Versions: []Version{{ID: "v1", Weight: 100}}}
	v2Cfg := Config{Versions: []Version{{ID: "v2", Weight: 100}}}

	s, err := NewSplitter(v1Cfg)
	if err != nil {
		t.Fatal(err)
	}

	a1, shadows := s.Route()
	if a1.VersionID() != "v1" || len(shadows) != 0 {
		t.Fatalf("initial route=%s shadows=%v", a1.VersionID(), shadows)
	}
	a2, _ := s.Route()
	if a2.VersionID() != "v1" {
		t.Fatalf("second route=%s want v1", a2.VersionID())
	}

	if err := s.Rollback(v2Cfg); err != nil {
		t.Fatal(err)
	}

	// 回滚后在途请求仍钉在 v1。
	if a1.VersionID() != "v1" || a2.VersionID() != "v1" {
		t.Fatalf("in-flight assignments must keep old version: %s, %s",
			a1.VersionID(), a2.VersionID())
	}

	// 新请求全部切到 v2。
	var switched []*Assignment
	for i := 0; i < 5; i++ {
		a, _ := s.Route()
		if a.VersionID() != "v2" {
			t.Fatalf("post-rollback route=%s want v2", a.VersionID())
		}
		switched = append(switched, a)
	}

	// 在途计数按“被路由时的版本”归属。
	stats := s.Stats()
	if stats.InFlight["v1"] != 2 || stats.InFlight["v2"] != 5 {
		t.Fatalf("in-flight v1=%d v2=%d, want 2 and 5",
			stats.InFlight["v1"], stats.InFlight["v2"])
	}

	a1.Release()
	a2.Release()
	for _, a := range switched {
		a.Release()
	}

	stats = s.Stats()
	if stats.Primary["v1"] != 2 || stats.Primary["v2"] != 5 {
		t.Fatalf("primary v1=%d v2=%d, want 2 and 5 (no double counting)",
			stats.Primary["v1"], stats.Primary["v2"])
	}
	for id, v := range stats.InFlight {
		if v != 0 {
			t.Fatalf("in-flight %s=%d after drain, want 0", id, v)
		}
	}
}

// TestHandlerFuncAndNoShadow 覆盖 HandlerFunc 适配器与无影子配置的派发分支。
func TestHandlerFuncAndNoShadow(t *testing.T) {
	cfg := Config{Versions: []Version{{ID: "only", Weight: 100}}}
	s, err := NewSplitter(cfg)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	h := HandlerFunc(func(_ context.Context, versionID string, req any) (any, error) {
		calls++
		if versionID != "only" {
			t.Fatalf("unexpected version %s", versionID)
		}
		return req, nil
	})
	d := NewDispatcher(s, h)
	dec := d.Dispatch(context.Background(), "ping")
	if dec.Err != nil || dec.Response != "ping" {
		t.Fatalf("dispatch decision=%+v", dec)
	}
	if len(dec.ShadowIDs) != 0 || dec.ShadowErr != nil {
		t.Fatalf("no-shadow config must have empty shadow results: %+v", dec)
	}
	dec.Assignment.Release()
	if calls != 1 {
		t.Fatalf("handler calls=%d want 1", calls)
	}

	// Close 在同步模式下应安全且立即返回。
	d.Close()
}

// TestAsyncDispatcherCloseRejectsNewWork 确保 Close 后不再派发新的异步影子。
func TestAsyncDispatcherCloseRejectsNewWork(t *testing.T) {
	s, err := NewSplitter(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	h := &recordingHandler{}
	d := NewDispatcher(s, h, WithAsyncShadow())
	d.Close()
	dec := d.Dispatch(context.Background(), "req")
	dec.Assignment.Release()

	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.shadows) != 0 {
		t.Fatalf("closed dispatcher must not launch shadow work: %d", len(h.shadows))
	}
	if len(h.primary) != 1 {
		t.Fatalf("primary dispatch still expected: %d", len(h.primary))
	}
}
