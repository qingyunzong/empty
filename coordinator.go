package formal

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Coordinator 侧的崩溃点枚举。每个点对应一次「日志刚落盘、下一步动作前」的宕机。
const (
	// CrashAfterPrepareLog 协调者写完准备记录后崩溃。
	CrashAfterPrepareLog Phase = PhasePrepare
	// CrashAfterCommitLog 协调者写完提交决策后崩溃（决策已不可撤销）。
	CrashAfterCommitLog Phase = PhaseCommit
	// CrashAfterAbortLog 协调者写完中止决策后崩溃。
	CrashAfterAbortLog Phase = PhaseAbort
	// CrashAfterCommitAck 协调者记录某参与者提交应答后崩溃。
	CrashAfterCommitAck Phase = PhaseCommitAck
	// CrashAfterAbortAck 协调者记录某参与者中止应答后崩溃。
	CrashAfterAbortAck Phase = PhaseAbortAck
	// CrashAfterEndCommit 协调者写完提交收尾记录后崩溃。
	CrashAfterEndCommit Phase = PhaseEndCommit
	// CrashAfterEndAbort 协调者写完中止收尾记录后崩溃。
	CrashAfterEndAbort Phase = PhaseEndAbort
)

// Participant 是协调者视角的参与者接口。实现必须保证重复请求幂等。
type Participant interface {
	ID() ID
	Prepare(ctx context.Context, tx TxID) (Vote, error)
	Commit(ctx context.Context, tx TxID) error
	Abort(ctx context.Context, tx TxID) error
}

// CoordinatorConfig 描述协调者的构造参数。
type CoordinatorConfig struct {
	ID           ID
	Log          LogStore
	Participants []Participant
	// MaxAttempts 是单次 RPC 阶段（准备/提交/中止）的最大尝试次数。
	MaxAttempts int
	// RetryBackoff 是两次尝试之间的退避时间。
	RetryBackoff time.Duration
	// CrashHook 在每条协调者日志持久化之后触发，用于崩溃点枚举测试。
	CrashHook func(phase Phase, rec Record)
}

// txnState 是单个事务的内存状态，全部字段可由 WAL 重放重建。
type txnState struct {
	cond     *sync.Cond
	decided  bool
	outcome  Outcome
	ackDone  map[ID]bool
	endPhase Phase
}

// Coordinator 实现带顺序日志与预设中止推定的两阶段提交协调者。
type Coordinator struct {
	id           ID
	log          LogStore
	participants []Participant
	maxAttempts  int
	backoff      time.Duration
	hook         func(Phase, Record)

	mu   sync.Mutex
	txns map[TxID]*txnState
}

// NewCoordinator 创建协调者并立即重放日志，继续恢复所有未收尾事务。
func NewCoordinator(ctx context.Context, cfg CoordinatorConfig) (*Coordinator, error) {
	if cfg.Log == nil || len(cfg.Participants) == 0 {
		return nil, errors.New("formal: coordinator requires a log and at least one participant")
	}
	attempts := cfg.MaxAttempts
	if attempts <= 0 {
		attempts = 3
	}
	backoff := cfg.RetryBackoff
	if backoff <= 0 {
		backoff = 10 * time.Millisecond
	}
	c := &Coordinator{
		id:           cfg.ID,
		log:          cfg.Log,
		participants: cfg.Participants,
		maxAttempts:  attempts,
		backoff:      backoff,
		hook:         cfg.CrashHook,
		txns:         make(map[TxID]*txnState),
	}
	if err := c.recover(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// Run 执行一个两阶段提交事务并返回唯一最终决议。
// 同一 tx 的并发/重复调用会在首个决议落盘后返回完全相同的结果。
func (c *Coordinator) Run(ctx context.Context, tx TxID) (Outcome, error) {
	c.mu.Lock()
	st, leader := c.beginTxn(tx)
	c.mu.Unlock()

	st.cond.L.Lock()
	if !leader {
		for !st.decided {
			st.cond.Wait()
		}
		outcome := st.outcome
		st.cond.L.Unlock()
		return outcome, nil
	}
	defer func() {
		// 即使领导者 goroutine 因下层 panic 退出，也必须唤醒等待者，避免永久阻塞。
		st.cond.L.Unlock()
		st.cond.Broadcast()
	}()

	return c.runLocked(ctx, tx, st)
}

// beginTxn 返回事务状态与本次调用是否为领导者（首个执行者）。
func (c *Coordinator) beginTxn(tx TxID) (*txnState, bool) {
	if st, ok := c.txns[tx]; ok {
		return st, false
	}
	st := &txnState{
		cond:    sync.NewCond(&sync.Mutex{}),
		ackDone: make(map[ID]bool),
	}
	c.txns[tx] = st
	return st, true
}

// runLocked 持有 st.cond.L，串行完成准备、决策与应答三个阶段。
func (c *Coordinator) runLocked(ctx context.Context, tx TxID, st *txnState) (Outcome, error) {
	if err := c.appendLog(Record{Tx: tx, Phase: PhasePrepare, From: c.id}, st); err != nil {
		return OutcomeAborted, err
	}

	allYes := true
	for _, p := range c.participants {
		vote, err := c.prepareOne(ctx, tx, p)
		if err != nil || vote != VoteYes {
			allYes = false
		}
	}

	if !allYes {
		return c.finishAbort(ctx, tx, st)
	}
	return c.finishCommit(ctx, tx, st)
}

// prepareOne 在重试预算内收集单个参与者的赞成票；超时/错误等价于反对。
func (c *Coordinator) prepareOne(ctx context.Context, tx TxID, p Participant) (Vote, error) {
	var lastErr error
	for attempt := 0; attempt < c.maxAttempts; attempt++ {
		vote, err := p.Prepare(ctx, tx)
		if err == nil {
			return vote, nil
		}
		lastErr = err
		if !sleepCtx(ctx, c.backoff) {
			return VoteNo, ctx.Err()
		}
	}
	return VoteNo, lastErr
}

// finishCommit 先把提交决策写穿日志（未覆盖决策点前绝不向任何参与者发提交），
// 再在应答阶段确定性地向所有未确认者重发提交，直到应答齐备或耗尽重试预算。
func (c *Coordinator) finishCommit(ctx context.Context, tx TxID, st *txnState) (Outcome, error) {
	if err := c.appendLog(Record{Tx: tx, Phase: PhaseCommit, From: c.id}, st); err != nil {
		// 决策记录未能确认落盘：按预设中止推定处理，不得让任何参与者提交。
		return c.finishAbort(ctx, tx, st)
	}
	st.decided = true
	st.outcome = OutcomeCommitted

	pending, err := c.deliver(ctx, tx, st, PhaseCommit)
	if err != nil {
		return OutcomeCommitted, err
	}
	if len(pending) > 0 {
		// 确定性收尾：决议唯一且已持久化为提交，未到齐的应答留给恢复/存疑解析。
		return OutcomeCommitted, errors.Join(append([]error{ErrPendingAcks}, pending...)...)
	}
	if err := c.appendLog(Record{Tx: tx, Phase: PhaseEndCommit, From: c.id}, st); err != nil {
		return OutcomeCommitted, err
	}
	st.endPhase = PhaseEndCommit
	return OutcomeCommitted, nil
}

// finishAbort 先持久化中止决策，再尽力送达中止指令。预设中止推定下，
// 缺失的参与者应答不阻止收尾：无决策记录可查时，参与者本就按中止处理。
func (c *Coordinator) finishAbort(ctx context.Context, tx TxID, st *txnState) (Outcome, error) {
	if err := c.appendLog(Record{Tx: tx, Phase: PhaseAbort, From: c.id}, st); err != nil {
		return OutcomeAborted, err
	}
	st.decided = true
	st.outcome = OutcomeAborted

	pending, err := c.deliver(ctx, tx, st, PhaseAbort)
	if err != nil {
		return OutcomeAborted, err
	}
	// 无论应答是否齐备，预设中止推定允许直接写收尾记录并给出唯一的中止决议。
	if err := c.appendLog(Record{Tx: tx, Phase: PhaseEndAbort, From: c.id}, st); err != nil {
		return OutcomeAborted, err
	}
	st.endPhase = PhaseEndAbort
	if len(pending) > 0 {
		return OutcomeAborted, errors.Join(append([]error{ErrPendingAcks}, pending...)...)
	}
	return OutcomeAborted, nil
}

// deliver 在重试预算内把决议指令送达所有尚未应答的参与者，并逐条记录应答日志。
// 返回耗尽预算后仍未确认的参与者错误；调用方据此走各自的确定性收尾规则。
func (c *Coordinator) deliver(ctx context.Context, tx TxID, st *txnState, decision Phase) ([]error, error) {
	var pending []error
	for attempt := 0; attempt < c.maxAttempts; attempt++ {
		pending = nil
		for _, p := range c.participants {
			if st.ackDone[p.ID()] {
				continue
			}
			var callErr error
			var ack Phase
			switch decision {
			case PhaseCommit:
				callErr = p.Commit(ctx, tx)
				ack = PhaseCommitAck
			default:
				callErr = p.Abort(ctx, tx)
				ack = PhaseAbortAck
			}
			if callErr != nil {
				pending = append(pending, callErr)
				continue
			}
			if err := c.appendLog(Record{Tx: tx, Phase: ack, From: p.ID()}, st); err != nil {
				pending = append(pending, err)
				continue
			}
		}
		if len(pending) == 0 {
			return nil, nil
		}
		if !sleepCtx(ctx, c.backoff) {
			return pending, ctx.Err()
		}
	}
	return pending, nil
}

// Query 返回事务决议。内存无记录或日志未到达决策点时返回 Unknown，
// 存疑参与者据此重试；这正是预设中止推定的查询语义。
func (c *Coordinator) Query(_ context.Context, tx TxID) (Outcome, error) {
	c.mu.Lock()
	st, ok := c.txns[tx]
	c.mu.Unlock()
	if !ok {
		return OutcomeUnknown, nil
	}
	st.cond.L.Lock()
	defer st.cond.L.Unlock()
	if !st.decided {
		return OutcomeUnknown, nil
	}
	return st.outcome, nil
}

// appendLog 持久化一条记录并同步更新内存事务状态中的应答集合，
// 然后触发（测试用）崩溃钩子。
func (c *Coordinator) appendLog(rec Record, st *txnState) error {
	if err := c.log.Append(rec); err != nil {
		return err
	}
	switch rec.Phase {
	case PhaseCommitAck, PhaseAbortAck:
		st.ackDone[ID(rec.From)] = true
	}
	if c.hook != nil {
		c.hook(rec.Phase, rec)
	}
	return nil
}

// sleepCtx 在退避期间响应上下文取消。
func sleepCtx(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
