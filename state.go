package formal

// State is the externally visible role of a Machine.
type State uint8

const (
	// Follower does not believe it holds the lease.
	Follower State = iota

	// Candidate has attempted or is about to attempt a compare-and-swap.
	Candidate

	// Leader has a locally valid, store-confirmed lease. Callers must still
	// gate actions on IsLeader because time can pass between ticks.
	Leader
)

func (s State) String() string {
	switch s {
	case Follower:
		return "follower"
	case Candidate:
		return "candidate"
	case Leader:
		return "leader"
	default:
		return "unknown"
	}
}
