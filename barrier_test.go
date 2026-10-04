package barrier

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestWaitAllCompleted(t *testing.T) {
	b := New()
	if err := b.Add("a", "b", "c"); err != nil {
		t.Fatal(err)
	}
	if err := b.Complete("a", 1); err != nil {
		t.Fatal(err)
	}
	if err := b.Complete("b", "two"); err != nil {
		t.Fatal(err)
	}
	if err := b.Revoke("c"); err != nil {
		t.Fatal(err)
	}
	b.Seal()

	results, conflicts, err := b.Wait(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 {
		t.Fatalf("want 3 results, got %d", len(results))
	}
	if r := results["a"]; r.Outcome != Completed || r.Value != 1 {
		t.Errorf("a: got %+v", r)
	}
	if r := results["c"]; r.Outcome != Revoked {
		t.Errorf("c: got %+v", r)
	}
	if len(conflicts) != 0 {
		t.Errorf("unexpected conflicts: %v", conflicts)
	}
}

func TestDuplicateSameNotificationIdempotent(t *testing.T) {
	b := New()
	b.Add("a")
	if err := b.Complete("a", 42); err != nil {
		t.Fatal(err)
	}
	if err := b.Complete("a", 42); err != nil {
		t.Fatalf("same duplicate should be idempotent, got %v", err)
	}
	if err := b.Revoke("a"); err == nil {
		t.Fatal("revoke after complete with different outcome must conflict")
	}
	b.Seal()
	results, conflicts, _ := b.Wait(context.Background())
	if len(results) != 1 || results["a"].Outcome != Completed {
		t.Fatalf("each id counts once with first result: %v", results)
	}
	if len(conflicts) != 1 {
		t.Fatalf("want 1 conflict, got %d", len(conflicts))
	}
}

func TestConflictingDuplicateReported(t *testing.T) {
	b := New()
	b.Add("a", "b")
	b.Complete("a", 1)
	err := b.Complete("a", 2)
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("want ConflictError, got %v", err)
	}
	if ce.Conflict.First.Value != 1 || ce.Conflict.Second.Value != 2 {
		t.Errorf("conflict payload: %+v", ce.Conflict)
	}
	b.Revoke("b")
	if err := b.Complete("b", "x"); !errors.As(err, &ce) {
		t.Fatalf("revoke-then-complete must conflict, got %v", err)
	}
	b.Seal()
	results, conflicts, _ := b.Wait(context.Background())
	if results["a"].Value != 1 {
		t.Errorf("first result must win, got %v", results["a"].Value)
	}
	if results["b"].Outcome != Revoked {
		t.Errorf("first result must win, got %v", results["b"])
	}
	if len(conflicts) != 2 {
		t.Errorf("want 2 conflicts, got %d", len(conflicts))
	}
}

func TestAddAfterSealRejected(t *testing.T) {
	b := New()
	b.Add("a")
	b.Seal()
	if err := b.Add("b"); !errors.Is(err, ErrSealed) {
		t.Fatalf("want ErrSealed, got %v", err)
	}
	if err := b.Complete("a", nil); err != nil {
		t.Fatal(err)
	}
	results, _, err := b.Wait(context.Background())
	if err != nil || len(results) != 1 {
		t.Fatalf("sealed set must stay fixed: %v %v", results, err)
	}
}

func TestUnknownAndDuplicateID(t *testing.T) {
	b := New()
	b.Add("a")
	if err := b.Complete("zzz", nil); !errors.Is(err, ErrUnknownID) {
		t.Fatalf("want ErrUnknownID, got %v", err)
	}
	if err := b.Add("a"); !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("want ErrDuplicateID, got %v", err)
	}
	b.Complete("a", nil)
	if err := b.Add("a"); !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("terminated id still duplicate, got %v", err)
	}
}

func TestWaitBlocksUntilSealed(t *testing.T) {
	b := New()
	b.Add("a")
	b.Complete("a", 1)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, _, err := b.Wait(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unsealed set must block, got %v", err)
	}

	b.Seal()
	results, _, err := b.Wait(context.Background())
	if err != nil || len(results) != 1 {
		t.Fatalf("after seal wait must return: %v %v", results, err)
	}
}

func TestWaitContextCancel(t *testing.T) {
	b := New()
	b.Add("a")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := b.Wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}

// TestSealRace 核对封口与并发追加/通知/等待的竞争：
// Add 要么成功要么 ErrSealed，不允许 panic 或数据竞争（配合 -race）。
func TestSealRace(t *testing.T) {
	for i := 0; i < 50; i++ {
		b := New()
		b.Add("seed")
		var wg sync.WaitGroup
		for w := 0; w < 8; w++ {
			wg.Add(1)
			go func(w int) {
				defer wg.Done()
				for j := 0; j < 20; j++ {
					id := fmt.Sprintf("w%d-%d", w, j)
					err := b.Add(id)
					if errors.Is(err, ErrSealed) {
						return
					}
					if err != nil {
						t.Errorf("unexpected add error: %v", err)
						return
					}
					if err := b.Complete(id, j); err != nil {
						t.Errorf("unexpected complete error: %v", err)
						return
					}
				}
			}(w)
		}
		wg.Add(1)
		go func() { defer wg.Done(); b.Seal() }()
		wg.Wait()

		b.Complete("seed", nil)
		b.Seal()
		if _, _, err := b.Wait(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
}

// TestNoMissedWakeup 多个等待者在任何通知前进入 Wait，
// 大量并发完成与撤销后必须全部被唤醒且结果完整。
func TestNoMissedWakeup(t *testing.T) {
	const tasks = 200
	const waiters = 16

	b := New()
	ids := make([]string, tasks)
	for i := range ids {
		ids[i] = fmt.Sprintf("t%d", i)
	}
	b.Add(ids...)

	var wg sync.WaitGroup
	errs := make([]error, waiters)
	counts := make([]int, waiters)
	for w := 0; w < waiters; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			results, _, err := b.Wait(context.Background())
			errs[w] = err
			counts[w] = len(results)
		}(w)
	}

	// 给等待者进入阻塞的时间，再并发终结所有任务。
	time.Sleep(10 * time.Millisecond)
	var done sync.WaitGroup
	for i, id := range ids {
		done.Add(1)
		go func(i int, id string) {
			defer done.Done()
			if i%3 == 0 {
				b.Revoke(id)
			} else {
				b.Complete(id, i)
			}
		}(i, id)
	}
	done.Wait()
	b.Seal()

	wg.Wait()
	for w := 0; w < waiters; w++ {
		if errs[w] != nil {
			t.Fatalf("waiter %d: %v", w, errs[w])
		}
		if counts[w] != tasks {
			t.Fatalf("waiter %d: want %d results, got %d", w, tasks, counts[w])
		}
	}
}

// TestSealedResultsFixed 封口并终结后结果固定：
// Wait 返回的是快照，之后任何重复通知都不改变已返回的结果。
func TestSealedResultsFixed(t *testing.T) {
	b := New()
	b.Add("a")
	b.Complete("a", "first")
	b.Seal()

	results1, _, _ := b.Wait(context.Background())
	b.Complete("a", "second") // 冲突，被记录但不改结果
	results2, conflicts, _ := b.Wait(context.Background())

	if results1["a"].Value != "first" || results2["a"].Value != "first" {
		t.Fatalf("results must be fixed: %v / %v", results1["a"], results2["a"])
	}
	if len(conflicts) != 1 {
		t.Fatalf("conflict must be recorded, got %v", conflicts)
	}
	results1["a"] = Result{ID: "a", Outcome: Revoked} // 修改快照不影响屏障
	results3, _, _ := b.Wait(context.Background())
	if results3["a"].Value != "first" {
		t.Fatal("Wait must return a copy")
	}
}
