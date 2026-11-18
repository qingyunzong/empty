package formal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// TestRetryTimeoutInterleavingNoMixedCommit 重试与超时交错时，
// 任何参与者子集都不可能在另一部分中止的情况下提交。
func TestRetryTimeoutInterleavingNoMixedCommit(t *testing.T) {
	t.Run("eventually-commits", func(t *testing.T) {
		cl := newTestCluster(t, 4)
		tx := TxID("tx-flaky-commit")
		// 不同参与者在不同阶段交错失败，重试预算必须覆盖这些瞬时超时。
		cl.rms[0].prepareFails = 2
		cl.rms[1].prepareFails = 1
		cl.rms[2].commitFails = 3
		cl.rms[3].commitFails = 1

		outcome, err := cl.current.Run(context.Background(), tx)
		if err != nil || outcome != OutcomeCommitted {
			t.Fatalf("Run = %v, %v; want committed", outcome, err)
		}
		cl.assertUniform(tx, OutcomeCommitted)
	})

	t.Run("prepare-exhausted-aborts-all", func(t *testing.T) {
		cl := newTestCluster(t, 4)
		cl.cfg.MaxAttempts = 3
		cl.start()
		tx := TxID("tx-flaky-abort")
		// 一个参与者在整个准备阶段持续超时：赞成票永远无法集齐，必须全局中止。
		cl.rms[2].prepareFails = 100
		// 另有参与者在中止送达时也抖动，验证中止路径同样容忍交错失败。
		cl.rms[0].abortFails = 2

		outcome, _ := cl.current.Run(context.Background(), tx)
		if outcome != OutcomeAborted {
			t.Fatalf("Run = %s, want aborted", outcome)
		}
		cl.assertUniform(tx, OutcomeAborted)

		if replayed := ReplayOutcome(cl.coLog())[tx]; replayed != OutcomeAborted {
			t.Fatalf("replay = %s, want aborted", replayed)
		}
		// 任一参与者 WAL 中都不得出现提交记录。
		for _, rm := range cl.rms {
			for _, rec := range rm.rmLog(t) {
				if rec.Phase == PhaseCommit {
					t.Fatalf("participant %s logged commit inside an aborted transaction", rm.id)
				}
			}
		}
	})

	t.Run("commit-timeout-leaves-unique-committed-decision", func(t *testing.T) {
		cl := newTestCluster(t, 3)
		cl.cfg.MaxAttempts = 2
		cl.start()
		tx := TxID("tx-partial-ack")
		// 提交应答阶段持续超时：决策已持久化，确定性收尾只能是带待补应答的提交，
		// 绝不允许回退成中止。
		cl.rms[1].commitFails = 100

		outcome, err := cl.current.Run(context.Background(), tx)
		if outcome != OutcomeCommitted || !errors.Is(err, ErrPendingAcks) {
			t.Fatalf("Run = %s, %v; want committed with ErrPendingAcks", outcome, err)
		}
		if replayed := ReplayOutcome(cl.coLog())[tx]; replayed != OutcomeCommitted {
			t.Fatalf("replay = %s, want committed", replayed)
		}
		// 已应答的参与者处于提交，未应答者保持存疑；不存在任何中止状态。
		for _, rm := range cl.rms {
			if state := rm.state(t, tx); state == OutcomeAborted {
				t.Fatalf("participant %s aborted inside a committed transaction", rm.id)
			}
		}

		// 恢复故障参与者后重启协调者：重放识别提交决策并重发，补齐应答与收尾记录。
		cl.rms[1].commitFails = 0
		cl.start()
		cl.assertUniform(tx, OutcomeCommitted)
		for _, rec := range cl.coLog() {
			if rec.Phase == PhaseAbort || rec.Phase == PhaseEndAbort {
				t.Fatalf("committed transaction must never contain abort records, got %s", rec.Phase)
			}
		}
	})
}

// TestPresumedAbortOnCoordinatorRestart 协调者在准备记录后、决策前崩溃，
// 重启重放发现日志未覆盖决策点，必须推定中止并让全部参与者收敛到中止。
func TestPresumedAbortOnCoordinatorRestart(t *testing.T) {
	cl := newTestCluster(t, 3)
	tx := TxID("tx-presumed-abort")
	cl.crashAt(CrashAfterPrepareLog)

	outcome, crashed := cl.runWithCrash(tx)
	if !crashed {
		t.Fatal("expected coordinator crash after prepare log")
	}
	if outcome != OutcomeAborted {
		t.Fatalf("outcome = %s, want presumed abort", outcome)
	}
	cl.assertUniform(tx, OutcomeAborted)

	if ReplayOutcome(cl.coLog())[tx] != OutcomeAborted {
		t.Fatal("replay must derive abort from the recovered log")
	}
}

// TestFileWALTornTail 真实文件 WAL 在崩溃截断后，重放只接受 CRC 完整的帧，
// 且重新打开后可以继续追加并再次完整重放。
func TestFileWALTornTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wal.bin")
	wal, err := NewFileWAL(path)
	if err != nil {
		t.Fatalf("new file wal: %v", err)
	}
	full := []Record{
		{Tx: "t1", Phase: PhasePrepare, From: "co"},
		{Tx: "t1", Phase: PhaseCommit, From: "co"},
		{Tx: "t1", Phase: PhaseEndCommit, From: "co"},
	}
	for _, rec := range full {
		if err := wal.Append(rec); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	if err := wal.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// 手工追加一段不完整的垃圾帧，模拟宕机写穿。
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open for tear: %v", err)
	}
	if _, err := f.Write([]byte{frameMagic, byte(PhasePrepare), 0x02, 0x00}); err != nil {
		t.Fatalf("write tear: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close tear: %v", err)
	}

	wal2, err := NewFileWAL(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	recs, err := wal2.ReadAll()
	if err != nil {
		t.Fatalf("read after tear: %v", err)
	}
	if len(recs) != len(full) {
		t.Fatalf("recovered %d records, want %d", len(recs), len(full))
	}

	next := Record{Tx: "t2", Phase: PhaseAbort, From: "co"}
	if err := wal2.Append(next); err != nil {
		t.Fatalf("append after reopen: %v", err)
	}
	recs, err = wal2.ReadAll()
	if err != nil {
		t.Fatalf("final read: %v", err)
	}
	if len(recs) != len(full)+1 || recs[len(recs)-1].Tx != "t2" {
		t.Fatalf("final records = %v, want torn tail dropped plus new append", recs)
	}
	if err := wal2.Close(); err != nil {
		t.Fatalf("final close: %v", err)
	}
}

// TestReplayAcrossRestarts 多个事务交错、经历崩溃重启后，独立重放推导的
// 决议集合与协调者/所有参与者的最终状态逐事务一致，且不存在混合提交。
func TestReplayAcrossRestarts(t *testing.T) {
	cl := newTestCluster(t, 3)
	transactions := []struct {
		tx   TxID
		want Outcome
	}{
		{"multi-1", OutcomeCommitted},
		{"multi-2", OutcomeAborted},
		{"multi-3", OutcomeCommitted},
		{"multi-4", OutcomeAborted},
	}

	for i, spec := range transactions {
		if spec.want == OutcomeAborted {
			cl.rms[i%len(cl.rms)].prepareFails = 100
		}
		if i == 2 {
			cl.crashAt(CrashAfterCommitAck) // 提交路径应答期崩溃一次
		}
		outcome, _ := cl.runWithCrash(spec.tx)
		if outcome != spec.want {
			t.Fatalf("tx %s outcome = %s, want %s", spec.tx, outcome, spec.want)
		}
		for _, rm := range cl.rms {
			rm.prepareFails = 0
		}
	}

	coRecs := cl.coLog()
	replayed := ReplayOutcome(coRecs)
	for _, spec := range transactions {
		if replayed[spec.tx] != spec.want {
			t.Fatalf("replay %s = %s, want %s", spec.tx, replayed[spec.tx], spec.want)
		}
		cl.assertUniform(spec.tx, spec.want)
	}

	// 每个参与者独立重放自身 WAL，结果必须与协调者重放一致（存疑已全部解析）。
	for _, rm := range cl.rms {
		rmReplay := ReplayOutcome(rm.rmLog(t))
		for _, spec := range transactions {
			// 从未准备的参与者没有该事务日志：重放为 unknown，
			// 但其查询语义按预设中止推定返回 aborted。
			if spec.want == OutcomeAborted && rmReplay[spec.tx] == OutcomeUnknown {
				if state := rm.state(t, spec.tx); state != OutcomeAborted {
					t.Fatalf("participant %s query %s = %s, want presumed abort",
						rm.id, spec.tx, state)
				}
				continue
			}
			if rmReplay[spec.tx] != spec.want {
				t.Fatalf("participant %s replay %s = %s, want %s",
					rm.id, spec.tx, rmReplay[spec.tx], spec.want)
			}
		}
	}
}
