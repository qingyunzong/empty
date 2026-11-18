package formal

import (
	"context"
	"errors"
	"testing"
	"time"
)

// TestInDoubtResolution 参与者停在存疑状态时，经协调者查询解析出提交决议；
// 协调者未覆盖决策点时，按预设中止推定在重试预算后本地中止。
func TestInDoubtResolution(t *testing.T) {
	t.Run("resolves-commit", func(t *testing.T) {
		cl := newTestCluster(t, 2)
		tx := TxID("tx-indoubt-commit")
		if outcome, err := cl.current.Run(context.Background(), tx); err != nil || outcome != OutcomeCommitted {
			t.Fatalf("setup Run = %v, %v", outcome, err)
		}
		// 新参与者只写准备记录，模拟停在存疑态，然后向协调者查询。
		doubt := newFlakyRM(t, "rm-doubt", nil)
		if _, err := doubt.inner.Prepare(context.Background(), tx); err != nil {
			t.Fatalf("prepare: %v", err)
		}
		got, err := doubt.inner.Resolve(context.Background(), tx, cl.current, 3, time.Millisecond)
		if err != nil || got != OutcomeCommitted {
			t.Fatalf("Resolve = %s, %v; want committed", got, err)
		}
		if state := doubt.state(t, tx); state != OutcomeCommitted {
			t.Fatalf("doubtful participant state = %s, want committed", state)
		}
	})

	t.Run("presumed-abort", func(t *testing.T) {
		cl := newTestCluster(t, 2)
		tx := TxID("tx-indoubt-abort")
		doubt := newFlakyRM(t, "rm-doubt2", nil)
		if _, err := doubt.inner.Prepare(context.Background(), tx); err != nil {
			t.Fatalf("prepare: %v", err)
		}
		// 协调者对该事务没有任何日志：查询始终 Unknown，重试预算耗尽后推定中止。
		got, err := doubt.inner.Resolve(context.Background(), tx, cl.current, 3, time.Millisecond)
		if err != nil || got != OutcomeAborted {
			t.Fatalf("Resolve = %s, %v; want presumed abort", got, err)
		}
		if state := doubt.state(t, tx); state != OutcomeAborted {
			t.Fatalf("doubtful participant state = %s, want aborted", state)
		}
		// 重复解析必须返回同一结果，不得反复改写状态。
		again, err := doubt.inner.Resolve(context.Background(), tx, cl.current, 3, time.Millisecond)
		if err != nil || again != OutcomeAborted {
			t.Fatalf("repeated Resolve = %s, %v; want aborted", again, err)
		}
	})
}

// TestDuplicateDecisionSameResult 同一事务的重复与并发 Run 调用，
// 在首个决策落盘后全部返回同一结果，且日志中决策记录唯一。
func TestDuplicateDecisionSameResult(t *testing.T) {
	cl := newTestCluster(t, 3)
	tx := TxID("tx-dup")

	first, err := cl.current.Run(context.Background(), tx)
	if err != nil || first != OutcomeCommitted {
		t.Fatalf("first Run = %v, %v", first, err)
	}
	second, err := cl.current.Run(context.Background(), tx)
	if err != nil || second != first {
		t.Fatalf("duplicate Run = %v, %v; want %s", second, err, first)
	}

	const waiters = 8
	start := make(chan struct{})
	results := make(chan Outcome, waiters)
	for i := 0; i < waiters; i++ {
		go func() {
			<-start
			out, _ := cl.current.Run(context.Background(), tx)
			results <- out
		}()
	}
	close(start)
	for i := 0; i < waiters; i++ {
		if got := <-results; got != OutcomeCommitted {
			t.Fatalf("concurrent duplicate returned %s, want committed", got)
		}
	}

	var commits, aborts int
	for _, rec := range cl.coLog() {
		switch rec.Phase {
		case PhaseCommit:
			commits++
		case PhaseAbort:
			aborts++
		}
	}
	if commits != 1 || aborts != 0 {
		t.Fatalf("decision records: commits=%d aborts=%d, want exactly one commit", commits, aborts)
	}
}

// TestIdempotentParticipantCalls 直接验证参与者重复决议返回同一结果，
// 冲突决议被明确拒绝，不会产生第二条同类型决策记录。
func TestIdempotentParticipantCalls(t *testing.T) {
	rm := newFlakyRM(t, "rm-idem", nil)
	tx := TxID("tx-idem")
	ctx := context.Background()

	if vote, err := rm.inner.Prepare(ctx, tx); err != nil || vote != VoteYes {
		t.Fatalf("first prepare = %v, %v", vote, err)
	}
	if vote, err := rm.inner.Prepare(ctx, tx); err != nil || vote != VoteYes {
		t.Fatalf("duplicate prepare = %v, %v", vote, err)
	}
	if err := rm.inner.Commit(ctx, tx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := rm.inner.Commit(ctx, tx); err != nil {
		t.Fatalf("duplicate commit must be idempotent: %v", err)
	}
	if err := rm.inner.Abort(ctx, tx); !errors.Is(err, ErrConflict) {
		t.Fatalf("abort after commit = %v, want ErrConflict", err)
	}

	other := TxID("tx-never-prepared")
	if err := rm.inner.Commit(ctx, other); !errors.Is(err, ErrNotPrepared) {
		t.Fatalf("commit without prepare = %v, want ErrNotPrepared", err)
	}
	// 预设中止推定：未准备事务的中止直接确认，不写任何日志。
	if err := rm.inner.Abort(ctx, other); err != nil {
		t.Fatalf("abort without prepare = %v, want nil", err)
	}
}
