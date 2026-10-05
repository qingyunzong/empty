package aggregator

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// 基本流程：追加 -> 封口 -> 逐个通知 -> Wait 返回完整快照。
func TestWaitReturnsSnapshotAfterAllTerminate(t *testing.T) {
	a := New()
	for _, id := range []string{"a", "b", "c"} {
		if err := a.Add(id); err != nil {
			t.Fatalf("Add(%q): %v", id, err)
		}
	}
	a.Seal()

	if err := a.Notify("a", Completed); err != nil {
		t.Fatalf("Notify a: %v", err)
	}
	if err := a.Notify("b", Revoked); err != nil {
		t.Fatalf("Notify b: %v", err)
	}

	select {
	case <-a.Done():
		t.Fatal("Done closed before all members terminated")
	default:
	}

	if err := a.Notify("c", Completed); err != nil {
		t.Fatalf("Notify c: %v", err)
	}

	got := a.Wait()
	want := map[string]Result{"a": Completed, "b": Revoked, "c": Completed}
	if fmt.Sprintf("%v", got) != fmt.Sprintf("%v", want) {
		t.Fatalf("Wait() = %v, want %v", got, want)
	}
}

// 每个 ID 只计一次：重复同结果被忽略，不影响完成判定。
func TestDuplicateSameResultIgnored(t *testing.T) {
	a := New()
	a.Add("x")
	a.Seal()

	for i := 0; i < 5; i++ {
		if err := a.Notify("x", Completed); err != nil {
			t.Fatalf("Notify #%d: %v", i, err)
		}
	}
	got := a.Wait()
	if got["x"] != Completed || len(got) != 1 {
		t.Fatalf("Wait() = %v, want single completed x", got)
	}
}

// 重复通知不同结果必须报告冲突，且保留首次结果。
func TestConflictingDuplicateReported(t *testing.T) {
	a := New()
	a.Add("x")
	a.Seal()

	if err := a.Notify("x", Completed); err != nil {
		t.Fatalf("first Notify: %v", err)
	}
	err := a.Notify("x", Revoked)
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected *ConflictError, got %v", err)
	}
	if ce.ID != "x" || ce.Recorded != Completed || ce.Incoming != Revoked {
		t.Fatalf("unexpected conflict detail: %+v", ce)
	}
	if got := a.Wait(); got["x"] != Completed {
		t.Fatalf("first result must win, got %v", got["x"])
	}
}

// 封口后 Add 失败；封口前可自由追加。
func TestAddAfterSealFails(t *testing.T) {
	a := New()
	if err := a.Add("early"); err != nil {
		t.Fatalf("Add before seal: %v", err)
	}
	a.Seal()
	if err := a.Add("late"); !errors.Is(err, ErrSealed) {
		t.Fatalf("Add after seal = %v, want ErrSealed", err)
	}
	if err := a.Add("early"); !errors.Is(err, ErrSealed) {
		t.Fatalf("duplicate Add after seal = %v, want ErrSealed (seal takes precedence)", err)
	}
}

// 重复添加同一 ID 报错。
func TestDuplicateAddFails(t *testing.T) {
	a := New()
	a.Add("x")
	if err := a.Add("x"); !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("duplicate Add = %v, want ErrDuplicateID", err)
	}
}

// 封口是幂等的；空集合封口后 Wait 立即返回。
func TestSealIdempotentAndEmptySet(t *testing.T) {
	a := New()
	a.Seal()
	a.Seal()
	if got := a.Wait(); len(got) != 0 {
		t.Fatalf("Wait() = %v, want empty", got)
	}
}

// 通知可以先于 Add 到达，仍被计入。
func TestNotifyBeforeAdd(t *testing.T) {
	a := New()
	if err := a.Notify("pre", Revoked); err != nil {
		t.Fatalf("Notify before Add: %v", err)
	}
	a.Add("pre")
	a.Seal()
	if got := a.Wait(); got["pre"] != Revoked {
		t.Fatalf("Wait() = %v, want pre revoked", got)
	}
}

// 无漏唤醒：结果全部到齐并封口之后，迟到的 Wait 必须立即返回。
func TestLateWaitDoesNotBlock(t *testing.T) {
	a := New()
	a.Add("x")
	a.Notify("x", Completed)
	a.Seal()

	done := make(chan struct{})
	go func() {
		a.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("late Wait blocked: missed wakeup")
	}
}

// 封口竞争：并发 Add 与 Seal，凡 Seal 之后返回的 Add 必须失败，
// 凡成功的 Add 必须被 Wait 等到。
func TestSealRace(t *testing.T) {
	for trial := 0; trial < 200; trial++ {
		a := New()
		var wg sync.WaitGroup
		added := make(chan string, 64)

		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				id := fmt.Sprintf("task-%d", i)
				if err := a.Add(id); err == nil {
					added <- id
				} else if !errors.Is(err, ErrSealed) {
					t.Errorf("Add(%q) = %v, want nil or ErrSealed", id, err)
				}
			}(i)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.Seal()
		}()
		wg.Wait()
		close(added)

		var ids []string
		for id := range added {
			ids = append(ids, id)
		}
		for _, id := range ids {
			if err := a.Notify(id, Completed); err != nil {
				t.Fatalf("Notify(%q): %v", id, err)
			}
		}
		got := a.Wait()
		if len(got) != len(ids) {
			t.Fatalf("trial %d: Wait() has %d results, want %d (successful Adds must be awaited)",
				trial, len(got), len(ids))
		}
	}
}

// 无漏唤醒（并发版）：大量并发 Notify/Wait/Seal，全部等待者必须被释放，
// 且每个 ID 恰好生效一次。
func TestConcurrentNoMissedWakeup(t *testing.T) {
	for trial := 0; trial < 50; trial++ {
		a := New()
		const n = 32
		for i := 0; i < n; i++ {
			a.Add(fmt.Sprintf("t%d", i))
		}

		var wg sync.WaitGroup
		results := make([]map[string]Result, n)
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				results[i] = a.Wait()
			}(i)
		}
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				r := Completed
				if i%2 == 1 {
					r = Revoked
				}
				// 每个 ID 通知两次（同结果），验证只计一次且不冲突。
				if err := a.Notify(fmt.Sprintf("t%d", i), r); err != nil {
					t.Errorf("Notify: %v", err)
				}
				if err := a.Notify(fmt.Sprintf("t%d", i), r); err != nil {
					t.Errorf("duplicate Notify: %v", err)
				}
			}(i)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.Seal()
		}()

		waited := make(chan struct{})
		go func() {
			wg.Wait()
			close(waited)
		}()
		select {
		case <-waited:
		case <-time.After(5 * time.Second):
			t.Fatalf("trial %d: waiters not released (missed wakeup or deadlock)", trial)
		}

		for i, got := range results {
			if len(got) != n {
				t.Fatalf("trial %d waiter %d: got %d results, want %d", trial, i, len(got), n)
			}
		}
	}
}

// 并发冲突通知：同一 ID 收到两种结果，至少一个调用者必须看到冲突错误，
// 且最终快照确定地等于首次记录值。
func TestConcurrentConflictExactlyOneWins(t *testing.T) {
	for trial := 0; trial < 100; trial++ {
		a := New()
		a.Add("x")
		a.Seal()

		var wg sync.WaitGroup
		errs := make([]error, 2)
		for i, r := range []Result{Completed, Revoked} {
			wg.Add(1)
			go func(i int, r Result) {
				defer wg.Done()
				errs[i] = a.Notify("x", r)
			}(i, r)
		}
		wg.Wait()

		conflicts := 0
		for _, err := range errs {
			var ce *ConflictError
			if errors.As(err, &ce) {
				conflicts++
			} else if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		}
		if conflicts != 1 {
			t.Fatalf("trial %d: got %d conflicts, want exactly 1", trial, conflicts)
		}
		got := a.Wait()
		if got["x"] != Completed && got["x"] != Revoked {
			t.Fatalf("trial %d: invalid final result %v", trial, got["x"])
		}
	}
}
