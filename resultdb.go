// Package resultdb implements a test-result store ("结果库") with
// baseline-driven decisions.
//
// Rules:
//   - Every imported run is kept in the full history with a derived status.
//   - Within one (case, round) group the run with the smallest Seq fixes the
//     round outcome; runs with a conflicting outcome are RejectedConflict.
//     Importing a run that ends up rejected returns ErrConflict. The outcome
//     of this rule does not depend on import order.
//   - A case decision uses the outcome of the highest round that has at
//     least one accepted run. It is never "any pass wins", so a passing run
//     cannot be cherry-picked out of several actual runs.
//   - The governing baseline is the public, not-revoked baseline with the
//     highest round. If the actual outcome differs from its expectation the
//     case is a Mismatch and is listed separately.
//   - SourceSummary aggregates the full history per source.
package resultdb

import (
	"errors"
	"fmt"
	"sort"
)

// ErrConflict is returned when an imported run conflicts with the outcome
// already established for its (case, round) group by a lower-Seq run.
var ErrConflict = errors.New("resultdb: same-round conflict")

// Outcome is the result of a single actual run.
type Outcome int

const (
	Pass Outcome = iota
	Fail
)

func (o Outcome) String() string {
	switch o {
	case Pass:
		return "pass"
	case Fail:
		return "fail"
	}
	return fmt.Sprintf("Outcome(%d)", int(o))
}

// Run is one actual execution of a test case. Seq is a globally unique,
// monotonically assigned sequence number from the producer; imports may
// arrive out of order.
type Run struct {
	Case    string
	Round   uint64
	Outcome Outcome
	Source  string
	Seq     uint64
}

// RunStatus is the derived disposition of a run in the history.
type RunStatus int

const (
	Accepted RunStatus = iota
	// RejectedConflict marks runs whose outcome conflicts with the outcome
	// established for their (case, round) group by a lower-Seq run.
	RejectedConflict
)

func (s RunStatus) String() string {
	switch s {
	case Accepted:
		return "accepted"
	case RejectedConflict:
		return "rejected-conflict"
	}
	return fmt.Sprintf("RunStatus(%d)", int(s))
}

// HistoryEntry pairs a run with its derived status.
type HistoryEntry struct {
	Run    Run
	Status RunStatus
}

// Baseline is an expected outcome for a case, published at a round.
type Baseline struct {
	Case     string
	Round    uint64
	Expected Outcome
	Public   bool
	Seq      uint64
}

// DecisionKind classifies a per-case decision.
type DecisionKind int

const (
	// Undecided: the case has no accepted run.
	Undecided DecisionKind = iota
	// NoBaseline: accepted runs exist but no governing baseline.
	NoBaseline
	// Match: latest actual outcome equals the governing baseline.
	Match
	// Mismatch: latest actual outcome differs from the governing baseline.
	Mismatch
)

func (k DecisionKind) String() string {
	switch k {
	case Undecided:
		return "undecided"
	case NoBaseline:
		return "no-baseline"
	case Match:
		return "match"
	case Mismatch:
		return "mismatch"
	}
	return fmt.Sprintf("DecisionKind(%d)", int(k))
}

// Decision is the derived verdict for one case.
type Decision struct {
	Case   string
	Kind   DecisionKind
	Round  uint64 // round the actual outcome was taken from
	Actual Outcome
	// Baseline is the governing baseline, nil when Kind is Undecided or
	// NoBaseline.
	Baseline *Baseline
}

// SourceStat aggregates the full history of one source.
type SourceStat struct {
	Source   string
	Total    int
	Accepted int
	Rejected int
	Pass     int
	Fail     int
}

// Store records runs and baselines and derives decisions from the full
// history. It is not safe for concurrent use.
type Store struct {
	runs      []Run
	baselines []Baseline
	revoked   map[string]map[uint64]bool // case -> round -> revoked
	seenSeq   map[uint64]bool
}

// NewStore returns an empty Store.
func NewStore() *Store {
	return &Store{
		revoked: make(map[string]map[uint64]bool),
		seenSeq: make(map[uint64]bool),
	}
}

// ImportRun records one actual run. Runs may arrive out of order. It
// returns ErrConflict if the run's outcome loses its (case, round) group,
// and an error if Seq was already used. The run is kept in the history
// either way (unless the Seq is a duplicate).
func (s *Store) ImportRun(r Run) error {
	if s.seenSeq[r.Seq] {
		return fmt.Errorf("resultdb: duplicate seq %d", r.Seq)
	}
	s.seenSeq[r.Seq] = true
	s.runs = append(s.runs, r)
	if runStatus(s.runs, r) == RejectedConflict {
		return fmt.Errorf("%w: case %q round %d seq %d outcome %s",
			ErrConflict, r.Case, r.Round, r.Seq, r.Outcome)
	}
	return nil
}

// ImportBaseline records a baseline. Baselines may arrive out of order;
// for duplicate (case, round) publications the one with the highest Seq
// wins.
func (s *Store) ImportBaseline(b Baseline) error {
	if s.seenSeq[b.Seq] {
		return fmt.Errorf("resultdb: duplicate seq %d", b.Seq)
	}
	s.seenSeq[b.Seq] = true
	s.baselines = append(s.baselines, b)
	return nil
}

// RevokeBaseline marks the baseline for (case, round) as no longer valid.
func (s *Store) RevokeBaseline(caseID string, round uint64) {
	m, ok := s.revoked[caseID]
	if !ok {
		m = make(map[uint64]bool)
		s.revoked[caseID] = m
	}
	m[round] = true
}

// History returns the full run history with derived statuses, sorted by
// (Case, Round, Seq).
func (s *Store) History() []HistoryEntry {
	entries := make([]HistoryEntry, 0, len(s.runs))
	for _, r := range s.runs {
		entries = append(entries, HistoryEntry{Run: r, Status: runStatus(s.runs, r)})
	}
	sort.Slice(entries, func(i, j int) bool {
		a, b := entries[i].Run, entries[j].Run
		if a.Case != b.Case {
			return a.Case < b.Case
		}
		if a.Round != b.Round {
			return a.Round < b.Round
		}
		return a.Seq < b.Seq
	})
	return entries
}

// runStatus derives the status of target within its (case, round) group:
// the lowest-Seq run in the group fixes the outcome, and any run with a
// different outcome is rejected.
func runStatus(all []Run, target Run) RunStatus {
	winner := target
	found := false
	for _, r := range all {
		if r.Case != target.Case || r.Round != target.Round {
			continue
		}
		if !found || r.Seq < winner.Seq {
			winner = r
			found = true
		}
	}
	if found && winner.Outcome != target.Outcome {
		return RejectedConflict
	}
	return Accepted
}

// governingBaseline returns the public, not-revoked baseline with the
// highest round for the case, or nil.
func (s *Store) governingBaseline(caseID string) *Baseline {
	// Deduplicate (case, round) publications: highest Seq wins.
	byRound := make(map[uint64]Baseline)
	for _, b := range s.baselines {
		if b.Case != caseID || !b.Public || s.revoked[b.Case][b.Round] {
			continue
		}
		if cur, ok := byRound[b.Round]; !ok || b.Seq > cur.Seq {
			byRound[b.Round] = b
		}
	}
	var best *Baseline
	for _, b := range byRound {
		if best == nil || b.Round > best.Round {
			cp := b
			best = &cp
		}
	}
	return best
}

// Decide derives the decision for one case from the full history.
func (s *Store) Decide(caseID string) Decision {
	d := Decision{Case: caseID, Kind: Undecided}
	var bestRound uint64
	var bestOutcome Outcome
	have := false
	for _, r := range s.runs {
		if r.Case != caseID || runStatus(s.runs, r) != Accepted {
			continue
		}
		if !have || r.Round > bestRound {
			bestRound = r.Round
			bestOutcome = r.Outcome
			have = true
		}
	}
	if !have {
		return d
	}
	d.Round = bestRound
	d.Actual = bestOutcome
	bl := s.governingBaseline(caseID)
	if bl == nil {
		d.Kind = NoBaseline
		return d
	}
	d.Baseline = bl
	if bl.Expected == bestOutcome {
		d.Kind = Match
	} else {
		d.Kind = Mismatch
	}
	return d
}

// Cases returns the sorted set of case IDs known from runs or baselines.
func (s *Store) Cases() []string {
	set := make(map[string]bool)
	for _, r := range s.runs {
		set[r.Case] = true
	}
	for _, b := range s.baselines {
		set[b.Case] = true
	}
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// Decisions returns the decision for every known case, sorted by case ID.
func (s *Store) Decisions() []Decision {
	cases := s.Cases()
	out := make([]Decision, 0, len(cases))
	for _, c := range cases {
		out = append(out, s.Decide(c))
	}
	return out
}

// Mismatches lists, separately, every case whose latest actual outcome
// does not match its governing baseline, sorted by case ID.
func (s *Store) Mismatches() []Decision {
	var out []Decision
	for _, d := range s.Decisions() {
		if d.Kind == Mismatch {
			out = append(out, d)
		}
	}
	return out
}

// SourceSummary aggregates the full history per source, sorted by source.
func (s *Store) SourceSummary() []SourceStat {
	bySource := make(map[string]*SourceStat)
	var order []string
	for _, r := range s.runs {
		st, ok := bySource[r.Source]
		if !ok {
			st = &SourceStat{Source: r.Source}
			bySource[r.Source] = st
			order = append(order, r.Source)
		}
		st.Total++
		if runStatus(s.runs, r) == Accepted {
			st.Accepted++
		} else {
			st.Rejected++
		}
		if r.Outcome == Pass {
			st.Pass++
		} else {
			st.Fail++
		}
	}
	sort.Strings(order)
	out := make([]SourceStat, 0, len(order))
	for _, src := range order {
		out = append(out, *bySource[src])
	}
	return out
}
