package mbt

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// CallRecord keeps one actual adapter call and its actual output.
type CallRecord struct {
	Op     string         `json:"op"`
	Action string         `json:"action,omitempty"`
	OK     bool           `json:"ok"`
	Error  string         `json:"error,omitempty"`
	State  string         `json:"state,omitempty"`
	Data   map[string]any `json:"data,omitempty"`
}

// SeqResult is the outcome of replaying one legal sequence.
type SeqResult struct {
	Actions []string     `json:"actions"`
	Target  string       `json:"target"`
	Calls   []CallRecord `json:"calls"` // actual adapter outputs, in order
	Match   bool         `json:"match"`
	Diff    string       `json:"diff,omitempty"`
	ExecErr string       `json:"exec_error,omitempty"`
}

// IllegalResult is the outcome of probing one illegal action.
type IllegalResult struct {
	AtState   string       `json:"at_state"`
	History   []string     `json:"history"`
	Action    string       `json:"action"`
	Calls     []CallRecord `json:"calls"`
	Rejected  bool         `json:"rejected"`  // adapter returned an error
	Unchanged bool         `json:"unchanged"` // state identical after the probe
	Diff      string       `json:"diff,omitempty"`
	ExecErr   string       `json:"exec_error,omitempty"`
}

// Report is the full run result. Verdict is PASS only when the step
// budget closed and every check matched.
type Report struct {
	MaxSteps  int             `json:"max_steps"`
	Closed    bool            `json:"budget_closed"`
	Sequences []SeqResult     `json:"sequences"`
	Illegal   []IllegalResult `json:"illegal_probes"`
	Failures  []string        `json:"failures,omitempty"`
	Verdict   string          `json:"verdict"` // PASS, FAIL, INCONCLUSIVE
}

// Runner replays generated sequences against an adapter.
type Runner struct {
	model *Model
	ad    Adapter
}

func NewRunner(m *Model, ad Adapter) *Runner { return &Runner{model: m, ad: ad} }

func record(op, action string, resp Response) CallRecord {
	return CallRecord{Op: op, Action: action, OK: resp.OK, Error: resp.Error, State: resp.State, Data: resp.Data}
}

// diffStates returns a human-readable diff between expected and actual,
// or "" when they are equal. Only data keys declared by the model are
// constrained; extra keys reported by the implementation are ignored.
func diffStates(wantState string, wantData map[string]any, got Response) string {
	var b strings.Builder
	if got.State != wantState {
		fmt.Fprintf(&b, "state: want %q got %q\n", wantState, got.State)
	}
	var sorted []string
	for k := range wantData {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	for _, k := range sorted {
		w := wantData[k]
		if g := got.Data[k]; !reflect.DeepEqual(w, g) {
			fmt.Fprintf(&b, "data[%s]: want %v got %v\n", k, w, g)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

// Run executes the plan and returns a report with actual call outputs.
func (r *Runner) Run(plan Plan, maxSteps int) Report {
	rep := Report{MaxSteps: maxSteps, Closed: plan.Closed}
	for _, seq := range plan.Sequences {
		rep.Sequences = append(rep.Sequences, r.runSequence(seq))
	}
	// Illegal-action probes: from every state reachable within budget,
	// try each action the table forbids there.
	var states []string
	for s, h := range plan.Histories {
		if len(h) < maxSteps { // probe itself needs one step
			states = append(states, s)
		}
	}
	sort.Strings(states)
	for _, s := range states {
		for _, action := range r.model.IllegalFrom(s) {
			rep.Illegal = append(rep.Illegal, r.runIllegal(s, plan.Histories[s], action))
		}
	}
	for _, sr := range rep.Sequences {
		if sr.ExecErr != "" {
			rep.Failures = append(rep.Failures, fmt.Sprintf("sequence %v: %s", sr.Actions, sr.ExecErr))
		} else if !sr.Match {
			rep.Failures = append(rep.Failures, fmt.Sprintf("sequence %v: mismatch:\n%s", sr.Actions, sr.Diff))
		}
	}
	for _, ir := range rep.Illegal {
		if ir.ExecErr != "" {
			rep.Failures = append(rep.Failures, fmt.Sprintf("illegal %s@%s: %s", ir.Action, ir.AtState, ir.ExecErr))
		} else if !ir.Rejected {
			rep.Failures = append(rep.Failures, fmt.Sprintf("illegal %s@%s: accepted by implementation", ir.Action, ir.AtState))
		} else if !ir.Unchanged {
			rep.Failures = append(rep.Failures, fmt.Sprintf("illegal %s@%s: state changed:\n%s", ir.Action, ir.AtState, ir.Diff))
		}
	}
	switch {
	case len(rep.Failures) > 0:
		rep.Verdict = "FAIL"
	case !rep.Closed:
		// Budget did not close: never claim PASS.
		rep.Verdict = "INCONCLUSIVE"
	default:
		rep.Verdict = "PASS"
	}
	return rep
}

// replay resets the adapter and applies actions, recording every call.
func (r *Runner) replay(actions []string) ([]CallRecord, Response, error) {
	var calls []CallRecord
	resp, err := r.ad.Reset()
	if err != nil {
		return calls, Response{}, fmt.Errorf("reset: %w", err)
	}
	calls = append(calls, record("reset", "", resp))
	for _, a := range actions {
		resp, err = r.ad.Apply(a)
		if err != nil {
			return calls, Response{}, fmt.Errorf("apply %s: %w", a, err)
		}
		calls = append(calls, record("apply", a, resp))
		if !resp.OK {
			return calls, resp, fmt.Errorf("apply %s rejected: %s", a, resp.Error)
		}
	}
	return calls, resp, nil
}

func (r *Runner) runSequence(seq Sequence) SeqResult {
	res := SeqResult{Actions: seq.Actions, Target: seq.Target}
	calls, last, err := r.replay(seq.Actions)
	res.Calls = calls
	if err != nil {
		res.ExecErr = err.Error()
		return res
	}
	want := r.model.States[seq.Target]
	res.Diff = diffStates(seq.Target, want.Data, last)
	res.Match = res.Diff == ""
	return res
}

func (r *Runner) runIllegal(atState string, history []string, action string) IllegalResult {
	res := IllegalResult{AtState: atState, History: history, Action: action}
	calls, _, err := r.replay(history)
	if err != nil {
		res.Calls = calls
		res.ExecErr = fmt.Sprintf("reach %s: %s", atState, err)
		return res
	}
	probe, err := r.ad.Apply(action)
	if err != nil {
		res.Calls = calls
		res.ExecErr = fmt.Sprintf("probe %s: %s", action, err)
		return res
	}
	res.Calls = append(res.Calls, record("apply", action, probe))
	res.Rejected = !probe.OK
	after, err := r.ad.State()
	if err != nil {
		res.ExecErr = fmt.Sprintf("state after probe: %s", err)
		return res
	}
	res.Calls = append(res.Calls, record("state", "", after))
	want := r.model.States[atState]
	res.Diff = diffStates(atState, want.Data, after)
	res.Unchanged = res.Diff == ""
	return res
}
