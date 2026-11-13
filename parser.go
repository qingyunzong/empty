package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"time"
)

// ErrNoPendingEvent is returned by Commit when there is no event available to
// confirm.
var ErrNoPendingEvent = errors.New("dataeng: no event to commit")

// ErrOutOfOrderCommit is returned when an event older than the already
// confirmed cursor is committed.
var ErrOutOfOrderCommit = errors.New("dataeng: event commit is out of order")

// Event is one dispatched SSE event.
//
// Type is "message" when the stream did not provide an event field. Data is
// the event's data lines joined with "\n". ID is the last event ID in effect
// when the event was dispatched. Sequence starts at 1 and increases in arrival
// order for every dispatched event, including events that repeat an ID.
//
// Retry is the reconnection time in effect for the event. RetrySet reports
// whether a valid retry field has been seen on the stream so far.
type Event struct {
	Type     string
	Data     string
	ID       string
	Retry    time.Duration
	RetrySet bool
	Sequence uint64
}

// RetryMilliseconds returns the reconnection time rounded down to whole
// milliseconds.
func (e Event) RetryMilliseconds() int {
	if e.Retry <= 0 {
		return 0
	}
	return int(e.Retry / time.Millisecond)
}

// Parser reads and parses an SSE stream incrementally.
//
// A Parser is not safe for concurrent use. Use NewParser with an io.Reader for
// pull-based parsing, or NewParser without a reader and Feed for push-based
// parsing.
type Parser struct {
	reader io.Reader
	read   []byte

	queue    []Event
	last     Event
	haveLast bool

	line      []byte
	pendingCR bool
	bomDone   bool

	data      []byte
	eventType string
	id        string
	retry     time.Duration
	retrySet  bool

	eventStartID       string
	eventStartRetry    time.Duration
	eventStartRetrySet bool

	committedID  string
	committedSeq uint64
	nextSeq      uint64

	finished    bool
	terminalErr error
	errorServed bool
	zeroReads   int
	discarded   uint64
}

// Decoder is an alias for Parser.
type Decoder = Parser

// NewParser creates a parser. If a reader is supplied, Next pulls from it. If
// no reader is supplied, bytes can be supplied with Feed.
func NewParser(readers ...io.Reader) *Parser {
	p := &Parser{
		read:    make([]byte, 32*1024),
		nextSeq: 1,
	}
	if len(readers) > 0 {
		p.reader = readers[0]
	}
	return p
}

// New is shorthand for NewParser.
func New(readers ...io.Reader) *Parser {
	return NewParser(readers...)
}

// NewDecoder is an alias for NewParser for callers that prefer decoder
// terminology.
func NewDecoder(readers ...io.Reader) *Parser {
	return NewParser(readers...)
}

// Next returns the next complete event. It returns io.EOF after a clean end of
// stream. If the stream ends in the middle of an event, that event is
// discarded. A non-EOF read error is returned after any complete events that
// preceded it have been delivered.
//
// Next is intended for parsers created with a reader. It can also drain events
// produced by Feed; when there is neither a reader nor a queued event it
// returns io.EOF.
func (p *Parser) Next() (Event, error) {
	for {
		if len(p.queue) > 0 {
			event := p.queue[0]
			p.queue = p.queue[1:]
			p.last = event
			p.haveLast = true
			return event, nil
		}

		if p.terminalErr != nil {
			if !p.errorServed {
				p.errorServed = true
				return Event{}, p.terminalErr
			}
			return Event{}, io.EOF
		}

		if p.reader == nil {
			return Event{}, io.EOF
		}

		n, err := p.reader.Read(p.read)
		if n > 0 {
			p.zeroReads = 0
			p.process(p.read[:n], &p.queue)
		} else if err == nil {
			p.zeroReads++
			if p.zeroReads >= 100 {
				p.finish(io.ErrNoProgress)
			}
			continue
		}

		if err != nil {
			p.finish(err)
		}
	}
}

// ReadEvent is an alias for Next.
func (p *Parser) ReadEvent() (Event, error) {
	return p.Next()
}

// Decode is an alias for Next.
func (p *Parser) Decode() (Event, error) {
	return p.Next()
}

// Feed consumes a chunk of bytes and returns the events completed by that
// chunk. Bytes of an incomplete line or event are retained for the next call.
//
// A connection interruption should simply stop feeding data; the retained
// partial event is never returned. Call Close to explicitly mark the stream as
// ended and discard it.
func (p *Parser) Feed(chunk []byte) []Event {
	if p.finished || len(chunk) == 0 {
		return nil
	}

	var events []Event
	p.process(chunk, &events)
	if len(events) > 0 {
		p.last = events[len(events)-1]
		p.haveLast = true
	}
	return events
}

// Close marks the input as ended. Any incomplete event is discarded. It does
// not change the confirmed Last-Event-ID.
func (p *Parser) Close() error {
	p.finish(io.EOF)
	return nil
}

// Finish is an alias for Close.
func (p *Parser) Finish() error {
	return p.Close()
}

// Commit confirms that one or more delivered events were successfully output.
// With no argument it confirms the most recently delivered event.
//
// Committing moves LastEventID only after confirmation. Events must be
// confirmed in arrival order; committing an older sequence returns
// ErrOutOfOrderCommit. Re-committing the current sequence is idempotent.
// Forward gaps are allowed so a caller can drop events according to its own
// policy (for example duplicate-ID suppression) and still confirm later
// events.
func (p *Parser) Commit(events ...Event) error {
	if len(events) == 0 {
		if !p.haveLast {
			return ErrNoPendingEvent
		}
		events = []Event{p.last}
	}

	sequence := p.committedSeq
	id := p.committedID
	for _, event := range events {
		if event.Sequence == 0 {
			return fmt.Errorf("%w: event has no sequence", ErrOutOfOrderCommit)
		}
		if event.Sequence < sequence {
			return fmt.Errorf("%w: sequence %d is older than %d", ErrOutOfOrderCommit, event.Sequence, sequence)
		}
		if event.Sequence == sequence {
			continue
		}
		id = event.ID
		sequence = event.Sequence
	}
	p.committedID = id
	p.committedSeq = sequence
	return nil
}

// Ack is an alias for Commit.
func (p *Parser) Ack(events ...Event) error {
	return p.Commit(events...)
}

// Confirm is an alias for Commit.
func (p *Parser) Confirm(events ...Event) error {
	return p.Commit(events...)
}

// CommitID commits an explicitly supplied resumable ID. It is useful when an
// event is transformed before output and its original sequence is not
// available. It does not advance the sequence cursor; normally Commit(event)
// should be preferred.
func (p *Parser) CommitID(id string) {
	p.committedID = id
}

// LastEventID returns the confirmed resumable cursor. It is the value that
// should be sent as Last-Event-ID on a reconnect.
func (p *Parser) LastEventID() string {
	return p.committedID
}

// CommittedID is an alias for LastEventID.
func (p *Parser) CommittedID() string {
	return p.committedID
}

// CommittedSequence returns the sequence number of the last confirmed event.
func (p *Parser) CommittedSequence() uint64 {
	return p.committedSeq
}

// PendingEventID returns the ID buffer currently in effect, including id
// fields that have not yet been confirmed. It must not be used as the
// reconnection cursor.
func (p *Parser) PendingEventID() string {
	return p.id
}

// BufferedEventID is an alias for PendingEventID.
func (p *Parser) BufferedEventID() string {
	return p.id
}

// Retry returns the reconnection time currently in effect.
func (p *Parser) Retry() time.Duration {
	return p.retry
}

// RetryMilliseconds returns the reconnection time in whole milliseconds.
func (p *Parser) RetryMilliseconds() int {
	if p.retry <= 0 {
		return 0
	}
	return int(p.retry / time.Millisecond)
}

// HasRetry reports whether a valid retry field has been seen.
func (p *Parser) HasRetry() bool {
	return p.retrySet
}

// DiscardedEvents returns the number of incomplete events discarded at end of
// stream.
func (p *Parser) DiscardedEvents() uint64 {
	return p.discarded
}

// Err returns the terminal stream error, if any. A clean end of stream is
// reported as io.EOF.
func (p *Parser) Err() error {
	return p.terminalErr
}

func (p *Parser) process(chunk []byte, out *[]Event) {
	for _, b := range chunk {
		if p.pendingCR {
			p.pendingCR = false
			if b == '\n' {
				continue
			}
		}

		switch b {
		case '\r':
			p.handleLine(p.line, out)
			p.line = p.line[:0]
			p.pendingCR = true
		case '\n':
			p.handleLine(p.line, out)
			p.line = p.line[:0]
		default:
			p.line = append(p.line, b)
		}
	}
}

func (p *Parser) handleLine(line []byte, out *[]Event) {
	if !p.bomDone {
		p.bomDone = true
		line = bytes.TrimPrefix(line, []byte{0xEF, 0xBB, 0xBF})
	}

	if len(line) == 0 {
		p.dispatch(out)
		return
	}
	if line[0] == ':' {
		return
	}

	field := line
	var value []byte
	if i := bytes.IndexByte(line, ':'); i >= 0 {
		field = line[:i]
		value = line[i+1:]
		if len(value) > 0 && value[0] == ' ' {
			value = value[1:]
		}
	}

	switch string(field) {
	case "data":
		p.data = append(p.data, value...)
		p.data = append(p.data, '\n')
	case "event":
		if bytes.IndexByte(value, 0) < 0 {
			p.eventType = string(value)
		}
	case "id":
		if bytes.IndexByte(value, 0) < 0 {
			p.id = string(value)
		}
	case "retry":
		if retry, ok := parseRetry(value); ok {
			p.retry = retry
			p.retrySet = true
		}
	}
}

func (p *Parser) dispatch(out *[]Event) {
	if len(p.data) == 0 {
		p.eventType = ""
		p.eventStartID = p.id
		p.eventStartRetry = p.retry
		p.eventStartRetrySet = p.retrySet
		return
	}

	data := p.data
	if data[len(data)-1] == '\n' {
		data = data[:len(data)-1]
	}

	eventType := p.eventType
	if eventType == "" {
		eventType = "message"
	}

	event := Event{
		Type:     eventType,
		Data:     string(data),
		ID:       p.id,
		Retry:    p.retry,
		RetrySet: p.retrySet,
		Sequence: p.nextSeq,
	}
	p.nextSeq++

	*out = append(*out, event)

	p.data = p.data[:0]
	p.eventType = ""
	p.eventStartID = p.id
	p.eventStartRetry = p.retry
	p.eventStartRetrySet = p.retrySet
}

func (p *Parser) finish(err error) {
	if p.finished {
		return
	}
	p.finished = true

	partial := len(p.line) > 0 ||
		len(p.data) > 0 ||
		p.eventType != "" ||
		p.id != p.eventStartID ||
		p.retry != p.eventStartRetry ||
		p.retrySet != p.eventStartRetrySet
	if partial {
		p.discarded++
	}

	p.line = p.line[:0]
	p.pendingCR = false
	p.data = p.data[:0]
	p.eventType = ""
	p.id = p.eventStartID
	p.retry = p.eventStartRetry
	p.retrySet = p.eventStartRetrySet

	if err == nil {
		err = io.EOF
	}
	p.terminalErr = err
}

func parseRetry(value []byte) (time.Duration, bool) {
	if len(value) == 0 {
		return 0, false
	}

	var milliseconds uint64
	for _, b := range value {
		if b < '0' || b > '9' {
			return 0, false
		}
		digit := uint64(b - '0')
		if milliseconds > (math.MaxUint64-digit)/10 {
			return maxRetryDuration, true
		}
		milliseconds = milliseconds*10 + digit
	}

	maxMilliseconds := uint64(math.MaxInt64 / int64(time.Millisecond))
	if milliseconds > maxMilliseconds {
		return maxRetryDuration, true
	}
	return time.Duration(milliseconds) * time.Millisecond, true
}

const maxRetryDuration = time.Duration(math.MaxInt64)
