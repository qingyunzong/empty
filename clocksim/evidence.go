package clocksim

import "fmt"

// Outcome describes how a wait terminated.
type Outcome int

const (
	// Visible means the read became safe to serve within the tick budget.
	Visible Outcome = iota
	// PendingNoProgress means a tick failed to advance the interval, so the
	// wait cannot guarantee progress and the read stays pending.
	PendingNoProgress
	// PendingTickLimit means the tick budget was exhausted first.
	PendingTickLimit
)

func (o Outcome) String() string {
	switch o {
	case Visible:
		return "visible"
	case PendingNoProgress:
		return "pending-no-progress"
	case PendingTickLimit:
		return "pending-tick-limit"
	}
	return "unknown"
}

// WaitEvidence records the full trace of a visibility wait: the interval at
// the start, the interval observed after every tick, and how the wait ended.
type WaitEvidence struct {
	Node         string
	Key          string
	CommitLatest int64
	Start        Interval
	AfterTicks   []Interval
	End          Interval
	Outcome      Outcome
}

func (e WaitEvidence) String() string {
	return fmt.Sprintf("node=%s key=%s commitLatest=%d start=[%d,%d] ticks=%d end=[%d,%d] outcome=%s",
		e.Node, e.Key, e.CommitLatest, e.Start.Earliest, e.Start.Latest,
		len(e.AfterTicks), e.End.Earliest, e.End.Latest, e.Outcome)
}
