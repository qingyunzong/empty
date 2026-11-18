package formal

import (
	"context"
	"errors"
	"testing"
	"time"
)

// TestHappyPath 三个参与者全部赞成时提交，日志严格按准备/决策/应答/收尾排列。
func TestHappyPath(t *testing.T) {
	cl := newTestCluster(t, 3)
	tx := TxID("tx-happy")

	outcome, err := cl.current.Run(context.Background(), tx)
	if err != nil || outcome != OutcomeCommitted {
		t.Fatalf("Run = %v, %v; want committed, nil", outcome, err)
	}
	cl.assertUniform(tx, OutcomeCommitted)

	recs := cl.coLog()
	gotPhases := make([]Phase, 0, len(recs))
	for _, rec := range recs {
		gotPhases = append(gotPhases, rec.Phase)
	}
	wantPhases := []Phase{
		PhasePrepare,
		PhaseCommit,
		PhaseCommitAck, PhaseCommitAck, PhaseCommitAck,
		PhaseEndCommit,
	}
	if len(gotPhases) != len(wantPhases) {
		t.Fatalf("phases = %v, want %v", gotPhases, wantPhases)
	}
	for i := range wantPhases {
		if gotPhases[i] != wantPhases[i] {
			t.Fatalf("phase[%d] = %s, want %s (full: %v)", i, gotPhases[i], wantPhases[i], gotPhases)
		}
	}

	// 独立重放必须推导出与运行结果相同的唯一决议。
	if got := ReplayOutcome(recs)[tx]; got != OutcomeCommitted {
		t.Fatalf("replay outcome = %s, want committed", got)
	}
}

// TestCoordinatorCrashPoints 枚举协调者全部 7 个崩溃点，逐点核对
// 重启重放后的唯一决议与每个参与者状态完全一致。
func TestCoordinatorCrashPoints(t *testing.T) {
	cases := []struct {
		name  string
		point Phase
		want  Outcome
	}{
		{"after-prepare", CrashAfterPrepareLog, OutcomeAborted},
		{"after-commit-decision", CrashAfterCommitLog, OutcomeCommitted},
		{"after-abort-decision", CrashAfterAbortLog, OutcomeAborted},
		{"after-commit-ack", CrashAfterCommitAck, OutcomeCommitted},
		{"after-abort-ack", CrashAfterAbortAck, OutcomeAborted},
		{"after-end-commit", CrashAfterEndCommit, OutcomeCommitted},
		{"after-end-abort", CrashAfterEndAbort, OutcomeAborted},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cl := newTestCluster(t, 3)
			// 中止类崩溃点需要先制造一个反对票，使事务走入中止路径。
			if tc.want == OutcomeAborted && tc.point != CrashAfterPrepareLog {
				cl.rms[2].prepareFails = 100
			}
			cl.crashAt(tc.point)

			tx := TxID("tx-crash-" + tc.name)
			outcome, crashed := cl.runWithCrash(tx)
			if !crashed {
				t.Fatalf("crash hook at %s never fired", tc.point)
			}
			if outcome != tc.want {
				t.Fatalf("post-recovery outcome = %s, want %s", outcome, tc.want)
			}

			recs := cl.coLog()
			if got := ReplayOutcome(recs)[tx]; got != tc.want {
				t.Fatalf("replay outcome = %s, want %s", got, tc.want)
			}
			cl.assertUniform(tx, tc.want)
		})
	}
}

// TestParticipantCrashRecovery 覆盖参与者在准备后、提交后崩溃，
// 重启后由协调者重试送达，最终仍得到唯一决议且无混合状态。
func TestParticipantCrashRecovery(t *testing.T) {
	t.Run("crash-after-prepare", func(t *testing.T) {
		cl := newTestCluster(t, 3)
		tx := TxID("tx-rm-crash-prepare")
		rm := cl.rms[1]
		rm.hook = func(phase Phase, _ Record) {
			if phase == PhasePrepare {
				rm.hook = nil
				// 模拟参与者进程在准备日志落盘后立即宕机并自动拉起：
				// 内存状态由 WAL 重放为存疑，后续重复准备幂等返回赞成。
				rm.restart(t)
			}
		}

		outcome, err := cl.current.Run(context.Background(), tx)
		if err != nil || outcome != OutcomeCommitted {
			t.Fatalf("outcome = %s, %v; want committed after participant restart", outcome, err)
		}
		cl.assertUniform(tx, OutcomeCommitted)
		if got := ReplayOutcome(cl.coLog())[tx]; got != OutcomeCommitted {
			t.Fatalf("replay outcome = %s, want committed", got)
		}
	})

	t.Run("crash-after-commit", func(t *testing.T) {
		cl := newTestCluster(t, 3)
		tx := TxID("tx-rm-crash-commit")
		rm := cl.rms[0]
		rm.hook = func(phase Phase, _ Record) {
			if phase == PhaseCommit {
				rm.hook = nil
				panic(crashSentinel)
			}
		}

		outcome, crashed := runWithParticipantCrash(t, cl, rm, tx)
		if !crashed || outcome != OutcomeCommitted {
			t.Fatalf("outcome = %s crashed = %v, want committed crash", outcome, crashed)
		}
		cl.assertUniform(tx, OutcomeCommitted)
		// 参与者自身 WAL 重放也必须是提交，且提交记录只有一条（重复决议幂等）。
		var commits int
		for _, rec := range rm.rmLog(t) {
			if rec.Phase == PhaseCommit {
				commits++
			}
		}
		if commits != 1 {
			t.Fatalf("participant commit records = %d, want exactly 1", commits)
		}
	})
}

// runWithParticipantCrash 容忍参与者钩子抛出的崩溃，重启参与者后由
// 协调者的重试机制继续推进事务。
func runWithParticipantCrash(t *testing.T, cl *testCluster, rm *flakyRM, tx TxID) (outcome Outcome, crashed bool) {
	t.Helper()
	func() {
		defer func() {
			if r := recover(); r != nil {
				if !errors.Is(r.(error), crashSentinel) {
					t.Fatalf("unexpected panic: %v", r)
				}
				crashed = true
				rm.restart(t)
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		outcome, _ = cl.current.Run(ctx, tx)
	}()
	if !crashed {
		return outcome, false
	}
	// 参与者与协调者都按崩溃处理：协调者从日志恢复，未送达的决议通过重试补齐。
	cl.start()
	outcome, err := cl.current.Run(context.Background(), tx)
	if err != nil {
		t.Fatalf("re-run after participant restart: %v", err)
	}
	return outcome, true
}
