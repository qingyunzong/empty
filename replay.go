package formal

import "errors"

// ReplayOutcome 仅依据 WAL 记录推导每个事务的唯一最终决议，完全不读取
// 任何进程内存状态。协调者与参与者重放同一规则，因此可交叉核对一致性。
//
// 推导规则（顺序扫描、首个决策记录生效）：
//   - 出现 Commit 记录 -> OutcomeCommitted；
//   - 否则出现 Abort 记录 -> OutcomeAborted；
//   - 只有准备记录、没有任何决策 -> OutcomeUnknown（存疑，等待解析）。
func ReplayOutcome(recs []Record) map[TxID]Outcome {
	out := make(map[TxID]Outcome)
	for _, rec := range recs {
		if existing, ok := out[rec.Tx]; ok && existing != OutcomeUnknown {
			continue
		}
		switch rec.Phase {
		case PhaseCommit:
			out[rec.Tx] = OutcomeCommitted
		case PhaseAbort:
			out[rec.Tx] = OutcomeAborted
		case PhasePrepare:
			if _, ok := out[rec.Tx]; !ok {
				out[rec.Tx] = OutcomeUnknown
			}
		}
	}
	return out
}

// AssertLogInvariants 校验协调者 WAL 内部的协议不变量，违反时返回错误：
//   - 每个事务阶段顺序合法（准备 -> 决策 -> 应答 -> 收尾）；
//   - 决策记录先于任何应答记录（日志未覆盖决策点不得应答）；
//   - 同一事务不得同时出现提交与中止决策（无混合决议）；
//   - 收尾记录只出现一次且与决策一致。
func AssertLogInvariants(recs []Record) error {
	type phaseStat struct {
		prepared bool
		decision Phase
		acks     map[Phase]bool
		end      Phase
	}
	stats := make(map[TxID]*phaseStat)
	for _, rec := range recs {
		st, ok := stats[rec.Tx]
		if !ok {
			st = &phaseStat{acks: make(map[Phase]bool)}
			stats[rec.Tx] = st
		}
		switch rec.Phase {
		case PhasePrepare:
			if st.prepared {
				return errors.New("formal: duplicate prepare record")
			}
			st.prepared = true
		case PhaseCommit, PhaseAbort:
			if !st.prepared {
				return errors.New("formal: decision logged without prepare record")
			}
			if st.decision != PhaseUnknown {
				return errors.New("formal: conflicting commit/abort decisions for one transaction")
			}
			st.decision = rec.Phase
		case PhaseCommitAck:
			if st.decision != PhaseCommit {
				return errors.New("formal: commit acknowledgement without durable commit decision")
			}
			st.acks[rec.Phase] = true
		case PhaseAbortAck:
			if st.decision != PhaseAbort {
				return errors.New("formal: abort acknowledgement without durable abort decision")
			}
			st.acks[rec.Phase] = true
		case PhaseEndCommit, PhaseEndAbort:
			want := PhaseCommit
			if rec.Phase == PhaseEndAbort {
				want = PhaseAbort
			}
			if st.decision != want {
				return errors.New("formal: end record does not match durable decision")
			}
			if st.end != PhaseUnknown {
				return errors.New("formal: duplicate end record")
			}
			if want == PhaseCommit && !st.acks[PhaseCommitAck] {
				return errors.New("formal: commit finalized without any participant acknowledgement")
			}
			st.end = rec.Phase
		default:
			return errors.New("formal: unknown record phase in wal")
		}
	}
	return nil
}
