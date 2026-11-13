package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"sync"
	"time"
)

// CollectorOption configures a Collector.
type CollectorOption func(*Collector)

// WithPollChunk sets the maximum number of bytes requested from the file per
// read. Values less than or equal to zero are ignored.
func WithPollChunk(size int) CollectorOption {
	return func(c *Collector) {
		if size > 0 {
			c.chunk = size
		}
	}
}

// FileStamp identifies the file instance that produced a snapshot.
type FileStamp struct {
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mod_time"`
	Device  uint64    `json:"device,omitempty"`
	Inode   uint64    `json:"inode,omitempty"`
}

// CollectorState is a JSON-serializable recovery snapshot. It stores both the
// unfinished multiline event and the original file offsets: ReadOffset is the
// next unread byte, while Aggregator.Pending carries the event's source span.
// Partial holds bytes of a line that has been read but not terminated yet.
type CollectorState struct {
	Version       int        `json:"version"`
	Path          string     `json:"path"`
	ReadOffset    int64      `json:"read_offset"`
	PartialOffset int64      `json:"partial_offset,omitempty"`
	Partial       []byte     `json:"partial,omitempty"`
	File          *FileStamp `json:"file,omitempty"`
	Aggregator    State      `json:"aggregator"`
}

// Collector reads a growing log file and feeds complete physical lines into an
// Aggregator. Poll is the only method that advances the file cursor. Flush and
// FlushDue use the aggregator's lock, so a scheduled flush can race with Poll
// without emitting the same event twice.
type Collector struct {
	mu     sync.Mutex
	path   string
	agg    *Aggregator
	chunk  int
	closed bool

	file          *os.File
	offset        int64
	partial       []byte
	partialOffset int64
	restored      *FileStamp
}

// NewCollector creates a collector for path. The file is opened lazily by the
// first Poll, which allows callers to construct a collector before the log
// file exists.
func NewCollector(path string, agg *Aggregator, opts ...CollectorOption) (*Collector, error) {
	if path == "" {
		return nil, fmt.Errorf("dataeng: collector path is empty")
	}
	if agg == nil {
		return nil, ErrNilAggregator
	}
	collector := &Collector{
		path:  path,
		agg:   agg,
		chunk: 64 * 1024,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(collector)
		}
	}
	return collector, nil
}

// Path returns the configured source path.
func (c *Collector) Path() string {
	return c.path
}

// Poll reads all currently available bytes. A rotated, replaced, or removed
// file completes any open event with ReasonRotation; an in-place truncation
// completes it with ReasonTruncation. Those expected conditions are reported
// on the returned Events rather than as a Poll error.
func (c *Collector) Poll() ([]Event, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return nil, ErrCollectorClosed
	}
	if c.file == nil {
		if err := c.openLocked(); err != nil {
			return nil, err
		}
	}

	var events []Event
	for {
		restoredEvents, restoreErr := c.checkRestoredLocked()
		events = append(events, restoredEvents...)
		if restoreErr != nil {
			return events, restoreErr
		}

		pathInfo, err := os.Stat(c.path)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				drained, readErr := c.readAvailableLocked()
				events = append(events, drained...)
				events = append(events, c.flushPartialLocked()...)
				cause := fmt.Errorf("%w: %s disappeared", ErrRotation, c.path)
				events = append(events, c.agg.Terminate(ReasonRotation, cause)...)
				c.closeFileLocked()
				c.resetCursorLocked()
				return events, readErr
			}
			return events, fmt.Errorf("dataeng: stat source %s: %w", c.path, err)
		}

		info, err := c.file.Stat()
		if err != nil {
			return events, fmt.Errorf("dataeng: stat open source %s: %w", c.path, err)
		}
		if !os.SameFile(info, pathInfo) {
			drained, readErr := c.readAvailableLocked()
			events = append(events, drained...)
			events = append(events, c.flushPartialLocked()...)
			cause := fmt.Errorf("%w: %s was replaced", ErrRotation, c.path)
			events = append(events, c.agg.Terminate(ReasonRotation, cause)...)
			c.closeFileLocked()
			c.resetCursorLocked()
			if readErr != nil {
				return events, readErr
			}
			if err := c.openLocked(); err != nil {
				return events, err
			}
			c.restored = nil
			continue
		}

		if pathInfo.Size() < c.offset {
			cause := fmt.Errorf("%w: size %d is behind read offset %d", ErrTruncation, pathInfo.Size(), c.offset)
			events = append(events, c.agg.Terminate(ReasonTruncation, cause)...)
			c.resetCursorLocked()
		}

		read, readErr := c.readAvailableLocked()
		events = append(events, read...)
		return events, readErr
	}
}

// Flush completes the open event with reason. It does not consume an
// unterminated partial line; Poll or Close does that.
func (c *Collector) Flush(reason TermReason) []Event {
	return c.agg.Terminate(reason, nil)
}

// FlushDue is the scheduled-flush entry point. It completes the open event
// only when the rule's timeout predicate is satisfied. It is safe to call
// concurrently with Poll.
func (c *Collector) FlushDue(now time.Time) []Event {
	return c.agg.FlushDue(now)
}

// Tick is FlushDue using the aggregator's clock.
func (c *Collector) Tick() []Event {
	return c.agg.Tick()
}

// Close consumes any terminated partial line, flushes the open event with
// ReasonFlush, and closes the source file.
func (c *Collector) Close() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return nil
	}
	events := c.flushPartialLocked()
	events = append(events, c.agg.Terminate(ReasonFlush, nil)...)
	c.closeFileLocked()
	c.closed = true
	return events
}

// Snapshot captures the cursor, partial line, and unfinished event. The
// returned state can be marshaled with encoding/json.
func (c *Collector) Snapshot() CollectorState {
	c.mu.Lock()
	defer c.mu.Unlock()

	state := CollectorState{
		Version:       snapshotVersion,
		Path:          c.path,
		ReadOffset:    c.offset,
		PartialOffset: c.partialOffset,
		Partial:       append([]byte(nil), c.partial...),
	}
	if len(state.Partial) == 0 {
		state.PartialOffset = state.ReadOffset
	}
	if c.file != nil {
		if info, err := c.file.Stat(); err == nil {
			stamp := stampOf(info)
			state.File = &stamp
		}
	}
	state.Aggregator = c.agg.Snapshot()
	return state
}

// Restore loads a snapshot into a collector configured for the same path and
// aggregator rule. The file is reopened on the next Poll. If the path now
// points at a different file, the restored unfinished event is completed with
// ReasonRotation and reading starts at offset zero.
func (c *Collector) Restore(state CollectorState) error {
	if state.Version != snapshotVersion {
		return fmt.Errorf("%w: got %d, want %d", ErrSnapshotVersion, state.Version, snapshotVersion)
	}
	if state.Path != "" && state.Path != c.path {
		return fmt.Errorf("%w: snapshot %q, collector %q", ErrSnapshotPath, state.Path, c.path)
	}
	if state.ReadOffset < 0 || state.PartialOffset < 0 {
		return fmt.Errorf("%w: negative offset", ErrSnapshotCorrupt)
	}
	if len(state.Partial) > 0 && state.ReadOffset != state.PartialOffset+int64(len(state.Partial)) {
		return fmt.Errorf("%w: partial line does not end at read offset", ErrSnapshotCorrupt)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return ErrCollectorClosed
	}
	if err := c.agg.Restore(state.Aggregator); err != nil {
		return err
	}
	c.closeFileLocked()
	c.offset = state.ReadOffset
	c.partial = append([]byte(nil), state.Partial...)
	c.partialOffset = state.PartialOffset
	if len(c.partial) == 0 {
		c.partialOffset = c.offset
	}
	if state.File != nil {
		stamp := *state.File
		c.restored = &stamp
	} else {
		c.restored = nil
	}
	return nil
}

func (c *Collector) checkRestoredLocked() ([]Event, error) {
	if c.restored == nil || c.file == nil {
		return nil, nil
	}
	stamp := *c.restored

	info, err := c.file.Stat()
	if err != nil {
		return nil, fmt.Errorf("dataeng: stat restored source %s: %w", c.path, err)
	}
	c.restored = nil
	if stampMatches(stamp, stampOf(info)) {
		return nil, nil
	}
	cause := fmt.Errorf("%w: source changed since snapshot", ErrRotation)
	events := c.agg.Terminate(ReasonRotation, cause)
	c.resetCursorLocked()
	return events, nil
}

func (c *Collector) openLocked() error {
	file, err := os.Open(c.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("%w: %s", ErrSourceMissing, c.path)
		}
		return fmt.Errorf("dataeng: open source %s: %w", c.path, err)
	}
	c.file = file
	return nil
}

func (c *Collector) closeFileLocked() {
	if c.file != nil {
		_ = c.file.Close()
		c.file = nil
	}
}

func (c *Collector) resetCursorLocked() {
	c.offset = 0
	c.partial = nil
	c.partialOffset = 0
}

func (c *Collector) readAvailableLocked() ([]Event, error) {
	if c.file == nil {
		return nil, nil
	}

	buffer := make([]byte, c.chunk)
	var events []Event
	for {
		start := c.offset
		n, err := c.file.ReadAt(buffer, start)
		if n > 0 {
			c.offset += int64(n)
			events = append(events, c.consumeLocked(buffer[:n], start)...)
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return events, nil
			}
			return events, fmt.Errorf("dataeng: read source %s: %w", c.path, err)
		}
		if n == 0 {
			return events, nil
		}
	}
}

func (c *Collector) consumeLocked(chunk []byte, chunkStart int64) []Event {
	var events []Event
	for len(chunk) > 0 {
		index := bytes.IndexByte(chunk, '\n')
		if index < 0 {
			if len(c.partial) == 0 {
				c.partialOffset = chunkStart
			}
			c.partial = append(c.partial, chunk...)
			return events
		}

		var text []byte
		var start int64
		if len(c.partial) > 0 {
			text = append(c.partial, chunk[:index]...)
			start = c.partialOffset
			c.partial = nil
		} else {
			text = chunk[:index]
			start = chunkStart
		}
		end := chunkStart + int64(index) + 1
		if len(text) > 0 && text[len(text)-1] == '\r' {
			text = text[:len(text)-1]
		}
		events = append(events, c.agg.Push(Line{
			Text:        text,
			StartOffset: start,
			EndOffset:   end,
		})...)

		chunk = chunk[index+1:]
		chunkStart = end
	}
	return events
}

func (c *Collector) flushPartialLocked() []Event {
	if len(c.partial) == 0 {
		return nil
	}
	text := c.partial
	start := c.partialOffset
	end := start + int64(len(text))
	c.partial = nil
	c.partialOffset = end
	if text[len(text)-1] == '\r' {
		text = text[:len(text)-1]
	}
	return c.agg.Push(Line{
		Text:        text,
		StartOffset: start,
		EndOffset:   end,
	})
}
