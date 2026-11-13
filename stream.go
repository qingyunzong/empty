package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// binaryMarker starts a binary frame only at a message boundary.
const binaryMarker byte = 0x24

// MessageKind identifies the protocol shape of a decoded message.
type MessageKind uint8

const (
	// TextMessage is a CRLF-delimited text message.
	TextMessage MessageKind = iota
	// BinaryMessage is a length-prefixed binary frame.
	BinaryMessage
)

// Short aliases for callers that prefer Kind-prefixed names.
const (
	KindText   = TextMessage
	KindBinary = BinaryMessage
)

// Message is a decoded text message or binary frame. Channel is meaningful
// only for binary messages; StartLine and Headers are meaningful only for
// text messages. Body always contains raw bytes.
type Message struct {
	Kind      MessageKind
	Channel   byte
	StartLine string
	Headers   map[string]string
	Body      []byte
}

// IsBinary reports whether the message is a binary frame.
func (m Message) IsBinary() bool {
	return m.Kind == BinaryMessage
}

// Header looks up a text header by case-insensitive name.
func (m Message) Header(name string) (string, bool) {
	value, ok := m.Headers[strings.ToLower(name)]
	return value, ok
}

var (
	// ErrIncomplete means Finish was called in the middle of a message.
	ErrIncomplete = errors.New("dataeng: incomplete message")
	// ErrFrameTooLarge means a binary frame declared more than MaxFrame bytes.
	ErrFrameTooLarge = errors.New("dataeng: binary frame exceeds maxFrame")
	// ErrInvalidUTF8 means a text start line or header was not strict UTF-8.
	ErrInvalidUTF8 = errors.New("dataeng: text line is not valid UTF-8")
	// ErrLoneCR means a carriage return was not followed by a line feed.
	ErrLoneCR = errors.New("dataeng: lone CR in text message")
	// ErrBareLF means a line feed was not preceded by a carriage return.
	ErrBareLF = errors.New("dataeng: LF without preceding CR")
	// ErrMalformedHeader means a header line had no separator or empty name.
	ErrMalformedHeader = errors.New("dataeng: malformed header")
	// ErrDuplicateContentLength means content-length appeared more than once.
	ErrDuplicateContentLength = errors.New("dataeng: duplicate content-length")
	// ErrInvalidContentLength means content-length was not a canonical decimal.
	ErrInvalidContentLength = errors.New("dataeng: invalid content-length")
	// ErrFinished is returned when Push is called after a successful Finish.
	ErrFinished = errors.New("dataeng: decoder already finished")
)

type parserState uint8

const (
	stateBoundary parserState = iota
	stateBinaryChannel
	stateBinaryLengthHigh
	stateBinaryLengthLow
	stateBinaryPayload
	stateTextStartLine
	stateTextHeaders
	stateTextBody
)

// Decoder incrementally parses a stream of binary frames and text messages.
// The zero value accepts only zero-length binary frames; use NewDecoder to
// configure MaxFrame. A Decoder is not safe for concurrent use.
type Decoder struct {
	// MaxFrame is the largest binary payload accepted, in bytes.
	MaxFrame int

	state         parserState
	line          []byte
	lineHasCR     bool
	startLine     string
	headers       map[string]string
	contentLength int
	hasContentLen bool
	body          []byte
	remaining     int
	binaryChannel byte
	binaryLength  uint16
	binaryBody    []byte

	delivered []Message
	err       error
	finished  bool
}

// NewDecoder creates a decoder that accepts binary payloads up to maxFrame
// bytes. A negative maxFrame rejects every binary frame, including empty ones.
func NewDecoder(maxFrame int) *Decoder {
	return &Decoder{MaxFrame: maxFrame}
}

// New is shorthand for NewDecoder.
func New(maxFrame int) *Decoder {
	return NewDecoder(maxFrame)
}

// Parser is an alias for Decoder.
type Parser = Decoder

// NewParser is shorthand for NewDecoder.
func NewParser(maxFrame int) *Parser {
	return NewDecoder(maxFrame)
}

// Push feeds one stream chunk to the decoder and returns all messages completed
// by this call. If parsing fails, messages completed earlier in the same call
// are still returned alongside the error. Any later Push returns the same
// error, and Finish also fails.
func (d *Decoder) Push(chunk []byte) ([]Message, error) {
	if d.err != nil {
		return nil, d.err
	}
	if d.finished {
		return nil, ErrFinished
	}

	var completed []Message
	for i := 0; i < len(chunk); {
		switch d.state {
		case stateBoundary:
			if chunk[i] == binaryMarker {
				d.beginBinary()
				i++
			} else {
				d.beginText()
			}

		case stateBinaryChannel:
			d.binaryChannel = chunk[i]
			i++
			d.state = stateBinaryLengthHigh

		case stateBinaryLengthHigh:
			d.binaryLength = uint16(chunk[i]) << 8
			i++
			d.state = stateBinaryLengthLow

		case stateBinaryLengthLow:
			d.binaryLength |= uint16(chunk[i])
			i++
			if int(d.binaryLength) > d.MaxFrame {
				err := fmt.Errorf("%w: declared %d, limit %d", ErrFrameTooLarge, d.binaryLength, d.MaxFrame)
				d.stop(err)
				return completed, err
			}
			d.binaryBody = make([]byte, 0, int(d.binaryLength))
			d.remaining = int(d.binaryLength)
			if d.remaining == 0 {
				d.emitBinary(&completed)
			} else {
				d.state = stateBinaryPayload
			}

		case stateBinaryPayload:
			n := d.remaining
			if available := len(chunk) - i; available < n {
				n = available
			}
			d.binaryBody = append(d.binaryBody, chunk[i:i+n]...)
			i += n
			d.remaining -= n
			if d.remaining == 0 {
				d.emitBinary(&completed)
			}

		case stateTextStartLine, stateTextHeaders:
			b := chunk[i]
			i++
			if d.lineHasCR {
				if b != '\n' {
					err := fmt.Errorf("%w: byte after CR is %#x", ErrLoneCR, b)
					d.stop(err)
					return completed, err
				}
				d.lineHasCR = false
				line := d.line
				d.line = d.line[:0]
				if err := d.finishLine(line, &completed); err != nil {
					d.stop(err)
					return completed, err
				}
				continue
			}
			switch b {
			case '\r':
				d.lineHasCR = true
			case '\n':
				err := fmt.Errorf("%w", ErrBareLF)
				d.stop(err)
				return completed, err
			default:
				d.line = append(d.line, b)
			}

		case stateTextBody:
			n := d.remaining
			if available := len(chunk) - i; available < n {
				n = available
			}
			d.body = append(d.body, chunk[i:i+n]...)
			i += n
			d.remaining -= n
			if d.remaining == 0 {
				d.emitText(&completed)
			}
		}
	}

	return completed, nil
}

// Finish verifies that the stream ended at a message boundary. It returns
// ErrIncomplete if a binary frame or text message is still in progress.
func (d *Decoder) Finish() error {
	if d.err != nil {
		return d.err
	}
	if d.finished {
		return nil
	}
	if d.state != stateBoundary {
		err := fmt.Errorf("%w: parser state %d", ErrIncomplete, d.state)
		d.stop(err)
		return err
	}
	d.finished = true
	return nil
}

// Delivered returns a snapshot of every message delivered so far, including
// messages completed before an error. Returned messages are not regenerated.
func (d *Decoder) Delivered() []Message {
	return append([]Message(nil), d.delivered...)
}

// Err returns the sticky parse error, or nil if the decoder has not failed.
func (d *Decoder) Err() error {
	return d.err
}

func (d *Decoder) beginBinary() {
	d.state = stateBinaryChannel
	d.binaryBody = nil
	d.binaryChannel = 0
	d.binaryLength = 0
	d.remaining = 0
}

func (d *Decoder) beginText() {
	d.state = stateTextStartLine
	d.line = d.line[:0]
	d.lineHasCR = false
	d.startLine = ""
	d.headers = make(map[string]string)
	d.contentLength = 0
	d.hasContentLen = false
	d.body = nil
	d.remaining = 0
}

func (d *Decoder) finishLine(line []byte, completed *[]Message) error {
	switch d.state {
	case stateTextStartLine:
		if !utf8.Valid(line) {
			return fmt.Errorf("%w: start line", ErrInvalidUTF8)
		}
		d.startLine = string(line)
		d.state = stateTextHeaders
		return nil

	case stateTextHeaders:
		if len(line) == 0 {
			d.state = stateTextBody
			if d.hasContentLen && d.contentLength > 0 {
				d.remaining = d.contentLength
				d.body = nil
				return nil
			}
			d.emitText(completed)
			return nil
		}
		return d.parseHeader(line)
	}
	return nil
}

func (d *Decoder) parseHeader(line []byte) error {
	if !utf8.Valid(line) {
		return fmt.Errorf("%w: header line", ErrInvalidUTF8)
	}
	colon := bytes.IndexByte(line, ':')
	if colon < 1 {
		return fmt.Errorf("%w: missing colon or empty name", ErrMalformedHeader)
	}

	name := strings.ToLower(string(line[:colon]))
	value := line[colon+1:]
	if len(value) > 0 && value[0] == ' ' {
		value = value[1:]
	}

	if name == "content-length" {
		if d.hasContentLen {
			return ErrDuplicateContentLength
		}
		n, err := parseContentLength(value)
		if err != nil {
			return err
		}
		d.contentLength = n
		d.hasContentLen = true
	}

	d.headers[name] = string(value)
	return nil
}

func parseContentLength(value []byte) (int, error) {
	if len(value) == 0 {
		return 0, fmt.Errorf("%w: empty value", ErrInvalidContentLength)
	}
	if len(value) > 1 && value[0] == '0' {
		return 0, fmt.Errorf("%w: leading zero in %q", ErrInvalidContentLength, value)
	}
	for _, b := range value {
		if b < '0' || b > '9' {
			return 0, fmt.Errorf("%w: %q is not decimal", ErrInvalidContentLength, value)
		}
	}

	n, err := strconv.ParseUint(string(value), 10, 64)
	if err != nil || n > uint64(maxInt) {
		return 0, fmt.Errorf("%w: %q is too large", ErrInvalidContentLength, value)
	}
	return int(n), nil
}

var maxInt = int(^uint(0) >> 1)

func (d *Decoder) emitBinary(completed *[]Message) {
	body := d.binaryBody
	if len(body) == 0 {
		body = nil
	}
	message := Message{
		Kind:    BinaryMessage,
		Channel: d.binaryChannel,
		Body:    body,
	}
	d.binaryBody = nil
	d.binaryChannel = 0
	d.binaryLength = 0
	d.remaining = 0
	d.state = stateBoundary
	d.deliver(message, completed)
}

func (d *Decoder) emitText(completed *[]Message) {
	body := d.body
	if len(body) == 0 {
		body = nil
	}
	message := Message{
		Kind:      TextMessage,
		StartLine: d.startLine,
		Headers:   d.headers,
		Body:      body,
	}
	d.startLine = ""
	d.headers = nil
	d.body = nil
	d.contentLength = 0
	d.hasContentLen = false
	d.remaining = 0
	d.state = stateBoundary
	d.deliver(message, completed)
}

func (d *Decoder) deliver(message Message, completed *[]Message) {
	*completed = append(*completed, message)
	d.delivered = append(d.delivered, message)
}

func (d *Decoder) stop(err error) {
	d.err = err
}
