package formal

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
)

// RunState is the single terminal state of one execution.
type RunState string

const (
	RunSucceeded  RunState = "succeeded"
	RunFailed     RunState = "failed"
	RunSuperseded RunState = "superseded"
)

// NodeState is the state of one node in a completed execution.
type NodeState string

const (
	NodePending            NodeState = "pending"
	NodeRunning            NodeState = "running"
	NodeSucceeded          NodeState = "succeeded"
	NodeFailed             NodeState = "failed"
	NodeSkipped            NodeState = "skipped"
	NodeRollingBack        NodeState = "rolling-back"
	NodeCompensated        NodeState = "compensated"
	NodeCompensationFailed NodeState = "compensation-failed"
	NodeRetained           NodeState = "retained"
)

// NodeReport describes the outcome of one node.
type NodeReport struct {
	ID          string
	Action      Action
	Reversible  bool
	State       NodeState
	Effected    bool
	Err         error
	RollbackErr error
}

// Report is an immutable snapshot of a completed execution. Nodes are ordered
// topologically, with node ID as the tie-breaker.
type Report struct {
	PlanID             string
	Generation         uint64
	State              RunState
	Nodes              []NodeReport
	Err                error
	CompensationErrors []error
}

// Node returns the report for id.
func (r Report) Node(id string) (NodeReport, bool) {
	for _, n := range r.Nodes {
		if n.ID == id {
			return n, true
		}
	}
	return NodeReport{}, false
}

// TraceKind identifies an event in a Run's ordered trace.
type TraceKind string

const (
	TraceApplyStarted      TraceKind = "apply-started"
	TraceApplySucceeded    TraceKind = "apply-succeeded"
	TraceApplyFailed       TraceKind = "apply-failed"
	TraceSkipped           TraceKind = "skipped"
	TraceRetained          TraceKind = "retained"
	TraceRollbackStarted   TraceKind = "rollback-started"
	TraceRollbackSucceeded TraceKind = "rollback-succeeded"
	TraceRollbackFailed    TraceKind = "rollback-failed"
	TraceRunSettled        TraceKind = "run-settled"
)

// TraceEvent is one scheduler event. Seq is monotonic within a Run.
type TraceEvent struct {
	Seq        uint64
	Kind       TraceKind
	NodeID     string
	Generation uint64
	Effected   bool
	Err        error
}

// Executor starts generation-fenced executions of Plans.
type Executor struct {
	backend Backend

	mu     sync.Mutex
	latest map[string]uint64
	active map[string]*Run

	rejected atomic.Uint64
}

// NewExecutor builds an Executor backed by b.
func NewExecutor(b Backend) (*Executor, error) {
	if b == nil {
		return nil, errors.New("formal: nil backend")
	}
	return &Executor{
		backend: b,
		latest:  make(map[string]uint64),
		active:  make(map[string]*Run),
	}, nil
}

// Start validates plan, fences any older run of the same operation, and starts
// executing it. A generation must be strictly newer than every generation
// previously started for that operation ID.
func (e *Executor) Start(ctx context.Context, plan Plan) (*Run, error) {
	cp, err := compilePlan(plan)
	if err != nil {
		return nil, err
	}
	if ctx == nil {
		ctx = context.Background()
	}

	runCtx, cancel := context.WithCancel(ctx)
	r := &Run{
		exec:   e,
		plan:   cp,
		ctx:    runCtx,
		cancel: cancel,
		events: make(chan runEvent, len(cp.nodes)*4+8),
		done:   make(chan struct{}),
	}

	e.mu.Lock()
	if last, ok := e.latest[cp.id]; ok && cp.generation <= last {
		e.mu.Unlock()
		cancel()
		return nil, fmt.Errorf("%w: plan %q generation %d is not newer than %d",
			ErrStaleGeneration, cp.id, cp.generation, last)
	}
	prev := e.active[cp.id]
	e.latest[cp.id] = cp.generation
	e.active[cp.id] = r
	e.mu.Unlock()

	if prev != nil {
		prev.supersede()
	}
	go r.loop()
	return r, nil
}

// Execute starts plan and waits for it to settle.
func (e *Executor) Execute(ctx context.Context, plan Plan) (Report, error) {
	r, err := e.Start(ctx, plan)
	if err != nil {
		return Report{}, err
	}
	return r.Wait(ctx)
}

// RejectedCallbacks counts completions dropped because they belonged to a
// generation that is no longer current.
func (e *Executor) RejectedCallbacks() uint64 {
	return e.rejected.Load()
}

func (e *Executor) admits(planID string, generation uint64) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.latest[planID] == generation
}

func (e *Executor) finish(r *Run) {
	e.mu.Lock()
	if e.active[r.plan.id] == r {
		delete(e.active, r.plan.id)
	}
	e.mu.Unlock()
}

// Run is one generation of one operation. Wait returns its unique terminal
// report.
type Run struct {
	exec   *Executor
	plan   *compiledPlan
	ctx    context.Context
	cancel context.CancelFunc
	events chan runEvent
	done   chan struct{}

	mu         sync.Mutex
	superseded bool
	settled    bool
	report     Report
	trace      []TraceEvent
	seq        uint64
}

type runEventKind int

const (
	eventApplyDone runEventKind = iota
	eventSupersede
)

type runEvent struct {
	kind       runEventKind
	nodeID     string
	generation uint64
	outcome    ApplyOutcome
}

// PlanID returns the logical operation ID.
func (r *Run) PlanID() string { return r.plan.id }

// Generation returns the operation generation of this run.
func (r *Run) Generation() uint64 { return r.plan.generation }

// Done is closed when the run has reached its terminal state.
func (r *Run) Done() <-chan struct{} { return r.done }

// Wait blocks until the run settles or ctx is cancelled. Repeated calls return
// the same terminal report.
func (r *Run) Wait(ctx context.Context) (Report, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-r.done:
		return r.snapshot(), nil
	default:
	}
	select {
	case <-r.done:
		return r.snapshot(), nil
	case <-ctx.Done():
		return Report{}, ctx.Err()
	}
}

// Trace returns a copy of all scheduler events recorded so far.
func (r *Run) Trace() []TraceEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]TraceEvent(nil), r.trace...)
}

func (r *Run) snapshot() Report {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.report
	out.Nodes = append([]NodeReport(nil), r.report.Nodes...)
	out.CompensationErrors = append([]error(nil), r.report.CompensationErrors...)
	return out
}

func (r *Run) supersede() {
	r.mu.Lock()
	r.superseded = true
	r.mu.Unlock()
	r.cancel()
	select {
	case r.events <- runEvent{kind: eventSupersede}:
	default:
	}
}

func (r *Run) wasSuperseded() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.superseded
}

func (r *Run) addTrace(ev TraceEvent) {
	r.mu.Lock()
	r.seq++
	ev.Seq = r.seq
	ev.Generation = r.plan.generation
	r.trace = append(r.trace, ev)
	r.mu.Unlock()
}

type runtimeNode struct {
	spec      *compiledNode
	state     NodeState
	effected  bool
	token     any
	err       error
	rbErr     error
	remaining int
}

func (r *Run) loop() {
	nodes := make(map[string]*runtimeNode, len(r.plan.order))
	for _, cn := range r.plan.order {
		nodes[cn.id] = &runtimeNode{
			spec:      cn,
			state:     NodePending,
			remaining: len(cn.deps),
		}
	}

	inFlight := 0
	succeeded := 0
	failure := false
	var primary error
	var rollbackErrs []error

	dispatch := func(n *runtimeNode) {
		n.state = NodeRunning
		inFlight++
		r.addTrace(TraceEvent{Kind: TraceApplyStarted, NodeID: n.spec.id})

		req := ApplyRequest{
			PlanID:     r.plan.id,
			Generation: r.plan.generation,
			Node: Node{
				ID:         n.spec.id,
				Action:     n.spec.action,
				Deps:       append([]string(nil), n.spec.depIDs...),
				Reversible: n.spec.reversible,
			},
		}
		go func() {
			var once sync.Once
			done := func(out ApplyOutcome) {
				once.Do(func() {
					if !r.exec.admits(r.plan.id, r.plan.generation) {
						r.exec.rejected.Add(1)
						return
					}
					select {
					case r.events <- runEvent{
						kind:       eventApplyDone,
						nodeID:     n.spec.id,
						generation: r.plan.generation,
						outcome:    out,
					}:
					case <-r.done:
					}
				})
			}
			defer func() {
				if p := recover(); p != nil {
					done(ApplyOutcome{Err: fmt.Errorf("formal: backend panic: %v", p)})
				}
			}()
			if err := r.exec.backend.Apply(r.ctx, req, done); err != nil {
				done(ApplyOutcome{Err: err})
			}
		}()
	}

	skipPending := func() {
		for _, cn := range r.plan.order {
			n := nodes[cn.id]
			if n.state != NodePending {
				continue
			}
			n.state = NodeSkipped
			r.addTrace(TraceEvent{Kind: TraceSkipped, NodeID: cn.id})
		}
	}

	beginFailure := func(err error) {
		if failure {
			return
		}
		failure = true
		primary = err
		skipPending()
	}

	for _, cn := range r.plan.order {
		if len(cn.deps) == 0 {
			dispatch(nodes[cn.id])
		}
	}

	ctxDone := r.ctx.Done()
	for {
		select {
		case ev := <-r.events:
			switch ev.kind {
			case eventSupersede:
				r.settleSuperseded(nodes)
				return
			case eventApplyDone:
				if ev.generation != r.plan.generation {
					r.exec.rejected.Add(1)
					continue
				}
				n, ok := nodes[ev.nodeID]
				if !ok || n.state != NodeRunning {
					continue
				}
				inFlight--
				n.effected = ev.outcome.Effected || ev.outcome.Err == nil
				n.token = ev.outcome.Token
				if ev.outcome.Err == nil {
					n.state = NodeSucceeded
					succeeded++
					r.addTrace(TraceEvent{
						Kind:     TraceApplySucceeded,
						NodeID:   n.spec.id,
						Effected: n.effected,
					})
					if !failure && !r.wasSuperseded() && r.ctx.Err() == nil {
						for _, d := range n.spec.dependents {
							dn := nodes[d.id]
							if dn.state != NodePending {
								continue
							}
							dn.remaining--
							if dn.remaining == 0 {
								dispatch(dn)
							}
						}
					}
				} else {
					n.err = ev.outcome.Err
					n.state = NodeFailed
					r.addTrace(TraceEvent{
						Kind:     TraceApplyFailed,
						NodeID:   n.spec.id,
						Effected: n.effected,
						Err:      ev.outcome.Err,
					})
					beginFailure(ev.outcome.Err)
				}
			}
		case <-ctxDone:
			ctxDone = nil
			if r.wasSuperseded() {
				r.settleSuperseded(nodes)
				return
			}
			beginFailure(r.ctx.Err())
		}

		if r.wasSuperseded() {
			r.settleSuperseded(nodes)
			return
		}
		if failure && inFlight == 0 {
			r.compensate(nodes, &rollbackErrs)
			r.settle(RunFailed, nodes, primary, rollbackErrs)
			return
		}
		if !failure && succeeded == len(nodes) {
			r.settle(RunSucceeded, nodes, nil, nil)
			return
		}
	}
}

func (r *Run) compensate(nodes map[string]*runtimeNode, rollbackErrs *[]error) {
	// Compensation follows reverse topological order: every dependent was
	// applied before its dependencies and is undone before them. A node may be
	// rolled back only if every effective dependent has already been rolled
	// back successfully; otherwise undoing it could destroy unmanaged state.
	for i := len(r.plan.order) - 1; i >= 0; i-- {
		if r.wasSuperseded() {
			return
		}
		cn := r.plan.order[i]
		n := nodes[cn.id]
		if !n.effected {
			continue
		}
		if !n.spec.reversible {
			n.state = NodeRetained
			r.addTrace(TraceEvent{Kind: TraceRetained, NodeID: cn.id, Effected: true})
			continue
		}
		blocked := false
		for _, d := range cn.dependents {
			dependent := nodes[d.id]
			if dependent.effected && dependent.state != NodeCompensated {
				blocked = true
				break
			}
		}
		if blocked {
			n.state = NodeRetained
			r.addTrace(TraceEvent{Kind: TraceRetained, NodeID: cn.id, Effected: true})
			continue
		}

		n.state = NodeRollingBack
		r.addTrace(TraceEvent{Kind: TraceRollbackStarted, NodeID: cn.id, Effected: true})
		req := RollbackRequest{
			PlanID:     r.plan.id,
			Generation: r.plan.generation,
			Node: Node{
				ID:         cn.id,
				Action:     cn.action,
				Deps:       append([]string(nil), cn.depIDs...),
				Reversible: cn.reversible,
			},
			Token: n.token,
		}
		err := r.rollback(req)
		if err != nil {
			n.state = NodeCompensationFailed
			n.rbErr = err
			*rollbackErrs = append(*rollbackErrs, fmt.Errorf("rollback %q: %w", cn.id, err))
			r.addTrace(TraceEvent{
				Kind:     TraceRollbackFailed,
				NodeID:   cn.id,
				Effected: true,
				Err:      err,
			})
			continue
		}
		n.state = NodeCompensated
		r.addTrace(TraceEvent{Kind: TraceRollbackSucceeded, NodeID: cn.id, Effected: true})
	}
}

func (r *Run) rollback(req RollbackRequest) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("formal: backend rollback panic: %v", p)
		}
	}()
	return r.exec.backend.Rollback(context.WithoutCancel(r.ctx), req)
}

func (r *Run) settleSuperseded(nodes map[string]*runtimeNode) {
	for _, cn := range r.plan.order {
		n := nodes[cn.id]
		switch n.state {
		case NodePending, NodeRunning:
			n.state = NodeSkipped
			r.addTrace(TraceEvent{Kind: TraceSkipped, NodeID: cn.id})
		}
	}
	r.settle(RunSuperseded, nodes, nil, nil)
}

func (r *Run) settle(state RunState, nodes map[string]*runtimeNode, primary error, rollbackErrs []error) {
	r.mu.Lock()
	if r.settled {
		r.mu.Unlock()
		return
	}
	r.settled = true
	if r.superseded {
		state = RunSuperseded
		primary = nil
		rollbackErrs = nil
	}
	rep := Report{
		PlanID:     r.plan.id,
		Generation: r.plan.generation,
		State:      state,
		Err:        primary,
	}
	for _, cn := range r.plan.order {
		n := nodes[cn.id]
		rep.Nodes = append(rep.Nodes, NodeReport{
			ID:          cn.id,
			Action:      cn.action,
			Reversible:  cn.reversible,
			State:       n.state,
			Effected:    n.effected,
			Err:         n.err,
			RollbackErr: n.rbErr,
		})
	}
	rep.CompensationErrors = append([]error(nil), rollbackErrs...)
	r.report = rep
	r.seq++
	r.trace = append(r.trace, TraceEvent{
		Seq:        r.seq,
		Kind:       TraceRunSettled,
		Generation: r.plan.generation,
	})
	r.mu.Unlock()

	r.cancel()
	close(r.done)
	r.exec.finish(r)
}
