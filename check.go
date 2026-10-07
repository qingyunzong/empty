package crashreplay

import "fmt"

// Invariant validates a recovered state. It returns an empty string when
// the state satisfies the invariant, otherwise a human-readable violation.
type Invariant func(state map[string]string) string

// Require returns an invariant demanding that every required key=value pair
// is present in the recovered state.
func Require(required map[string]string) Invariant {
	return func(state map[string]string) string {
		for k, v := range required {
			got, ok := state[k]
			if !ok {
				return fmt.Sprintf("missing key %q (want %q)", k, v)
			}
			if got != v {
				return fmt.Sprintf("key %q = %q, want %q", k, got, v)
			}
		}
		return ""
	}
}

// Verdict is the outcome of a check.
type Verdict string

const (
	VerdictOK             Verdict = "ok"
	VerdictCounterexample Verdict = "counterexample"
	VerdictUnknown        Verdict = "unknown"
)

// Report summarizes a check run.
type Report struct {
	Verdict         Verdict           `json:"verdict"`
	Explored        int               `json:"explored"`
	Counterexample  map[string]string `json:"counterexample"`
	Violation       string            `json:"violation,omitempty"`
	UnknownReason   string            `json:"unknown_reason,omitempty"`
	Actual          map[string]string `json:"actual"`
	ActualLegal     bool              `json:"actual_legal"`
	ActualViolation string            `json:"actual_violation,omitempty"`
}

// DefaultBudget bounds the number of persistent subsets enumerated per
// crash: at most 2^18, i.e. crashes with up to 18 unsynced writes.
const DefaultBudget = 1 << 18

// Checker replays a trace and verifies recovery invariants.
type Checker struct {
	// Budget caps the subsets enumerated per crash; zero means DefaultBudget.
	Budget int
	// Seed makes the implementation's actual recovery deterministic.
	Seed int64
	// Shuffle enumerates subsets in a deliberately scrambled (but
	// deterministic and exhaustive) order.
	Shuffle bool
}

// Check orders the published events, replays them, and at every crash
// enumerates all persistent subsets of the unsynced writes. It returns the
// first counterexample found together with the implementation's actual
// recovery result, or VerdictUnknown when the budget cannot cover the
// enumeration.
func (c Checker) Check(published []Event, inv Invariant) (Report, error) {
	events, err := Order(published)
	if err != nil {
		return Report{}, err
	}
	budget := c.Budget
	if budget <= 0 {
		budget = DefaultBudget
	}
	st := NewStorage(c.Seed)
	report := Report{ActualLegal: true}
	for _, e := range events {
		switch e.Op {
		case OpWrite:
			st.Write(e.Key, e.Value)
		case OpSync:
			st.Sync()
		case OpCrash:
			pending := st.Pending()
			durable := st.Durable()
			actual := st.Recover()
			report.Actual = actual
			report.ActualLegal = LegalState(durable, pending, actual)
			if v := inv(actual); v != "" {
				report.ActualViolation = v
			}
			n := len(pending)
			if n >= 63 || 1<<uint(n) > budget {
				report.Verdict = VerdictUnknown
				report.UnknownReason = fmt.Sprintf("budget %d insufficient to enumerate 2^%d persistent subsets", budget, n)
				return report, nil
			}
			total := 1 << uint(n)
			for i := 0; i < total; i++ {
				mask := i
				if c.Shuffle {
					mask = scramble(i, n)
				}
				state := applySubset(durable, pending, mask)
				report.Explored++
				if v := inv(state); v != "" {
					report.Verdict = VerdictCounterexample
					report.Counterexample = state
					report.Violation = v
					return report, nil
				}
			}
		default:
			return Report{}, fmt.Errorf("unknown op %q", e.Op)
		}
	}
	report.Verdict = VerdictOK
	return report, nil
}

// LegalState reports whether state is a possible recovery outcome: every
// synced write preserved, plus some subset of the pending writes applied in
// their original order.
func LegalState(durable map[string]string, pending []Write, state map[string]string) bool {
	for k, v := range durable {
		if got, ok := state[k]; !ok || got != v {
			return false
		}
	}
	for k, v := range state {
		if dv, ok := durable[k]; ok && dv == v {
			continue
		}
		found := false
		for _, w := range pending {
			if w.Key == k && w.Value == v {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// applySubset applies the pending writes selected by mask, in log order.
func applySubset(durable map[string]string, pending []Write, mask int) map[string]string {
	state := clone(durable)
	for j, w := range pending {
		if mask&(1<<uint(j)) != 0 {
			state[w.Key] = w.Value
		}
	}
	return state
}

// scramble is a bijection on [0, 2^n): multiplication by an odd constant
// plus an offset modulo 2^n. It deliberately visits subsets out of order
// while remaining exhaustive.
func scramble(i, n int) int {
	if n == 0 {
		return 0
	}
	return (i*0x9E3779B + 0x1234) & ((1 << uint(n)) - 1)
}
