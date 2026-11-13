package dataeng

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	// Version is the only supported record version.
	Version = 1

	// HeaderSize is the size of the fixed record header.
	HeaderSize = 8

	// TypeStatus carries an application/protocol status and closes a request.
	TypeStatus uint8 = 3
	// TypeOutput carries raw output bytes for a request.
	TypeOutput uint8 = 6
	// TypeOutputContinuation also carries raw output bytes for a request.
	TypeOutputContinuation uint8 = 7

	defaultMaxContent = 1<<16 - 1
)

var (
	ErrInvalidVersion = errors.New("dataeng: invalid record version")
	ErrInvalidType    = errors.New("dataeng: unsupported record type")
	ErrReserved       = errors.New("dataeng: non-zero reserved byte")
	ErrMaxContent     = errors.New("dataeng: content exceeds host limit")
	ErrStatusLength   = errors.New("dataeng: status record content length must be 8")
	ErrRequestClosed  = errors.New("dataeng: request is already closed")
	ErrIncomplete     = errors.New("dataeng: incomplete record")
	ErrFinished       = errors.New("dataeng: decoder is finished")
)

// Record is one complete application record. Content is set for output
// records (types 6 and 7); a zero-length type 6 record is a valid output
// stream terminator.
type Record struct {
	Type           uint8
	Request        uint16
	Content        []byte
	AppStatus      uint32
	ProtocolStatus uint8
}

// IsOutput reports whether the record carries output bytes.
func (r Record) IsOutput() bool {
	return r.Type == TypeOutput || r.Type == TypeOutputContinuation
}

// IsOutputEnd reports whether the record is a type 6 output stream
// terminator. The terminator is a real record and is never skipped.
func (r Record) IsOutputEnd() bool {
	return r.Type == TypeOutput && len(r.Content) == 0
}

// RequestID returns the request number carried by the record.
func (r Record) RequestID() uint16 {
	return r.Request
}

// RequestNumber is an alias for RequestID.
func (r Record) RequestNumber() uint16 {
	return r.Request
}

// ApplicationStatus returns the status carried by a type 3 record.
func (r Record) ApplicationStatus() uint32 {
	return r.AppStatus
}

// Status returns the application and protocol status from a type 3 record.
func (r Record) Status() (app uint32, protocol uint8) {
	return r.AppStatus, r.ProtocolStatus
}

// Data is an alias for Content.
func (r Record) Data() []byte {
	return r.Content
}

// Payload is an alias for Content.
func (r Record) Payload() []byte {
	return r.Content
}

type state uint8

const (
	stateHeader state = iota
	stateContent
	statePadding
)

// Decoder incrementally decodes application records. A Decoder is not safe
// for concurrent use. Once Push or Finish returns an error, the Decoder
// remains stopped; records delivered before the failure stay available.
type Decoder struct {
	// MaxContent is the host's maximum permitted content length. A zero
	// Decoder uses the protocol's uint16 maximum unless a constructor or
	// SetMaxContent supplied an explicit limit.
	MaxContent int

	maxContentSet bool
	header        [HeaderSize]byte
	headerLen     int
	state         state

	currentType      uint8
	currentRequest   uint16
	content          []byte
	contentRemaining int
	paddingRemaining int

	closed   map[uint16]struct{}
	records  []Record
	sink     func(Record)
	err      error
	finished bool
}

// NewDecoder creates a Decoder. With no argument it accepts any content
// length representable by the uint16 header field. With an argument, that
// value is the host's maxContent limit.
func NewDecoder(maxContent ...int) *Decoder {
	d := &Decoder{MaxContent: defaultMaxContent}
	if len(maxContent) > 0 && maxContent[0] >= 0 {
		d.MaxContent = maxContent[0]
		d.maxContentSet = true
	}
	return d
}

// New is an alias for NewDecoder.
func New(maxContent ...int) *Decoder {
	return NewDecoder(maxContent...)
}

// NewParser is an alias for NewDecoder.
func NewParser(maxContent ...int) *Decoder {
	return NewDecoder(maxContent...)
}

// NewCollector is an alias for NewDecoder.
func NewCollector(maxContent ...int) *Decoder {
	return NewDecoder(maxContent...)
}

// Parser, Collector, and StreamDecoder are aliases for Decoder.
type Parser = Decoder
type Collector = Decoder
type StreamDecoder = Decoder

// RecordDecoder is an alias for Decoder.
type RecordDecoder = Decoder

// Event and OutputRecord are aliases for Record.
type Event = Record
type OutputRecord = Record

// NewRecordDecoder is an alias for NewDecoder.
func NewRecordDecoder(maxContent ...int) *Decoder {
	return NewDecoder(maxContent...)
}

// SetMaxContent changes the host content limit for records that have not
// started yet.
func (d *Decoder) SetMaxContent(maxContent int) {
	if maxContent < 0 {
		maxContent = 0
	}
	d.MaxContent = maxContent
	d.maxContentSet = true
}

// OnRecord installs a callback for records delivered after this call. The
// callback receives a private copy of Content.
func (d *Decoder) OnRecord(fn func(Record)) {
	d.sink = fn
}

// SetHandler is an alias for OnRecord.
func (d *Decoder) SetHandler(fn func(Record)) {
	d.OnRecord(fn)
}

// SetSink is an alias for OnRecord.
func (d *Decoder) SetSink(fn func(Record)) {
	d.OnRecord(fn)
}

func (d *Decoder) limit() int {
	if d.maxContentSet {
		return d.MaxContent
	}
	if d.MaxContent > 0 {
		return d.MaxContent
	}
	return defaultMaxContent
}

func (d *Decoder) fail(err error) error {
	if d.err == nil {
		d.err = err
	}
	return d.err
}

// Push feeds a chunk of input to the Decoder. Chunks may end anywhere,
// including in the middle of a header, content, or padding. Complete
// records are delivered as soon as their padding has been consumed.
func (d *Decoder) Push(p []byte) error {
	if d.err != nil {
		return d.err
	}
	if d.finished {
		return d.fail(fmt.Errorf("%w: Push called after Finish", ErrFinished))
	}

	for len(p) > 0 {
		switch d.state {
		case stateHeader:
			n := copy(d.header[d.headerLen:], p)
			d.headerLen += n
			p = p[n:]

			if d.headerLen >= 1 && d.header[0] != Version {
				return d.fail(fmt.Errorf("%w: got %d", ErrInvalidVersion, d.header[0]))
			}
			if d.headerLen >= 2 {
				switch d.header[1] {
				case TypeStatus, TypeOutput, TypeOutputContinuation:
				default:
					return d.fail(fmt.Errorf("%w: got %d", ErrInvalidType, d.header[1]))
				}
			}
			// The content length is readable as soon as header bytes
			// 4 and 5 have arrived. Reject an oversized declaration
			// here, before waiting for the rest of the header or
			// allocating anything based on the declaration.
			if d.headerLen >= 6 {
				declared := int(binary.BigEndian.Uint16(d.header[4:6]))
				if declared > d.limit() {
					return d.fail(fmt.Errorf("%w: declared %d, limit %d", ErrMaxContent, declared, d.limit()))
				}
			}
			if d.headerLen < HeaderSize {
				continue
			}
			if err := d.beginRecord(); err != nil {
				return err
			}

		case stateContent:
			n := len(p)
			if n > d.contentRemaining {
				n = d.contentRemaining
			}
			d.content = append(d.content, p[:n]...)
			d.contentRemaining -= n
			p = p[n:]
			if d.contentRemaining == 0 {
				if d.paddingRemaining == 0 {
					if err := d.deliver(); err != nil {
						return err
					}
				} else {
					d.state = statePadding
				}
			}

		case statePadding:
			n := len(p)
			if n > d.paddingRemaining {
				n = d.paddingRemaining
			}
			d.paddingRemaining -= n
			p = p[n:]
			if d.paddingRemaining == 0 {
				if err := d.deliver(); err != nil {
					return err
				}
			}
		}
	}

	return nil
}

func (d *Decoder) beginRecord() error {
	if d.header[0] != Version {
		return d.fail(fmt.Errorf("%w: got %d", ErrInvalidVersion, d.header[0]))
	}

	typ := d.header[1]
	switch typ {
	case TypeStatus, TypeOutput, TypeOutputContinuation:
	default:
		return d.fail(fmt.Errorf("%w: got %d", ErrInvalidType, typ))
	}

	request := binary.BigEndian.Uint16(d.header[2:4])
	contentLen := int(binary.BigEndian.Uint16(d.header[4:6]))
	paddingLen := int(d.header[6])

	if d.header[7] != 0 {
		return d.fail(fmt.Errorf("%w: got %d", ErrReserved, d.header[7]))
	}
	if contentLen > d.limit() {
		return d.fail(fmt.Errorf("%w: declared %d, limit %d", ErrMaxContent, contentLen, d.limit()))
	}
	if typ == TypeStatus && contentLen != 8 {
		return d.fail(fmt.Errorf("%w: got %d", ErrStatusLength, contentLen))
	}
	if _, ok := d.closed[request]; ok {
		return d.fail(fmt.Errorf("%w: request %d", ErrRequestClosed, request))
	}

	d.currentType = typ
	d.currentRequest = request
	d.content = nil
	d.contentRemaining = contentLen
	d.paddingRemaining = paddingLen
	d.headerLen = 0

	switch {
	case contentLen > 0:
		d.state = stateContent
	case paddingLen > 0:
		d.state = statePadding
	default:
		d.state = stateHeader
		return d.deliver()
	}
	return nil
}

func (d *Decoder) deliver() error {
	rec := Record{
		Type:    d.currentType,
		Request: d.currentRequest,
	}

	if rec.Type == TypeStatus {
		if len(d.content) != 8 {
			return d.fail(fmt.Errorf("%w: got %d", ErrStatusLength, len(d.content)))
		}
		rec.AppStatus = binary.BigEndian.Uint32(d.content[0:4])
		rec.ProtocolStatus = d.content[4]
		if d.closed == nil {
			d.closed = make(map[uint16]struct{})
		}
		d.closed[d.currentRequest] = struct{}{}
	} else {
		rec.Content = d.content
	}

	d.content = nil
	d.contentRemaining = 0
	d.paddingRemaining = 0
	d.currentType = 0
	d.currentRequest = 0
	d.state = stateHeader

	d.records = append(d.records, rec)
	if d.sink != nil {
		delivered := rec
		if len(rec.Content) > 0 {
			delivered.Content = append([]byte(nil), rec.Content...)
		}
		d.sink(delivered)
	}
	return nil
}

// Finish validates that no partial record is pending. A successful Finish
// makes the Decoder immutable; a failed Finish stops it permanently.
func (d *Decoder) Finish() error {
	if d.err != nil {
		return d.err
	}
	if d.finished {
		return nil
	}
	if d.state != stateHeader || d.headerLen != 0 ||
		d.contentRemaining != 0 || d.paddingRemaining != 0 {
		return d.fail(fmt.Errorf(
			"%w: header=%d content=%d padding=%d",
			ErrIncomplete, d.headerLen, d.contentRemaining, d.paddingRemaining,
		))
	}
	d.finished = true
	return nil
}

// Close is an alias for Finish.
func (d *Decoder) Close() error {
	return d.Finish()
}

// Feed is an alias for Push.
func (d *Decoder) Feed(p []byte) error {
	return d.Push(p)
}

// Write implements io.Writer by forwarding bytes to Push.
func (d *Decoder) Write(p []byte) (int, error) {
	if err := d.Push(p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Records returns a copy of the delivered record list. Content slices refer
// to storage owned by the Decoder and must not be mutated by the caller.
func (d *Decoder) Records() []Record {
	out := make([]Record, len(d.records))
	copy(out, d.records)
	return out
}

// Deliveries is an alias for Records.
func (d *Decoder) Deliveries() []Record {
	return d.Records()
}

// Events is an alias for Records.
func (d *Decoder) Events() []Record {
	return d.Records()
}

// Outputs returns the delivered output records of types 6 and 7.
func (d *Decoder) Outputs() []Record {
	out := make([]Record, 0, len(d.records))
	for _, rec := range d.records {
		if rec.IsOutput() {
			out = append(out, rec)
		}
	}
	return out
}

// TakeRecords returns the delivered records and clears the retained list.
func (d *Decoder) TakeRecords() []Record {
	out := d.records
	d.records = nil
	return out
}

// Err returns the terminal error, if any.
func (d *Decoder) Err() error {
	return d.err
}

// Failed reports whether the Decoder has stopped after an error.
func (d *Decoder) Failed() bool {
	return d.err != nil
}

// Decode consumes data as one uninterrupted stream and returns all delivered
// records. The returned records are available even when an error is returned.
func Decode(data []byte, maxContent ...int) ([]Record, error) {
	d := NewDecoder(maxContent...)
	if err := d.Push(data); err != nil {
		return d.Records(), err
	}
	if err := d.Finish(); err != nil {
		return d.Records(), err
	}
	return d.Records(), nil
}

// Parse is an alias for Decode.
func Parse(data []byte, maxContent ...int) ([]Record, error) {
	return Decode(data, maxContent...)
}
