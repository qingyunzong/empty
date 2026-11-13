package dataeng

// WindowContext identifies a window revision passed to an AggregateFunc.
type WindowContext struct {
	Partition string
	Key       string
	Window    Window
}

// AggregateFunc derives a user-defined aggregate from the complete event set
// of a window revision. It is called once per emitted revision. The operator
// passes a copy of the events, so the callback may retain or modify the slice.
// A nil AggregateFunc leaves WindowResult.Aggregate nil.
type AggregateFunc func(ctx WindowContext, events []Event) any

// Config controls a window operator. Window is required. AllowedLateness may
// be zero, in which case a window is finalized as soon as its end is reached
// by the partition watermark.
type Config struct {
	Window          WindowSpec
	AllowedLateness int64
	Aggregate       AggregateFunc
}

// Validate checks the configuration.
func (c Config) Validate() error {
	if err := c.Window.Validate(); err != nil {
		return err
	}
	if c.AllowedLateness < 0 {
		return errInvalidConfig("allowed lateness must not be negative, got %d", c.AllowedLateness)
	}
	return nil
}

// WindowResult is one versioned window emission. Version starts at 1 for the
// first trigger and increases by one for every accepted late revision. Late
// is true when the emission was caused by a record that arrived after the
// window end. Events contains the complete window contents for that version,
// which makes downstream aggregation replayable.
type WindowResult struct {
	Partition string
	Key       string
	Window    Window
	Version   int
	Late      bool
	Watermark int64
	Events    []Event
	Aggregate any
}

// SideOutputReason explains why a record was routed to the side output.
type SideOutputReason string

const (
	// SideOutputAfterDeadline means the record arrived after the window's
	// allowed-lateness deadline. Its window state has already been discarded.
	SideOutputAfterDeadline SideOutputReason = "after_deadline"
	// SideOutputNoWindow means the record does not fall into any window, for
	// example a sliding window specification with Size < Slide.
	SideOutputNoWindow SideOutputReason = "no_window"
)

// SideOutput carries records that cannot produce a valid window revision.
// Windows lists the window(s) that would have received the record. For
// session windows it is the candidate session interval. Watermark is the
// partition watermark at routing time, or NoWatermark if none is established.
type SideOutput struct {
	Event     Event
	Windows   []Window
	Watermark int64
	Reason    SideOutputReason
}

func errInvalidConfig(format string, args ...any) error {
	return wrapError(ErrInvalidConfig, format, args...)
}
