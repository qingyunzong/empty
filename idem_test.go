package idem

import (
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
)

func mustOpen(t *testing.T, dir string) *Executor {
	t.Helper()
	e, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return e
}

// 重复请求返回原决议，业务函数只执行一次。
func TestDuplicateReturnsOriginalDecision(t *testing.T) {
	e := mustOpen(t, t.TempDir())
	defer e.Close()

	key := Key{Client: "c1", Gen: 1, Seq: 1}
	var calls int
	fn := func(tx *Tx) ([]byte, error) {
		calls++
		tx.Put("balance", "100")
		return []byte("approved"), nil
	}

	d1, err := e.Do(key, fn)
	if err != nil {
		t.Fatalf("first Do: %v", err)
	}
	d2, err := e.Do(key, func(tx *Tx) ([]byte, error) {
		t.Fatal("business fn re-executed for duplicate")
		return nil, nil
	})
	if err != nil {
		t.Fatalf("duplicate Do: %v", err)
	}
	if calls != 1 {
		t.Fatalf("business fn executed %d times, want 1", calls)
	}
	if string(d1.Output) != "approved" || string(d2.Output) != "approved" {
		t.Fatalf("duplicate returned %q, want original %q", d2.Output, d1.Output)
	}
	if v, _ := e.BusinessGet("balance"); v != "100" {
		t.Fatalf("business effect = %q, want 100", v)
	}
}

// 水位仅在客户端确认后推进；未确认前重复仍返回原决议。
func TestWatermarkAdvancesOnlyOnAck(t *testing.T) {
	e := mustOpen(t, t.TempDir())
	defer e.Close()

	key := Key{Client: "c1", Gen: 1, Seq: 7}
	if _, err := e.Do(key, func(tx *Tx) ([]byte, error) { return []byte("ok"), nil }); err != nil {
		t.Fatalf("Do: %v", err)
	}
	if wm := e.Watermark("c1", 1); wm != 0 {
		t.Fatalf("watermark advanced to %d without client ack", wm)
	}
	// Un-acked record is retained: duplicate still returns the decision.
	if _, err := e.Do(key, func(tx *Tx) ([]byte, error) {
		t.Fatal("re-executed before ack")
		return nil, nil
	}); err != nil {
		t.Fatalf("duplicate before ack: %v", err)
	}
	if err := e.Ack("c1", 1, 7); err != nil {
		t.Fatalf("Ack: %v", err)
	}
	if wm := e.Watermark("c1", 1); wm != 7 {
		t.Fatalf("watermark = %d after ack, want 7", wm)
	}
}

// 低于/等于回收水位的键返回 ErrReclaimed，且绝不重新执行。
func TestBelowWatermarkReturnsReclaimedNotReexecuted(t *testing.T) {
	dir := t.TempDir()
	e := mustOpen(t, dir)

	var calls int
	fn := func(tx *Tx) ([]byte, error) {
		calls++
		return []byte("ok"), nil
	}
	for seq := uint64(1); seq <= 3; seq++ {
		if _, err := e.Do(Key{Client: "c1", Gen: 1, Seq: seq}, fn); err != nil {
			t.Fatalf("Do seq %d: %v", seq, err)
		}
	}
	if err := e.Ack("c1", 1, 2); err != nil {
		t.Fatalf("Ack: %v", err)
	}
	// Record for seq 1 physically reclaimed.
	if _, ok := e.Lookup(Key{Client: "c1", Gen: 1, Seq: 1}); ok {
		t.Fatal("record at/below watermark not reclaimed")
	}
	// Re-request below watermark: reclaimed, not re-executed.
	_, err := e.Do(Key{Client: "c1", Gen: 1, Seq: 1}, func(tx *Tx) ([]byte, error) {
		t.Fatal("re-executed below watermark")
		return nil, nil
	})
	if !errors.Is(err, ErrReclaimed) {
		t.Fatalf("err = %v, want ErrReclaimed", err)
	}
	if calls != 3 {
		t.Fatalf("business fn executed %d times, want 3", calls)
	}
	// Above watermark still executes.
	if _, err := e.Do(Key{Client: "c1", Gen: 1, Seq: 4}, fn); err != nil {
		t.Fatalf("Do seq 4: %v", err)
	}
	// Watermark survives restart; reclaimed keys stay rejected.
	e.Close()
	e = mustOpen(t, dir)
	defer e.Close()
	if _, err := e.Do(Key{Client: "c1", Gen: 1, Seq: 2}, fn); !errors.Is(err, ErrReclaimed) {
		t.Fatalf("after restart err = %v, want ErrReclaimed", err)
	}
}

// 崩溃注入缓存记录与业务提交之间：恢复后结果必须原子——
// 决议与业务效果要么都可见，要么都不可见。
func TestCrashBetweenCacheAndBusinessCommitIsAtomic(t *testing.T) {
	for _, point := range []CrashPoint{
		PointAfterDecisionRecord,
		PointAfterBusinessEffects,
	} {
		t.Run(string(point), func(t *testing.T) {
			dir := t.TempDir()
			e := mustOpen(t, dir)

			var armed atomic.Bool
			armed.Store(true)
			e.SetCrashHook(func(p CrashPoint) error {
				if p == point && armed.CompareAndSwap(true, false) {
					return errors.New("boom")
				}
				return nil
			})

			key := Key{Client: "c1", Gen: 1, Seq: 1}
			_, err := e.Do(key, func(tx *Tx) ([]byte, error) {
				tx.Put("order", "created")
				return []byte("done"), nil
			})
			if !errors.Is(err, ErrInjectedCrash) {
				t.Fatalf("err = %v, want ErrInjectedCrash", err)
			}
			// Crashed executor refuses further work.
			if _, err := e.Do(Key{Client: "c1", Gen: 1, Seq: 9}, nil); !errors.Is(err, ErrCrashed) {
				t.Fatalf("post-crash err = %v, want ErrCrashed", err)
			}
			e.Close()

			// Restart: torn transaction must leave NO trace — neither the
			// cached decision nor the business effect.
			e = mustOpen(t, dir)
			defer e.Close()
			if _, ok := e.Lookup(key); ok {
				t.Fatal("decision visible after crash before commit marker")
			}
			if _, ok := e.BusinessGet("order"); ok {
				t.Fatal("business effect visible after crash before commit marker")
			}
			// Retry with the same key re-executes and commits cleanly.
			d, err := e.Do(key, func(tx *Tx) ([]byte, error) {
				tx.Put("order", "created")
				return []byte("done"), nil
			})
			if err != nil {
				t.Fatalf("retry after recovery: %v", err)
			}
			if string(d.Output) != "done" {
				t.Fatalf("retry output = %q", d.Output)
			}
			if v, _ := e.BusinessGet("order"); v != "created" {
				t.Fatalf("business effect after retry = %q", v)
			}
		})
	}
}

// 崩溃发生在提交标记落盘之后：恢复后决议与业务效果都必须可见。
func TestCrashAfterCommitMarkerBothVisible(t *testing.T) {
	dir := t.TempDir()
	e := mustOpen(t, dir)

	var armed atomic.Bool
	armed.Store(true)
	e.SetCrashHook(func(p CrashPoint) error {
		if p == PointAfterCommit && armed.CompareAndSwap(true, false) {
			return errors.New("boom")
		}
		return nil
	})

	key := Key{Client: "c1", Gen: 1, Seq: 1}
	_, err := e.Do(key, func(tx *Tx) ([]byte, error) {
		tx.Put("order", "created")
		return []byte("done"), nil
	})
	if !errors.Is(err, ErrInjectedCrash) {
		t.Fatalf("err = %v, want ErrInjectedCrash", err)
	}
	e.Close()

	e = mustOpen(t, dir)
	defer e.Close()
	d, ok := e.Lookup(key)
	if !ok || string(d.Output) != "done" {
		t.Fatalf("decision after recovery = %q, %v", d.Output, ok)
	}
	if v, _ := e.BusinessGet("order"); v != "created" {
		t.Fatalf("business effect after recovery = %q", v)
	}
	// Duplicate after recovery returns the original decision.
	var calls int
	d2, err := e.Do(key, func(tx *Tx) ([]byte, error) {
		calls++
		return []byte("other"), nil
	})
	if err != nil || calls != 0 || string(d2.Output) != "done" {
		t.Fatalf("duplicate after recovery: out=%q calls=%d err=%v", d2.Output, calls, err)
	}
}

// 决议与水位的持久性：重启后重复仍返回原决议。
func TestDecisionSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	e := mustOpen(t, dir)
	key := Key{Client: "c1", Gen: 1, Seq: 5}
	if _, err := e.Do(key, func(tx *Tx) ([]byte, error) { return []byte("v1"), nil }); err != nil {
		t.Fatalf("Do: %v", err)
	}
	e.Close()

	e = mustOpen(t, dir)
	defer e.Close()
	d, err := e.Do(key, func(tx *Tx) ([]byte, error) {
		t.Fatal("re-executed after restart")
		return nil, nil
	})
	if err != nil || string(d.Output) != "v1" {
		t.Fatalf("after restart: out=%q err=%v", d.Output, err)
	}
}

// 世代语义：旧世代拒绝，新世代序列号空间独立。
func TestGenerationSemantics(t *testing.T) {
	e := mustOpen(t, t.TempDir())
	defer e.Close()

	fn := func(tx *Tx) ([]byte, error) { return []byte("ok"), nil }
	if _, err := e.Do(Key{Client: "c1", Gen: 2, Seq: 1}, fn); err != nil {
		t.Fatalf("gen 2: %v", err)
	}
	if _, err := e.Do(Key{Client: "c1", Gen: 1, Seq: 1}, fn); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale gen err = %v, want ErrStaleGeneration", err)
	}
	// New generation has its own sequence space and watermark.
	if err := e.Ack("c1", 2, 1); err != nil {
		t.Fatalf("Ack: %v", err)
	}
	if _, err := e.Do(Key{Client: "c1", Gen: 2, Seq: 1}, fn); !errors.Is(err, ErrReclaimed) {
		t.Fatalf("gen 2 seq 1 err = %v, want ErrReclaimed", err)
	}
	if _, err := e.Do(Key{Client: "c1", Gen: 3, Seq: 1}, fn); err != nil {
		t.Fatalf("gen 3 seq 1: %v", err)
	}
}

// 并发下同一键只执行一次。
func TestConcurrentDuplicatesExecuteOnce(t *testing.T) {
	e := mustOpen(t, t.TempDir())
	defer e.Close()

	key := Key{Client: "c1", Gen: 1, Seq: 1}
	var calls atomic.Int64
	done := make(chan error, 16)
	for i := 0; i < 16; i++ {
		go func(i int) {
			_, err := e.Do(key, func(tx *Tx) ([]byte, error) {
				calls.Add(1)
				return []byte(fmt.Sprintf("ok-%d", i)), nil
			})
			done <- err
		}(i)
	}
	for i := 0; i < 16; i++ {
		if err := <-done; err != nil {
			t.Fatalf("Do: %v", err)
		}
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("business fn executed %d times under concurrency, want 1", n)
	}
}
