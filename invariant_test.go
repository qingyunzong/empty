package formal

import (
	"context"
	"testing"
)

// TestInDoubtEnumeration 重放后只有「已准备、无决议」的事务被列为存疑。
func TestInDoubtEnumeration(t *testing.T) {
	rm := newFlakyRM(t, "rm-indoubt", nil)
	ctx := context.Background()

	prepared := []TxID{"d1", "d2", "d3"}
	for _, tx := range prepared {
		if _, err := rm.inner.Prepare(ctx, tx); err != nil {
			t.Fatalf("prepare %s: %v", tx, err)
		}
	}
	if err := rm.inner.Commit(ctx, "d1"); err != nil {
		t.Fatalf("commit d1: %v", err)
	}
	if err := rm.inner.Abort(ctx, "d2"); err != nil {
		t.Fatalf("abort d2: %v", err)
	}

	got := rm.inner.InDoubt()
	if len(got) != 1 || got[0] != "d3" {
		t.Fatalf("InDoubt = %v, want only [d3]", got)
	}

	// 重启重放后存疑集合保持不变，证明状态完全由 WAL 重建。
	rm.restart(t)
	got = rm.inner.InDoubt()
	if len(got) != 1 || got[0] != "d3" {
		t.Fatalf("InDoubt after restart = %v, want [d3]", got)
	}
}

// TestAssertLogInvariantsRejectsBadHistories 逐条核对不变量检查能拦住
// 决策点缺失、混合决议、无决策应答与错误收尾等非法日志。
func TestAssertLogInvariantsRejectsBadHistories(t *testing.T) {
	valid := []Record{
		{Tx: "t", Phase: PhasePrepare, From: "co"},
		{Tx: "t", Phase: PhaseCommit, From: "co"},
		{Tx: "t", Phase: PhaseCommitAck, From: "rm"},
		{Tx: "t", Phase: PhaseEndCommit, From: "co"},
	}
	if err := AssertLogInvariants(valid); err != nil {
		t.Fatalf("valid history rejected: %v", err)
	}

	bad := []struct {
		name string
		recs []Record
	}{
		{
			"ack-before-decision",
			[]Record{
				{Tx: "t", Phase: PhasePrepare, From: "co"},
				{Tx: "t", Phase: PhaseCommitAck, From: "rm"},
			},
		},
		{
			"mixed-decisions",
			[]Record{
				{Tx: "t", Phase: PhasePrepare, From: "co"},
				{Tx: "t", Phase: PhaseCommit, From: "co"},
				{Tx: "t", Phase: PhaseAbort, From: "co"},
			},
		},
		{
			"decision-without-prepare",
			[]Record{{Tx: "t", Phase: PhaseAbort, From: "co"}},
		},
		{
			"end-without-ack",
			[]Record{
				{Tx: "t", Phase: PhasePrepare, From: "co"},
				{Tx: "t", Phase: PhaseCommit, From: "co"},
				{Tx: "t", Phase: PhaseEndCommit, From: "co"},
			},
		},
		{
			"end-decision-mismatch",
			[]Record{
				{Tx: "t", Phase: PhasePrepare, From: "co"},
				{Tx: "t", Phase: PhaseAbort, From: "co"},
				{Tx: "t", Phase: PhaseAbortAck, From: "rm"},
				{Tx: "t", Phase: PhaseEndCommit, From: "co"},
			},
		},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			if err := AssertLogInvariants(tc.recs); err == nil {
				t.Fatalf("illegal history %s was accepted", tc.name)
			}
		})
	}
}

// TestReplayUnknownWhenNoDecision 只有准备记录时重放必须给出 Unknown，
// 供调用方区分「存疑」与「已决议」。
func TestReplayUnknownWhenNoDecision(t *testing.T) {
	recs := []Record{{Tx: "t", Phase: PhasePrepare, From: "rm"}}
	if got := ReplayOutcome(recs)["t"]; got != OutcomeUnknown {
		t.Fatalf("replay = %s, want unknown", got)
	}

	// 追加中止记录后，重放结果从 unknown 收敛为 aborted，且后续 prepare 不覆盖。
	recs = append(recs,
		Record{Tx: "t", Phase: PhaseAbort, From: "co"},
		Record{Tx: "t", Phase: PhasePrepare, From: "rm"},
	)
	if got := ReplayOutcome(recs)["t"]; got != OutcomeAborted {
		t.Fatalf("replay = %s, want aborted", got)
	}
}

// TestMemWALClosedRejectsAppend 关闭后的内存日志拒绝写入，防止复活旧日志。
func TestMemWALClosedRejectsAppend(t *testing.T) {
	wal := NewMemWAL(nil)
	if err := wal.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := wal.Append(Record{Tx: "t", Phase: PhasePrepare}); err == nil {
		t.Fatal("append on closed MemWAL must fail")
	}
}
