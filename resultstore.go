// Package resultstore implements a test-run results store with strict
// integrity rules:
//
//   - Every actual run of a case is recorded; successes may not be
//     cherry-picked (all outcomes are stored, nothing is filtered).
//   - Decisions are made against the latest published and valid baseline.
//   - Baseline mismatches are listed separately from matches.
//   - Conflicting outcomes for the same case in the same round are rejected.
//   - The store keeps a per-source summary and the complete run history.
//   - Out-of-order imports converge to the same state as a full-history
//     rule model replayed in canonical order (see model.go).
package resultstore

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

// Outcome is the result of a single actual run of a case.
type Outcome string

const (
	OutcomePass Outcome = "pass"
	OutcomeFail Outcome = "fail"
	OutcomeSkip Outcome = "skip"
)

// Valid reports whether o is a known outcome.
func (o Outcome) Valid() bool {
	switch o {
	case OutcomePass, OutcomeFail, OutcomeSkip:
		return true
	}
	return false
}

// Run is one actual execution of a case in a round, attributed to a source.
type Run struct {
	CaseID  string
	Round   int
	Outcome Outcome
	Source  string
	At      time.Time
}

// Baseline is a versioned set of expected outcomes per case. Only baselines
// that are both Published and Valid may drive decisions.
type Baseline struct {
	Version   int
	Published bool
	Valid     bool
	Expect    map[string]Outcome
}

// ConflictError reports a same-round conflicting outcome for a case.
type ConflictError struct {
	CaseID   string
	Round    int
	Existing Outcome
	Incoming Outcome
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("resultstore: conflict for case %q round %d: have %q, reject %q",
		e.CaseID, e.Round, e.Existing, e.Incoming)
}

// IsConflict reports whether err is a same-round conflict rejection.
func IsConflict(err error) bool {
	var ce *ConflictError
	return errors.As(err, &ce)
}

// ValidationError reports a malformed run or baseline.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return "resultstore: " + e.Msg }

type caseRound struct {
	caseID string
	round  int
}

// Store is an append-only results store. The zero value is ready to use.
type Store struct {
	runs      []Run                 // complete history, insertion order
	byKey     map[caseRound]Outcome // accepted outcome per case+round
	latest    map[string]latestRun  // latest accepted run per case
	baselines []Baseline            // full baseline history
}

type latestRun struct {
	round   int
	outcome Outcome
}

// AddRun records one actual run. All outcomes (pass/fail/skip) are stored;
// nothing is dropped. An exact duplicate (same case, round and outcome) is
// idempotent. A different outcome for the same case and round is a conflict
// and is rejected with *ConflictError.
func (s *Store) AddRun(r Run) error {
	if r.CaseID == "" {
		return &ValidationError{Msg: "run with empty case id"}
	}
	if r.Source == "" {
		return &ValidationError{Msg: fmt.Sprintf("run for case %q with empty source", r.CaseID)}
	}
	if !r.Outcome.Valid() {
		return &ValidationError{Msg: fmt.Sprintf("run for case %q with invalid outcome %q", r.CaseID, r.Outcome)}
	}
	if s.byKey == nil {
		s.byKey = make(map[caseRound]Outcome)
		s.latest = make(map[string]latestRun)
	}
	key := caseRound{caseID: r.CaseID, round: r.Round}
	if existing, ok := s.byKey[key]; ok {
		if existing == r.Outcome {
			return nil // idempotent duplicate
		}
		return &ConflictError{CaseID: r.CaseID, Round: r.Round, Existing: existing, Incoming: r.Outcome}
	}
	s.byKey[key] = r.Outcome
	s.runs = append(s.runs, r)
	if cur, ok := s.latest[r.CaseID]; !ok || r.Round > cur.round {
		s.latest[r.CaseID] = latestRun{round: r.Round, outcome: r.Outcome}
	}
	return nil
}

// AddBaseline appends a baseline to the history. Decisions always use the
// latest published and valid one, never an unpublished or invalid one.
func (s *Store) AddBaseline(b Baseline) error {
	if b.Expect == nil {
		return &ValidationError{Msg: fmt.Sprintf("baseline v%d with nil expectations", b.Version)}
	}
	for id, o := range b.Expect {
		if id == "" {
			return &ValidationError{Msg: fmt.Sprintf("baseline v%d with empty case id", b.Version)}
		}
		if !o.Valid() {
			return &ValidationError{Msg: fmt.Sprintf("baseline v%d case %q invalid outcome %q", b.Version, id, o)}
		}
	}
	s.baselines = append(s.baselines, b)
	return nil
}

// EffectiveBaseline returns the baseline that drives decisions: the one with
// the highest version among those that are both published and valid. It
// returns false if no such baseline exists.
func (s *Store) EffectiveBaseline() (Baseline, bool) {
	var best Baseline
	found := false
	for _, b := range s.baselines {
		if !b.Published || !b.Valid {
			continue
		}
		if !found || b.Version > best.Version {
			best, found = b, true
		}
	}
	return best, found
}

// CaseMismatch is a case whose latest actual outcome differs from the
// effective baseline expectation.
type CaseMismatch struct {
	CaseID   string
	Expected Outcome
	Actual   Outcome
}

// Decision is the outcome of evaluating the store against the effective
// baseline. Mismatches are listed separately from matches.
type Decision struct {
	BaselineVersion int
	Matched         []string       // cases whose latest outcome matches the baseline
	Mismatched      []CaseMismatch // baseline mismatches, listed separately
	Missing         []string       // baseline cases with no recorded run
	Extra           []string       // cases with runs but no baseline expectation
}

// Decide evaluates every case's latest actual outcome against the effective
// (latest published and valid) baseline. It returns false if there is no
// effective baseline.
func (s *Store) Decide() (Decision, bool) {
	b, ok := s.EffectiveBaseline()
	if !ok {
		return Decision{}, false
	}
	d := Decision{BaselineVersion: b.Version}
	for id, want := range b.Expect {
		cur, ran := s.latest[id]
		switch {
		case !ran:
			d.Missing = append(d.Missing, id)
		case cur.outcome == want:
			d.Matched = append(d.Matched, id)
		default:
			d.Mismatched = append(d.Mismatched, CaseMismatch{CaseID: id, Expected: want, Actual: cur.outcome})
		}
	}
	for id := range s.latest {
		if _, ok := b.Expect[id]; !ok {
			d.Extra = append(d.Extra, id)
		}
	}
	sort.Strings(d.Matched)
	sort.Slice(d.Mismatched, func(i, j int) bool { return d.Mismatched[i].CaseID < d.Mismatched[j].CaseID })
	sort.Strings(d.Missing)
	sort.Strings(d.Extra)
	return d, true
}

// SourceStat summarizes all runs attributed to one source.
type SourceStat struct {
	Source string
	Total  int
	Pass   int
	Fail   int
	Skip   int
	Rounds []int // distinct rounds, ascending
}

// SourceSummary aggregates the complete history per source. It counts every
// recorded run, including failures and skips.
func (s *Store) SourceSummary() []SourceStat {
	type agg struct {
		stat   SourceStat
		rounds map[int]bool
	}
	bySource := make(map[string]*agg)
	for _, r := range s.runs {
		a, ok := bySource[r.Source]
		if !ok {
			a = &agg{stat: SourceStat{Source: r.Source}, rounds: make(map[int]bool)}
			bySource[r.Source] = a
		}
		a.stat.Total++
		switch r.Outcome {
		case OutcomePass:
			a.stat.Pass++
		case OutcomeFail:
			a.stat.Fail++
		case OutcomeSkip:
			a.stat.Skip++
		}
		a.rounds[r.Round] = true
	}
	out := make([]SourceStat, 0, len(bySource))
	for _, a := range bySource {
		for rd := range a.rounds {
			a.stat.Rounds = append(a.stat.Rounds, rd)
		}
		sort.Ints(a.stat.Rounds)
		out = append(out, a.stat)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Source < out[j].Source })
	return out
}

// History returns a copy of the complete run history in insertion order.
// Every actual run is present; none are filtered by outcome.
func (s *Store) History() []Run {
	out := make([]Run, len(s.runs))
	copy(out, s.runs)
	return out
}

// Baselines returns a copy of the full baseline history in insertion order.
func (s *Store) Baselines() []Baseline {
	out := make([]Baseline, len(s.baselines))
	copy(out, s.baselines)
	return out
}

// LatestOutcome returns the latest accepted outcome for a case (highest
// round), and whether the case has any recorded run.
func (s *Store) LatestOutcome(caseID string) (Outcome, bool) {
	cur, ok := s.latest[caseID]
	if !ok {
		return "", false
	}
	return cur.outcome, true
}

// RunCount returns the number of accepted runs in the complete history.
func (s *Store) RunCount() int { return len(s.runs) }
