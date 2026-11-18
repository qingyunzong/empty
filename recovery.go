package formal

import (
	"context"
	"errors"
	"sync"
)

// recover 重放协调者 WAL 并确定性收尾每个事务：
//   - 无决策记录：补写中止决策（预设中止推定），再走完中止应答；
//   - 有决策无收尾：按既有决策重发指令，补齐应答并写收尾记录；
//   - 已有收尾记录：仅重建内存状态，不产生任何重复决议。
func (c *Coordinator) recover(ctx context.Context) error {
	recs, err := c.log.ReadAll()
	if err != nil {
		return err
	}

	order := make([]TxID, 0)
	replayed := make(map[TxID]*txnState)
	for _, rec := range recs {
		st, ok := replayed[rec.Tx]
		if !ok {
			st = &txnState{cond: sync.NewCond(&sync.Mutex{}), ackDone: make(map[ID]bool)}
			replayed[rec.Tx] = st
			order = append(order, rec.Tx)
		}
		switch rec.Phase {
		case PhaseCommit:
			st.decided = true
			st.outcome = OutcomeCommitted
		case PhaseAbort:
			st.decided = true
			st.outcome = OutcomeAborted
		case PhaseCommitAck, PhaseAbortAck:
			st.ackDone[ID(rec.From)] = true
		case PhaseEndCommit:
			st.endPhase = PhaseEndCommit
		case PhaseEndAbort:
			st.endPhase = PhaseEndAbort
		}
	}

	var errs []error
	for _, tx := range order {
		st := replayed[tx]
		c.txns[tx] = st
		if st.endPhase != PhaseUnknown {
			continue
		}
		st.cond.L.Lock()
		var recErr error
		switch {
		case !st.decided:
			// 日志未覆盖决策点：预设中止推定，补一条中止决策并收尾。
			_, recErr = c.finishAbort(ctx, tx, st)
		case st.outcome == OutcomeCommitted:
			_, recErr = c.finishRecovered(ctx, tx, st, PhaseCommit)
		default:
			_, recErr = c.finishRecovered(ctx, tx, st, PhaseAbort)
		}
		st.cond.L.Unlock()
		if recErr != nil {
			errs = append(errs, recErr)
		}
	}
	return errors.Join(errs...)
}

// finishRecovered 为已决策但未收尾的事务续跑应答阶段，并补写收尾记录。
func (c *Coordinator) finishRecovered(ctx context.Context, tx TxID, st *txnState, decision Phase) (Outcome, error) {
	pending, err := c.deliver(ctx, tx, st, decision)
	if err != nil {
		if decision == PhaseCommit {
			return OutcomeCommitted, err
		}
		return OutcomeAborted, err
	}

	end := PhaseEndAbort
	outcome := OutcomeAborted
	if decision == PhaseCommit {
		end = PhaseEndCommit
		outcome = OutcomeCommitted
	}

	// 提交路径应答不齐时保持已持久化的提交决议，等待下一轮恢复或参与者存疑解析。
	if decision == PhaseCommit && len(pending) > 0 {
		return OutcomeCommitted, errors.Join(append([]error{ErrPendingAcks}, pending...)...)
	}

	if err := c.appendLog(Record{Tx: tx, Phase: end, From: c.id}, st); err != nil {
		return outcome, err
	}
	st.endPhase = end
	if len(pending) > 0 {
		return outcome, errors.Join(append([]error{ErrPendingAcks}, pending...)...)
	}
	return outcome, nil
}
