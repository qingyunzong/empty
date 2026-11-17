package formal

// Assigner maps an event to its event-time window(s).
type Assigner interface {
	Assign(event Event) []Window
	kind() assignerKind
}

type assignerKind int

const (
	kindTumbling assignerKind = iota
	kindSession
)

// TumblingAssigner produces fixed-size, non-overlapping windows
// [floor(ts/size)*size, floor(ts/size)*size+size).
type TumblingAssigner struct {
	Size int64
}

// NewTumblingAssigner requires a positive window size.
func NewTumblingAssigner(size int64) *TumblingAssigner {
	if size <= 0 {
		panic("formal: tumbling window size must be positive")
	}
	return &TumblingAssigner{Size: size}
}

// Assign returns the single tumbling window containing the event.
func (a *TumblingAssigner) Assign(event Event) []Window {
	start := floorDiv(event.Timestamp, a.Size) * a.Size
	return []Window{{Start: start, End: start + a.Size}}
}

func (a *TumblingAssigner) kind() assignerKind { return kindTumbling }

// SessionAssigner initially gives every event its own session window
// [ts, ts+gap). The WindowOperator later merges windows whose intervals
// overlap (i.e. consecutive events with a gap smaller than the session gap).
type SessionAssigner struct {
	Gap int64
}

// NewSessionAssigner requires a positive session gap.
func NewSessionAssigner(gap int64) *SessionAssigner {
	if gap <= 0 {
		panic("formal: session gap must be positive")
	}
	return &SessionAssigner{Gap: gap}
}

// Assign returns the event's initial singleton session window.
func (a *SessionAssigner) Assign(event Event) []Window {
	return []Window{{Start: event.Timestamp, End: event.Timestamp + a.Gap}}
}

func (a *SessionAssigner) kind() assignerKind { return kindSession }

// floorDiv computes mathematical floor division, also for negative dividends.
func floorDiv(value, divisor int64) int64 {
	quotient := value / divisor
	remainder := value % divisor
	if remainder != 0 && ((value < 0) != (divisor < 0)) {
		quotient--
	}
	return quotient
}
