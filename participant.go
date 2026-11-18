package formal

import (
	"context"
	"sync"
	"time"
)

// Queryer 由协调者实现，供处于存疑状态的参与者解析事务决议。
type Queryer interface {
	// Query 返回事务决议；OutcomeUnknown 表示协调者日志尚未覆盖到决策点。
	Query(ctx context.Context, tx TxID) (Outcome, error)
}

// ResourceManagerConfig 描述一个参与者（资源管理器）的构造参数。
type ResourceManagerConfig struct {
	ID  ID
	Log LogStore
	// CrashHook 在每条参与者日志持久化之后被调用，用于崩溃点枚举测试。
	CrashHook func(phase Phase, rec Record)
}

// Participant 是两阶段提交中的资源管理器。它的全部易失状态都可以由
// 自身 WAL 重放重建：准备记录之后、决议记录之前即为「存疑」状态。
type ResourceManager struct {
	id   ID
	log  LogStore
	hook func(Phase, Record)

	mu     sync.Mutex
	states map[TxID]Outcome
}

// NewResourceManager 创建参与者并立即重放日志重建状态。
func NewResourceManager(cfg ResourceManagerConfig) (*ResourceManager, error) {
	if cfg.Log == nil {
		return nil, ErrNotPrepared
	}
	p := &ResourceManager{
		id:     cfg.ID,
		log:    cfg.Log,
		hook:   cfg.CrashHook,
		states: make(map[TxID]Outcome),
	}
	if err := p.recover(); err != nil {
		return nil, err
	}
	return p, nil
}

// ID 返回参与者标识。
func (p *ResourceManager) ID() ID { return p.id }

// Prepare 执行准备阶段。重复请求是幂等的：已准备/已提交返回赞成，
// 已中止返回反对。准备记录先落盘，再返回赞成票，保证崩溃后能进入存疑态。
func (p *ResourceManager) Prepare(_ context.Context, tx TxID) (Vote, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	switch state, ok := p.states[tx]; {
	case ok && state == OutcomeAborted:
		return VoteNo, nil
	case ok && state == OutcomeCommitted:
		return VoteYes, nil
	case ok:
		// 存疑状态下收到重复准备：仍返回赞成，决议交由协调者驱动。
		return VoteYes, nil
	}

	rec := Record{Tx: tx, Phase: PhasePrepare, From: p.id}
	if err := p.log.Append(rec); err != nil {
		return VoteNo, err
	}
	p.states[tx] = OutcomeUnknown
	if p.hook != nil {
		p.hook(PhasePrepare, rec)
	}
	return VoteYes, nil
}

// Commit 执行提交决议。只有准备过的事务可被提交；重复提交幂等返回成功。
// 提交记录落盘之前不会对外确认，因此崩溃重启后状态与日志严格一致。
func (p *ResourceManager) Commit(_ context.Context, tx TxID) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	state, ok := p.states[tx]
	if !ok {
		return ErrNotPrepared
	}
	if state == OutcomeCommitted {
		return nil
	}
	if state == OutcomeAborted {
		return ErrConflict
	}

	rec := Record{Tx: tx, Phase: PhaseCommit, From: p.id}
	if err := p.log.Append(rec); err != nil {
		return err
	}
	p.states[tx] = OutcomeCommitted
	if p.hook != nil {
		p.hook(PhaseCommit, rec)
	}
	return nil
}

// Abort 执行中止决议。对从未准备过的事务按预设中止推定直接确认（不落盘）；
// 对存疑事务先持久化中止记录再确认；重复中止幂等成功。
func (p *ResourceManager) Abort(_ context.Context, tx TxID) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	state, ok := p.states[tx]
	if !ok {
		// 预设中止推定：无本地准备记录即可视为已中止。
		return nil
	}
	if state == OutcomeAborted {
		return nil
	}
	if state == OutcomeCommitted {
		return ErrConflict
	}

	rec := Record{Tx: tx, Phase: PhaseAbort, From: p.id}
	if err := p.log.Append(rec); err != nil {
		return err
	}
	p.states[tx] = OutcomeAborted
	if p.hook != nil {
		p.hook(PhaseAbort, rec)
	}
	return nil
}

// Query 返回参与者本地的事务状态。无本地记录时按预设中止推定返回中止。
func (p *ResourceManager) Query(_ context.Context, tx TxID) (Outcome, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	state, ok := p.states[tx]
	if !ok {
		return OutcomeAborted, nil
	}
	return state, nil
}

// InDoubt 返回重放后仍处于存疑状态（已准备、无决议）的事务标识。
func (p *ResourceManager) InDoubt() []TxID {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []TxID
	for tx, state := range p.states {
		if state == OutcomeUnknown {
			out = append(out, tx)
		}
	}
	return out
}

// Resolve 驱动单个存疑事务达成最终决议：向协调者查询，按答复提交或中止；
// 协调者始终未知（崩溃在决策点之前）时，依据预设中止推定在重试预算后本地中止。
// 已达成决议的事务直接返回既有结果，保证重复解析得到同一结论。
func (p *ResourceManager) Resolve(ctx context.Context, tx TxID, q Queryer, attempts int, backoff time.Duration) (Outcome, error) {
	p.mu.Lock()
	state, ok := p.states[tx]
	p.mu.Unlock()
	if ok && state != OutcomeUnknown {
		return state, nil
	}

	for i := 0; i < attempts; i++ {
		outcome, err := q.Query(ctx, tx)
		if err == nil {
			switch outcome {
			case OutcomeCommitted:
				return OutcomeCommitted, p.Commit(ctx, tx)
			case OutcomeAborted:
				return OutcomeAborted, p.Abort(ctx, tx)
			}
		}
		select {
		case <-ctx.Done():
			return OutcomeUnknown, ctx.Err()
		case <-time.After(backoff):
		}
	}

	// 协调者日志未覆盖决策点：预设中止推定，本地中止是安全且确定性的收尾。
	if err := p.Abort(ctx, tx); err != nil {
		return OutcomeUnknown, err
	}
	return OutcomeAborted, nil
}

// recover 重放参与者 WAL，重建每个事务的最新状态并返回存疑事务数。
func (p *ResourceManager) recover() error {
	recs, err := p.log.ReadAll()
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, rec := range recs {
		switch rec.Phase {
		case PhasePrepare:
			if _, ok := p.states[rec.Tx]; !ok {
				p.states[rec.Tx] = OutcomeUnknown
			}
		case PhaseCommit:
			p.states[rec.Tx] = OutcomeCommitted
		case PhaseAbort:
			p.states[rec.Tx] = OutcomeAborted
		}
	}
	return nil
}
