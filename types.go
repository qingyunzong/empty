package formal

// ChangeKind distinguishes insert/upsert from retraction in the changelog.
type ChangeKind int

const (
	// Add inserts a row or updates an existing row in the materialized view.
	Add ChangeKind = iota
	// Retract removes a row matching the same window key from the materialized view.
	Retract
)

func (k ChangeKind) String() string {
	switch k {
	case Add:
		return "ADD"
	case Retract:
		return "RETRACT"
	default:
		return "UNKNOWN"
	}
}

// Event is a single input record carrying an event-time timestamp.
type Event struct {
	ID        string
	Timestamp int64
	Value     int64
}

// Window is the event-time interval [Start, End) assigned to an event.
type Window struct {
	Start int64
	End   int64
}

// Row is one aggregated output row keyed by its window interval.
type Row struct {
	Window Window
	Count  int64
	Sum    int64
}

// Change is one changelog entry emitted by the window operator.
// For Add it carries the new full row; for Retract it carries the row that
// must be removed (Window key plus its previous Count and Sum).
type Change struct {
	Seq  int64
	Kind ChangeKind
	Row  Row
}

// Signal feeds the operator. Exactly one of Event or Watermark is meaningful;
// when IsWatermark is true the operator advances its event-time watermark to
// Watermark (never below the current one), otherwise Event is processed.
type Signal struct {
	IsWatermark bool
	Watermark   int64
	Event       Event
}

// MinTimestamp is the initial watermark before any watermark signal is seen.
const MinTimestamp int64 = -1 << 63
