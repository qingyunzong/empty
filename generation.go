package formal

import (
	"fmt"
	"sort"
	"time"
)

// MemberID is the stable identity of a training process. It is chosen by the
// caller and must be unique across the lifetime of the coordinator.
type MemberID string

// Rank is the position of a member in a generation's membership table. Ranks
// are contiguous and start at zero.
type Rank uint32

// Member is one row of a generation's membership table.
type Member struct {
	ID   MemberID
	Rank Rank
}

// GenerationState describes the lifecycle of a generation.
type GenerationState uint8

const (
	// GenerationPending is collecting confirmations.
	GenerationPending GenerationState = iota
	// GenerationCommitted has confirmations from every member.
	GenerationCommitted
	// GenerationAborted was replaced before every member confirmed.
	GenerationAborted
)

func (s GenerationState) String() string {
	switch s {
	case GenerationPending:
		return "pending"
	case GenerationCommitted:
		return "committed"
	case GenerationAborted:
		return "aborted"
	default:
		return fmt.Sprintf("generation-state(%d)", uint8(s))
	}
}

// AbortReason records why a generation did not commit.
type AbortReason uint8

const (
	// AbortNone is used by pending and committed generations.
	AbortNone AbortReason = iota
	// AbortSuperseded means a join, reconnect, or implicit rollover replaced
	// the pending generation.
	AbortSuperseded
	// AbortMemberFailed means an explicit failure report removed a member.
	AbortMemberFailed
	// AbortDeadline means at least one member did not confirm before the
	// deadline.
	AbortDeadline
)

func (r AbortReason) String() string {
	switch r {
	case AbortNone:
		return "none"
	case AbortSuperseded:
		return "superseded"
	case AbortMemberFailed:
		return "member-failed"
	case AbortDeadline:
		return "deadline"
	default:
		return fmt.Sprintf("abort-reason(%d)", uint8(r))
	}
}

// Confirmation is an acknowledgement recorded for one member of one
// generation.
type Confirmation struct {
	Member MemberID
	At     time.Time
}

// Generation is an immutable snapshot of a generation. Members are sorted by
// MemberID and their ranks are 0..len(Members)-1. Confirmations are sorted by
// member ID.
type Generation struct {
	Number        uint64
	State         GenerationState
	AbortReason   AbortReason
	OpenedAt      time.Time
	Deadline      time.Time
	Members       []Member
	Confirmations []Confirmation
}

// Validate checks the invariants that every generation snapshot must satisfy.
//
// In particular, it verifies that ranks are unique and contiguous, that the
// membership table is sorted, that confirmations come from members of this
// generation, and that a committed generation has a confirmation from every
// member received before the deadline.
func (g Generation) Validate() error {
	if g.Number == 0 {
		return fmt.Errorf("%w: zero generation number", ErrInvalidGeneration)
	}
	if g.State > GenerationAborted {
		return fmt.Errorf("%w: unknown state %d", ErrInvalidGeneration, uint8(g.State))
	}
	if g.AbortReason > AbortDeadline {
		return fmt.Errorf("%w: unknown abort reason %d", ErrInvalidGeneration, uint8(g.AbortReason))
	}
	if !g.Deadline.After(g.OpenedAt) {
		return fmt.Errorf("%w: deadline %s is not after open time %s", ErrInvalidGeneration, g.Deadline, g.OpenedAt)
	}
	if len(g.Members) == 0 {
		return fmt.Errorf("%w: generation %d has no members", ErrInvalidGeneration, g.Number)
	}

	seen := make(map[MemberID]struct{}, len(g.Members))
	for i, m := range g.Members {
		if m.ID == "" {
			return fmt.Errorf("%w: generation %d has an empty member ID", ErrInvalidGeneration, g.Number)
		}
		if _, duplicate := seen[m.ID]; duplicate {
			return fmt.Errorf("%w: generation %d repeats member %q", ErrInvalidGeneration, g.Number, m.ID)
		}
		if m.Rank != Rank(i) {
			return fmt.Errorf("%w: generation %d member %q has rank %d, want %d",
				ErrInvalidGeneration, g.Number, m.ID, m.Rank, i)
		}
		if i > 0 && !(g.Members[i-1].ID < m.ID) {
			return fmt.Errorf("%w: generation %d members are not sorted", ErrInvalidGeneration, g.Number)
		}
		seen[m.ID] = struct{}{}
	}

	for i, confirmation := range g.Confirmations {
		if _, ok := seen[confirmation.Member]; !ok {
			return fmt.Errorf("%w: generation %d has a confirmation from non-member %q",
				ErrInvalidGeneration, g.Number, confirmation.Member)
		}
		if i > 0 && !(g.Confirmations[i-1].Member < confirmation.Member) {
			return fmt.Errorf("%w: generation %d confirmations are not sorted", ErrInvalidGeneration, g.Number)
		}
		if confirmation.At.Before(g.OpenedAt) {
			return fmt.Errorf("%w: generation %d confirmation from %q predates the generation",
				ErrInvalidGeneration, g.Number, confirmation.Member)
		}
		if !confirmation.At.Before(g.Deadline) {
			return fmt.Errorf("%w: generation %d confirmation from %q arrived at or after the deadline",
				ErrInvalidGeneration, g.Number, confirmation.Member)
		}
	}

	switch g.State {
	case GenerationPending:
		if g.AbortReason != AbortNone {
			return fmt.Errorf("%w: pending generation %d has abort reason %s",
				ErrInvalidGeneration, g.Number, g.AbortReason)
		}
	case GenerationCommitted:
		if g.AbortReason != AbortNone {
			return fmt.Errorf("%w: committed generation %d has abort reason %s",
				ErrInvalidGeneration, g.Number, g.AbortReason)
		}
		if len(g.Confirmations) != len(g.Members) {
			return fmt.Errorf("%w: committed generation %d has %d confirmations for %d members",
				ErrInvalidGeneration, g.Number, len(g.Confirmations), len(g.Members))
		}
	case GenerationAborted:
		if g.AbortReason == AbortNone {
			return fmt.Errorf("%w: aborted generation %d has no abort reason", ErrInvalidGeneration, g.Number)
		}
	}

	return nil
}

type generationState struct {
	number        uint64
	state         GenerationState
	abortReason   AbortReason
	openedAt      time.Time
	deadline      time.Time
	members       []Member
	memberSet     map[MemberID]Rank
	confirmations map[MemberID]time.Time
}

func newGenerationState(number uint64, now time.Time, timeout time.Duration, alive map[MemberID]struct{}) *generationState {
	ids := make([]MemberID, 0, len(alive))
	for id := range alive {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })

	members := make([]Member, len(ids))
	memberSet := make(map[MemberID]Rank, len(ids))
	for i, id := range ids {
		rank := Rank(i)
		members[i] = Member{ID: id, Rank: rank}
		memberSet[id] = rank
	}

	return &generationState{
		number:        number,
		state:         GenerationPending,
		openedAt:      now,
		deadline:      now.Add(timeout),
		members:       members,
		memberSet:     memberSet,
		confirmations: make(map[MemberID]time.Time, len(ids)),
	}
}

func (g *generationState) snapshot() Generation {
	confirmations := make([]Confirmation, 0, len(g.confirmations))
	for member, at := range g.confirmations {
		confirmations = append(confirmations, Confirmation{Member: member, At: at})
	}
	sort.Slice(confirmations, func(i, j int) bool {
		return confirmations[i].Member < confirmations[j].Member
	})

	return Generation{
		Number:        g.number,
		State:         g.state,
		AbortReason:   g.abortReason,
		OpenedAt:      g.openedAt,
		Deadline:      g.deadline,
		Members:       append([]Member(nil), g.members...),
		Confirmations: confirmations,
	}
}
