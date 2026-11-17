package formal

import (
	"context"
	"fmt"
	"math"
	"sync"
	"testing"
)

type faultMode int

const (
	faultOK faultMode = iota
	faultBeforeEffect
	faultAfterEffect
)

func (m faultMode) String() string {
	switch m {
	case faultOK:
		return "ok"
	case faultBeforeEffect:
		return "fail-before"
	case faultAfterEffect:
		return "fail-after"
	default:
		return "unknown"
	}
}

type scriptedBackend struct {
	modes        map[string]faultMode
	rollbackFail map[string]bool
	duplicate    bool

	mu        sync.Mutex
	applies   map[string]int
	rollbacks []string
}

func newScriptedBackend(modes map[string]faultMode, rollbackFail map[string]bool, duplicate bool) *scriptedBackend {
	return &scriptedBackend{
		modes:        modes,
		rollbackFail: rollbackFail,
		duplicate:    duplicate,
		applies:      make(map[string]int),
	}
}

func (b *scriptedBackend) Apply(_ context.Context, req ApplyRequest, done func(ApplyOutcome)) error {
	b.mu.Lock()
	b.applies[req.Node.ID]++
	b.mu.Unlock()

	out := scriptedOutcome(req.Node.ID, b.modes[req.Node.ID])
	done(out)
	if b.duplicate {
		// A provider must be tolerated even if it reports a completion twice.
		done(out)
	}
	return nil
}

func scriptedOutcome(id string, mode faultMode) ApplyOutcome {
	token := id + "/token"
	switch mode {
	case faultOK:
		return ApplyOutcome{Effected: true, Token: token}
	case faultBeforeEffect:
		return ApplyOutcome{Effected: false, Err: fmt.Errorf("apply %s failed before effect", id)}
	case faultAfterEffect:
		return ApplyOutcome{Effected: true, Token: token, Err: fmt.Errorf("apply %s failed after effect", id)}
	default:
		return ApplyOutcome{Effected: false, Err: fmt.Errorf("apply %s has unknown fault", id)}
	}
}

func (b *scriptedBackend) Rollback(_ context.Context, req RollbackRequest) error {
	b.mu.Lock()
	b.rollbacks = append(b.rollbacks, req.Node.ID)
	fail := b.rollbackFail[req.Node.ID]
	b.mu.Unlock()
	if fail {
		return fmt.Errorf("rollback %s failed", req.Node.ID)
	}
	return nil
}

func (b *scriptedBackend) totalApplies() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	total := 0
	for _, n := range b.applies {
		total += n
	}
	return total
}

func seqOf(trace []TraceEvent, kind TraceKind, nodeID string) (uint64, bool) {
	for _, ev := range trace {
		if ev.Kind == kind && ev.NodeID == nodeID {
			return ev.Seq, true
		}
	}
	return 0, false
}

func countOf(trace []TraceEvent, kind TraceKind, nodeID string) int {
	count := 0
	for _, ev := range trace {
		if ev.Kind == kind && ev.NodeID == nodeID {
			count++
		}
	}
	return count
}

func nodeIDs(plan Plan) []string {
	ids := make([]string, 0, len(plan.Nodes))
	for _, n := range plan.Nodes {
		ids = append(ids, n.ID)
	}
	return ids
}

func topologyRanks(plan Plan) map[string]int {
	byID := make(map[string]Node, len(plan.Nodes))
	for _, n := range plan.Nodes {
		byID[n.ID] = n
	}
	memo := make(map[string]int, len(plan.Nodes))
	var visit func(string) int
	visit = func(id string) int {
		if rank, ok := memo[id]; ok {
			return rank
		}
		rank := 0
		for _, dep := range byID[id].Deps {
			if r := visit(dep) + 1; r > rank {
				rank = r
			}
		}
		memo[id] = rank
		return rank
	}
	for _, n := range plan.Nodes {
		visit(n.ID)
	}
	return memo
}

func dependsOn(node Node, id string) bool {
	for _, dep := range node.Deps {
		if dep == id {
			return true
		}
	}
	return false
}

// assertTraceInvariants checks the properties that must hold for every plan,
// fault configuration and completion order.
func assertTraceInvariants(t *testing.T, plan Plan, rep Report, trace []TraceEvent) {
	t.Helper()

	settled := 0
	for i, ev := range trace {
		if ev.Kind == TraceRunSettled {
			settled++
			if i != len(trace)-1 {
				t.Errorf("run-settled at %d is not the last trace event (%d total)", i, len(trace))
			}
		}
	}
	if settled != 1 {
		t.Fatalf("got %d run-settled events, want exactly 1", settled)
	}
	switch rep.State {
	case RunSucceeded, RunFailed, RunSuperseded:
	default:
		t.Fatalf("invalid terminal run state %q", rep.State)
	}

	byID := make(map[string]NodeReport, len(rep.Nodes))
	for _, n := range rep.Nodes {
		byID[n.ID] = n
		switch n.State {
		case NodePending, NodeRunning, NodeRollingBack:
			t.Errorf("node %s has non-terminal state %s", n.ID, n.State)
		}
	}
	if len(byID) != len(plan.Nodes) {
		t.Fatalf("report has %d nodes, want %d", len(byID), len(plan.Nodes))
	}
	switch rep.State {
	case RunSucceeded:
		for _, n := range rep.Nodes {
			if n.State != NodeSucceeded {
				t.Errorf("succeeded run left node %s in state %s", n.ID, n.State)
			}
		}
	case RunFailed:
		if rep.Err == nil {
			t.Error("failed run has nil error")
		}
		for _, n := range rep.Nodes {
			if n.State == NodeSucceeded {
				t.Errorf("failed run left node %s in state %s", n.ID, n.State)
			}
		}
	}

	for _, n := range plan.Nodes {
		if got := countOf(trace, TraceApplyStarted, n.ID); got > 1 {
			t.Errorf("node %s applied %d times", n.ID, got)
		}
		terminal := countOf(trace, TraceApplySucceeded, n.ID) + countOf(trace, TraceApplyFailed, n.ID)
		if terminal > 1 {
			t.Errorf("node %s reported %d apply completions", n.ID, terminal)
		}
	}

	// A node may start only after every dependency has completed successfully.
	for _, n := range plan.Nodes {
		start, started := seqOf(trace, TraceApplyStarted, n.ID)
		if !started {
			continue
		}
		for _, dep := range n.Deps {
			depDone, ok := seqOf(trace, TraceApplySucceeded, dep)
			if !ok {
				t.Errorf("node %s started although dependency %s did not succeed", n.ID, dep)
				continue
			}
			if depDone >= start {
				t.Errorf("node %s started at %d before dependency %s succeeded at %d",
					n.ID, start, dep, depDone)
			}
		}
	}

	// Compensation is limited to committed, reversible effects.
	firstRollback := uint64(math.MaxUint64)
	lastApplyTerminal := uint64(0)
	for _, ev := range trace {
		switch ev.Kind {
		case TraceRollbackStarted:
			if ev.Seq < firstRollback {
				firstRollback = ev.Seq
			}
		case TraceApplySucceeded, TraceApplyFailed:
			if ev.Seq > lastApplyTerminal {
				lastApplyTerminal = ev.Seq
			}
		}
		if ev.Kind != TraceRollbackStarted {
			continue
		}
		n, ok := byID[ev.NodeID]
		if !ok {
			t.Errorf("rollback of unknown node %s", ev.NodeID)
			continue
		}
		if !n.Effected {
			t.Errorf("node %s was compensated although it had no effect", n.ID)
		}
		if !n.Reversible {
			t.Errorf("node %s was compensated although it is not reversible", n.ID)
		}
	}
	if firstRollback != math.MaxUint64 && lastApplyTerminal > firstRollback {
		t.Errorf("compensation started at %d before the last apply settled at %d",
			firstRollback, lastApplyTerminal)
	}

	// Compensation must proceed from dependents to dependencies.
	ranks := topologyRanks(plan)
	prevRank := math.MaxInt
	for _, ev := range trace {
		if ev.Kind != TraceRollbackStarted {
			continue
		}
		rank := ranks[ev.NodeID]
		if rank > prevRank {
			t.Errorf("rollback of %s (rank %d) happened after a lower-rank node (rank %d)",
				ev.NodeID, rank, prevRank)
		}
		prevRank = rank
	}
	for _, n := range plan.Nodes {
		depStart, ok := seqOf(trace, TraceRollbackStarted, n.ID)
		if !ok {
			continue
		}
		for _, other := range plan.Nodes {
			if !dependsOn(other, n.ID) {
				continue
			}
			dependent := byID[other.ID]
			if !dependent.Effected {
				continue
			}
			dependentDone, ok := seqOf(trace, TraceRollbackSucceeded, other.ID)
			if !ok {
				t.Errorf("dependency %s rolled back while effective dependent %s was not compensated",
					n.ID, other.ID)
				continue
			}
			if dependentDone > depStart {
				t.Errorf("dependency %s rollback started at %d before dependent %s compensation finished at %d",
					n.ID, depStart, other.ID, dependentDone)
			}
		}
	}
}

func TestFaultPointEnumeration(t *testing.T) {
	plan := diamondPlan(1)
	ids := nodeIDs(plan)
	total := 1
	for range ids {
		total *= 3
	}
	for mask := 0; mask < total; mask++ {
		modes := make(map[string]faultMode, len(ids))
		left := mask
		name := ""
		for _, id := range ids {
			mode := faultMode(left % 3)
			left /= 3
			modes[id] = mode
			if name != "" {
				name += ","
			}
			name += id + ":" + mode.String()
		}
		t.Run(name, func(t *testing.T) {
			backend := newScriptedBackend(modes, nil, true)
			e := newTestExecutor(t, backend)
			run, err := e.Start(context.Background(), plan)
			if err != nil {
				t.Fatalf("Start: %v", err)
			}
			rep := waitReport(t, run)
			trace := run.Trace()
			assertTraceInvariants(t, plan, rep, trace)

			wantState := RunSucceeded
			for _, mode := range modes {
				if mode != faultOK {
					wantState = RunFailed
				}
			}
			if rep.State != wantState {
				t.Fatalf("state = %s, want %s (err=%v)", rep.State, wantState, rep.Err)
			}
			if wantState == RunSucceeded {
				for _, n := range rep.Nodes {
					if n.State != NodeSucceeded {
						t.Errorf("node %s state = %s, want %s", n.ID, n.State, NodeSucceeded)
					}
				}
				if len(rep.CompensationErrors) != 0 {
					t.Errorf("successful run has compensation errors: %v", rep.CompensationErrors)
				}
			} else if rep.Err == nil {
				t.Error("failed run has nil error")
			}

			for _, n := range plan.Nodes {
				started := countOf(trace, TraceApplyStarted, n.ID) == 1
				report := byID(rep, n.ID)
				if !started {
					if report.Effected {
						t.Errorf("unstarted node %s reports an effect", n.ID)
					}
					continue
				}
				wantEffected := modes[n.ID] != faultBeforeEffect
				if report.Effected != wantEffected {
					t.Errorf("node %s effected = %v, want %v", n.ID, report.Effected, wantEffected)
				}
			}

			if got, want := backend.totalApplies(), len(traceStarted(trace)); got != want {
				t.Errorf("backend saw %d applies, trace saw %d starts", got, want)
			}

			again := waitReport(t, run)
			if again.State != rep.State {
				t.Fatalf("terminal state changed from %s to %s", rep.State, again.State)
			}
			for _, n := range rep.Nodes {
				if got := byID(again, n.ID); got.State != n.State {
					t.Fatalf("node %s terminal state changed from %s to %s", n.ID, n.State, got.State)
				}
			}
		})
	}
}

func traceStarted(trace []TraceEvent) []string {
	var ids []string
	for _, ev := range trace {
		if ev.Kind == TraceApplyStarted {
			ids = append(ids, ev.NodeID)
		}
	}
	return ids
}

func byID(rep Report, id string) NodeReport {
	n, _ := rep.Node(id)
	return n
}

func TestCompensationMatrixEnumeratesReversibilityAndRollbackFaults(t *testing.T) {
	plan := diamondPlan(1)
	modes := map[string]faultMode{
		"a": faultOK,
		"b": faultOK,
		"c": faultOK,
		"d": faultAfterEffect,
	}
	ids := nodeIDs(plan)
	for mask := 0; mask < 1<<len(ids); mask++ {
		reversible := make(map[string]bool, len(ids))
		for i, id := range ids {
			reversible[id] = mask&(1<<i) != 0
		}
		for _, failedRollback := range append([]string{""}, ids...) {
			mask, failedRollback := mask, failedRollback
			t.Run(fmt.Sprintf("mask=%d/rollback-fail=%s", mask, failedRollback), func(t *testing.T) {
				plan := plan
				for i := range plan.Nodes {
					plan.Nodes[i].Reversible = reversible[plan.Nodes[i].ID]
				}
				rbFail := map[string]bool{}
				if failedRollback != "" {
					rbFail[failedRollback] = true
				}
				backend := newScriptedBackend(modes, rbFail, true)
				e := newTestExecutor(t, backend)
				run, err := e.Start(context.Background(), plan)
				if err != nil {
					t.Fatalf("Start: %v", err)
				}
				rep := waitReport(t, run)
				trace := run.Trace()
				assertTraceInvariants(t, plan, rep, trace)

				if rep.State != RunFailed {
					t.Fatalf("state = %s, want %s", rep.State, RunFailed)
				}
				want := expectedCompensationStates(reversible, failedRollback)
				for _, n := range plan.Nodes {
					if got := byID(rep, n.ID).State; got != want[n.ID] {
						t.Errorf("node %s state = %s, want %s", n.ID, got, want[n.ID])
					}
				}

				wantAttempted := map[string]bool{}
				for id, state := range want {
					if state == NodeCompensated || state == NodeCompensationFailed {
						wantAttempted[id] = true
					}
				}
				for _, id := range ids {
					_, got := seqOf(trace, TraceRollbackStarted, id)
					if got != wantAttempted[id] {
						t.Errorf("node %s rollback attempted = %v, want %v", id, got, wantAttempted[id])
					}
					if want[id] == NodeCompensated {
						if _, ok := seqOf(trace, TraceRollbackSucceeded, id); !ok {
							t.Errorf("node %s should have a successful rollback", id)
						}
					}
					if want[id] == NodeCompensationFailed {
						if _, ok := seqOf(trace, TraceRollbackFailed, id); !ok {
							t.Errorf("node %s should have a failed rollback", id)
						}
					}
				}
			})
		}
	}
}

func expectedCompensationStates(reversible map[string]bool, failedRollback string) map[string]NodeState {
	state := make(map[string]NodeState, 4)

	dCompensated := false
	if !reversible["d"] {
		state["d"] = NodeRetained
	} else if failedRollback == "d" {
		state["d"] = NodeCompensationFailed
	} else {
		state["d"] = NodeCompensated
		dCompensated = true
	}

	for _, id := range []string{"b", "c"} {
		if !dCompensated || !reversible[id] {
			state[id] = NodeRetained
		} else if failedRollback == id {
			state[id] = NodeCompensationFailed
		} else {
			state[id] = NodeCompensated
		}
	}

	if state["b"] != NodeCompensated || state["c"] != NodeCompensated || !reversible["a"] {
		state["a"] = NodeRetained
	} else if failedRollback == "a" {
		state["a"] = NodeCompensationFailed
	} else {
		state["a"] = NodeCompensated
	}
	return state
}

func TestFailBeforeEffectCompensatesOnlyCommittedNodes(t *testing.T) {
	plan := diamondPlan(1)
	modes := map[string]faultMode{
		"a": faultOK,
		"b": faultOK,
		"c": faultOK,
		"d": faultBeforeEffect,
	}
	backend := newScriptedBackend(modes, nil, true)
	e := newTestExecutor(t, backend)
	run, err := e.Start(context.Background(), plan)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	rep := waitReport(t, run)
	trace := run.Trace()
	assertTraceInvariants(t, plan, rep, trace)

	if rep.State != RunFailed {
		t.Fatalf("state = %s, want %s", rep.State, RunFailed)
	}
	if n := byID(rep, "d"); n.State != NodeFailed || n.Effected {
		t.Errorf("d = %+v, want failed without effect", n)
	}
	for _, id := range []string{"a", "b", "c"} {
		if n := byID(rep, id); n.State != NodeCompensated {
			t.Errorf("%s state = %s, want %s", id, n.State, NodeCompensated)
		}
	}
	if got := rollbackOrder(trace); len(got) != 3 || got[0] != "c" || got[1] != "b" || got[2] != "a" {
		t.Errorf("rollback order = %v, want [c b a]", got)
	}
}

func TestCompensationUsesStrictReverseTopology(t *testing.T) {
	plan := diamondPlan(1)
	modes := map[string]faultMode{
		"a": faultOK,
		"b": faultOK,
		"c": faultOK,
		"d": faultAfterEffect,
	}
	backend := newScriptedBackend(modes, nil, true)
	e := newTestExecutor(t, backend)
	run, err := e.Start(context.Background(), plan)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	rep := waitReport(t, run)
	trace := run.Trace()
	assertTraceInvariants(t, plan, rep, trace)

	got := rollbackOrder(trace)
	want := []string{"d", "c", "b", "a"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("rollback order = %v, want %v", got, want)
	}
}

func TestRollbackFailureBlocksDependencyCompensation(t *testing.T) {
	plan := diamondPlan(1)
	modes := map[string]faultMode{
		"a": faultOK,
		"b": faultOK,
		"c": faultOK,
		"d": faultAfterEffect,
	}
	backend := newScriptedBackend(modes, map[string]bool{"b": true}, true)
	e := newTestExecutor(t, backend)
	run, err := e.Start(context.Background(), plan)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	rep := waitReport(t, run)
	trace := run.Trace()
	assertTraceInvariants(t, plan, rep, trace)

	if n := byID(rep, "b"); n.State != NodeCompensationFailed || n.RollbackErr == nil {
		t.Errorf("b = %+v, want compensation failure", n)
	}
	if n := byID(rep, "a"); n.State != NodeRetained {
		t.Errorf("a state = %s, want %s", n.State, NodeRetained)
	}
	if got := rollbackOrder(trace); fmt.Sprint(got) != fmt.Sprint([]string{"d", "c", "b"}) {
		t.Errorf("rollback order = %v, want [d c b]", got)
	}
	if len(rep.CompensationErrors) != 1 {
		t.Errorf("compensation errors = %v, want 1", rep.CompensationErrors)
	}
}

func rollbackOrder(trace []TraceEvent) []string {
	var ids []string
	for _, ev := range trace {
		if ev.Kind == TraceRollbackStarted {
			ids = append(ids, ev.NodeID)
		}
	}
	return ids
}
