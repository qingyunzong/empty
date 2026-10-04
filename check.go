package protocheck

import (
	"fmt"
	"strings"
)

// Verdict values. PASS is only ever written when the exploration budget
// closed and no failure or state difference was observed.
const (
	VerdictPass         = "PASS"
	VerdictFail         = "FAIL"
	VerdictInconclusive = "INCONCLUSIVE"
)

// Options configures a Run.
type Options struct {
	// Goal, when non-empty, is the state to locate via the shortest history.
	Goal string
	// MaxSteps is the exploration budget: histories longer than this are
	// never generated.
	MaxSteps int
	// CheckIllegal enables per-state illegal action checks.
	CheckIllegal bool
}

// CallRecord is one real adapter call and its real output.
type CallRecord struct {
	Seq    int
	Op     string
	Input  string
	Output string
	Err    string
}

// Report is the full outcome of a Run, including every adapter call.
type Report struct {
	Calls    []CallRecord
	History  []string
	Found    bool
	Closed   bool
	Diffs    []string
	Failures []string
	Verdict  string
	Reason   string
}

// String renders the report with the actual recorded call outputs.
func (r *Report) String() string {
	var b strings.Builder
	b.WriteString("calls:\n")
	for _, c := range r.Calls {
		fmt.Fprintf(&b, "  #%d %s", c.Seq, c.Op)
		if c.Input != "" {
			fmt.Fprintf(&b, " %q", c.Input)
		}
		if c.Err != "" {
			fmt.Fprintf(&b, " -> error: %s", c.Err)
		} else {
			fmt.Fprintf(&b, " -> %s", c.Output)
		}
		b.WriteString("\n")
	}
	if r.Found {
		fmt.Fprintf(&b, "history: [%s]\n", strings.Join(r.History, ", "))
	}
	for _, d := range r.Diffs {
		fmt.Fprintf(&b, "diff: %s\n", d)
	}
	for _, f := range r.Failures {
		fmt.Fprintf(&b, "failure: %s\n", f)
	}
	fmt.Fprintf(&b, "closed: %v\n", r.Closed)
	if r.Reason != "" {
		fmt.Fprintf(&b, "reason: %s\n", r.Reason)
	}
	fmt.Fprintf(&b, "verdict: %s\n", r.Verdict)
	return b.String()
}

// loggingAdapter wraps an Adapter and records every real call and output.
type loggingAdapter struct {
	inner Adapter
	rep   *Report
}

func (l *loggingAdapter) log(op, in, out string, err error) {
	rec := CallRecord{Seq: len(l.rep.Calls) + 1, Op: op, Input: in, Output: out}
	if err != nil {
		rec.Err = err.Error()
	}
	l.rep.Calls = append(l.rep.Calls, rec)
}

func (l *loggingAdapter) Reset() error {
	err := l.inner.Reset()
	out := "ok"
	if err != nil {
		out = ""
	}
	l.log("reset", "", out, err)
	return err
}

func (l *loggingAdapter) Apply(action string) error {
	err := l.inner.Apply(action)
	out := "ok"
	if err != nil {
		out = ""
	}
	l.log("apply", action, out, err)
	return err
}

func (l *loggingAdapter) State() (string, error) {
	s, err := l.inner.State()
	out := fmt.Sprintf("%q", s)
	if err != nil {
		out = ""
	}
	l.log("state", "", out, err)
	return s, err
}

// Run explores the table against the implementation within the step budget.
// It locates the goal state via the shortest legal history, records state
// differences, and checks that illegal actions fail without changing state.
func Run(t *Table, inner Adapter, opts Options) *Report {
	rep := &Report{}
	if opts.MaxSteps < 0 {
		opts.MaxSteps = 0
	}
	if opts.Goal != "" && !t.HasState(opts.Goal) {
		rep.Failures = append(rep.Failures, fmt.Sprintf("goal state %q not in table", opts.Goal))
		rep.Verdict = VerdictFail
		rep.Reason = "invalid goal"
		return rep
	}
	la := &loggingAdapter{inner: inner, rep: rep}

	type node struct {
		state string
		hist  []string
	}
	queue := []node{{state: t.Initial}}
	visited := map[string]bool{t.Initial: true}
	truncated := false

	for len(queue) > 0 && !rep.Found {
		cur := queue[0]
		queue = queue[1:]

		if err := la.Reset(); err != nil {
			rep.Failures = append(rep.Failures, fmt.Sprintf("reset failed: %v", err))
			break
		}
		rejected := false
		for i, act := range cur.hist {
			if err := la.Apply(act); err != nil {
				rep.Failures = append(rep.Failures,
					fmt.Sprintf("legal action %q (step %d of [%s]) rejected: %v",
						act, i+1, strings.Join(cur.hist, ", "), err))
				rejected = true
				break
			}
		}
		if rejected {
			continue
		}
		obs, err := la.State()
		if err != nil {
			rep.Failures = append(rep.Failures, fmt.Sprintf("state query failed: %v", err))
			continue
		}
		matched := obs == cur.state
		if !matched {
			rep.Diffs = append(rep.Diffs, fmt.Sprintf(
				"after [%s]: model state %q, implementation state %q",
				strings.Join(cur.hist, ", "), cur.state, obs))
		}

		if matched && opts.CheckIllegal && cur.state != "" {
			legal := map[string]bool{}
			for _, a := range t.LegalActions(cur.state) {
				legal[a] = true
			}
			for _, act := range t.Actions() {
				if legal[act] {
					continue
				}
				applyErr := la.Apply(act)
				if applyErr == nil {
					rep.Failures = append(rep.Failures,
						fmt.Sprintf("illegal action %q accepted in state %q", act, cur.state))
				}
				after, serr := la.State()
				if serr != nil {
					rep.Failures = append(rep.Failures, fmt.Sprintf("state query failed: %v", serr))
					continue
				}
				if after != cur.state {
					rep.Failures = append(rep.Failures,
						fmt.Sprintf("illegal action %q changed state %q -> %q", act, cur.state, after))
				}
			}
		}

		if opts.Goal != "" && cur.state == opts.Goal {
			rep.Found = true
			rep.History = cur.hist
			break
		}

		if len(cur.hist) >= opts.MaxSteps {
			for _, act := range t.LegalActions(cur.state) {
				next, _ := t.Step(cur.state, act)
				if !visited[next] {
					truncated = true
					break
				}
			}
			continue
		}
		for _, act := range t.LegalActions(cur.state) {
			next, _ := t.Step(cur.state, act)
			if visited[next] {
				continue
			}
			visited[next] = true
			h := append(append([]string{}, cur.hist...), act)
			queue = append(queue, node{state: next, hist: h})
		}
	}

	rep.Closed = rep.Found || !truncated
	switch {
	case len(rep.Failures) > 0 || len(rep.Diffs) > 0:
		rep.Verdict = VerdictFail
		rep.Reason = "failures or state differences observed"
	case !rep.Closed:
		rep.Verdict = VerdictInconclusive
		rep.Reason = fmt.Sprintf("budget of %d steps exhausted before exploration closed", opts.MaxSteps)
	case opts.Goal != "" && !rep.Found:
		rep.Verdict = VerdictFail
		rep.Reason = fmt.Sprintf("goal state %q unreachable (exploration closed within %d steps)", opts.Goal, opts.MaxSteps)
	default:
		rep.Verdict = VerdictPass
	}
	return rep
}
