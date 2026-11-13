package dataeng

import (
	"errors"
	"strings"
	"time"
)

// TermReason explains why an Event was completed. Empty events are never
// emitted, so every Event returned by this package has a non-empty reason.
type TermReason string

const (
	// ReasonNewStart means the next line began a new event.
	ReasonNewStart TermReason = "new_start"
	// ReasonTimeout means the rule's timeout predicate matched.
	ReasonTimeout TermReason = "timeout"
	// ReasonFlush means an explicit or scheduled flush completed the event.
	ReasonFlush TermReason = "flush"
	// ReasonRotation means the source file was renamed, replaced, or removed.
	ReasonRotation TermReason = "rotation"
	// ReasonTruncation means the source file became shorter than its read offset.
	ReasonTruncation TermReason = "truncation"
	// ReasonEncoding means a line was not valid UTF-8.
	ReasonEncoding TermReason = "encoding"
	// ReasonMaxBytes means the event reached its byte budget.
	ReasonMaxBytes TermReason = "max_bytes"
)

var (
	// ErrEncoding reports a line that could not be decoded as UTF-8.
	ErrEncoding = errors.New("dataeng: invalid UTF-8")
	// ErrMaxBytes reports that an event exceeded its configured byte budget.
	ErrMaxBytes = errors.New("dataeng: event byte budget exceeded")
	// ErrRotation reports that the source file was rotated or removed.
	ErrRotation = errors.New("dataeng: source rotated")
	// ErrTruncation reports that the source file was truncated.
	ErrTruncation = errors.New("dataeng: source truncated")
	// ErrSourceMissing reports that the configured source does not exist.
	ErrSourceMissing = errors.New("dataeng: source missing")
	// ErrCollectorClosed reports an operation on a closed Collector.
	ErrCollectorClosed = errors.New("dataeng: collector closed")
	// ErrNilAggregator reports that a Collector was created without a state machine.
	ErrNilAggregator = errors.New("dataeng: nil aggregator")
	// ErrSnapshotVersion reports an unsupported snapshot format.
	ErrSnapshotVersion = errors.New("dataeng: unsupported snapshot version")
	// ErrSnapshotPath reports a snapshot created for another source path.
	ErrSnapshotPath = errors.New("dataeng: snapshot path mismatch")
	// ErrSnapshotCorrupt reports inconsistent state inside a snapshot.
	ErrSnapshotCorrupt = errors.New("dataeng: corrupt snapshot")
)

// Line is one physical input line and its byte span in the source file.
// EndOffset points just past the line terminator when the line came from a
// file. Text does not include the trailing "\n".
type Line struct {
	Text        []byte
	StartOffset int64
	EndOffset   int64
}

// Event is a completed multiline log event.
//
// Lines never contain newline separators. Text joins them with "\n". Err is
// non-nil only for exceptional terminations and wraps one of the package
// error values, so callers can use errors.Is.
type Event struct {
	Seq         uint64
	Lines       []string
	StartOffset int64
	EndOffset   int64
	Started     time.Time
	Ended       time.Time
	Reason      TermReason
	Truncated   bool
	Err         error
}

// Text returns the event lines joined with newlines.
func (e Event) Text() string {
	return joinLines(e.Lines)
}

// Bytes returns the size of Text in bytes.
func (e Event) Bytes() int {
	return linesSize(e.Lines)
}

// PendingEvent is the event currently held by an Aggregator. It is exported so
// it can be inspected and stored in snapshots.
type PendingEvent struct {
	Seq         uint64    `json:"seq"`
	Lines       []string  `json:"lines"`
	StartOffset int64     `json:"start_offset"`
	EndOffset   int64     `json:"end_offset"`
	Started     time.Time `json:"started"`
	Updated     time.Time `json:"updated"`
	Size        int       `json:"size"`
	Truncated   bool      `json:"truncated,omitempty"`
}

// Text returns the pending lines joined with newlines.
func (p PendingEvent) Text() string {
	return joinLines(p.Lines)
}

func joinLines(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	if len(lines) == 1 {
		return lines[0]
	}
	var b strings.Builder
	size := linesSize(lines)
	b.Grow(size)
	for i, line := range lines {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(line)
	}
	return b.String()
}

func linesSize(lines []string) int {
	if len(lines) == 0 {
		return 0
	}
	size := len(lines) - 1
	for _, line := range lines {
		size += len(line)
	}
	return size
}
