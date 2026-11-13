package dataeng

import (
	"errors"
	"fmt"
)

// Field is a single tag=value field. Value never contains 0x01 and may be empty.
type Field struct {
	Tag   int
	Value string
}

// Message is one validated, fully received message. Raw is the exact byte
// sequence of the message including its terminating 0x01 on tag 10.
type Message struct {
	Raw    []byte
	Fields []Field
}

// Errors returned by the collector. All failures are terminal for the collector.
var (
	ErrTruncated   = errors.New("unfinished message at Finish")
	ErrMaxBody     = errors.New("declared body length exceeds maxBody")
	ErrBodyLength  = errors.New("body length mismatch")
	ErrChecksum    = errors.New("checksum mismatch")
	ErrMalformed   = errors.New("malformed field or message")
	ErrChecksumTag = errors.New("invalid checksum tag 10 value")
)

const soh = byte(0x01)

type parsePhase int

const (
	phaseTag parsePhase = iota
	phaseValue
)

// Collector incrementally ingests message bytes via Push. It is safe only for
// single-goroutine use; it holds no session state beyond the partial message.
// A parse failure stops the collector permanently, while messages already
// delivered remain available through Messages.
type Collector struct {
	maxBody int

	phase    parsePhase
	value    []byte
	tag      int
	seenEq   bool
	tagValid bool

	raw          []byte
	fields       []Field
	fieldCount   int
	declaredBody int
	bodyCount    int
	bodyAtField  int
	sum          int
	sumAtField   int
	has35        bool
	failed       bool
	failErr      error
	messages     []Message
}

// NewCollector creates a collector whose accepted declared body length is at
// most maxBody bytes.
func NewCollector(maxBody int) *Collector {
	return &Collector{maxBody: maxBody, phase: phaseTag}
}

// Push feeds a chunk that may begin, continue, or end one or more messages and
// may stop in the middle of a field. It returns the number of messages that
// became complete during this chunk and the first error encountered. On error
// the collector stops; already delivered messages are retained.
func (c *Collector) Push(chunk []byte) (int, error) {
	if c.failed {
		return 0, c.failErr
	}
	delivered := 0
	for _, b := range chunk {
		done, err := c.feed(b)
		if done {
			delivered++
		}
		if err != nil {
			c.fail(err)
			return delivered, err
		}
	}
	return delivered, nil
}

// Finish signals end of input. It fails if a message is only partially present.
func (c *Collector) Finish() error {
	if c.failed {
		return c.failErr
	}
	if len(c.raw) != 0 || c.phase == phaseValue || c.seenEq {
		c.fail(ErrTruncated)
		return ErrTruncated
	}
	return nil
}

// Messages returns a copy of every message delivered so far.
func (c *Collector) Messages() []Message {
	out := make([]Message, len(c.messages))
	for i, m := range c.messages {
		raw := make([]byte, len(m.Raw))
		copy(raw, m.Raw)
		fields := append([]Field(nil), m.Fields...)
		out[i] = Message{Raw: raw, Fields: fields}
	}
	return out
}

// Err returns the terminal failure, or nil.
func (c *Collector) Err() error { return c.failErr }

func (c *Collector) fail(err error) {
	c.failed = true
	c.failErr = err
}

func (c *Collector) feed(b byte) (bool, error) {
	c.raw = append(c.raw, b)
	c.sum = (c.sum + int(b)) & 0xff
	// The body starts immediately after the 0x01 that ends tag 9. Tag 10's
	// own bytes are excluded via the snapshot taken at that field boundary.
	if c.fieldCount >= 2 {
		c.bodyCount++
	}

	switch c.phase {
	case phaseTag:
		if b == '=' {
			if !c.tagValid {
				return false, fmt.Errorf("%w: empty tag", ErrMalformed)
			}
			c.phase = phaseValue
			c.seenEq = true
			return false, nil
		}
		if b < '0' || b > '9' {
			return false, fmt.Errorf("%w: non-digit tag byte 0x%02x", ErrMalformed, b)
		}
		if c.tagValid && c.tag == 0 {
			return false, fmt.Errorf("%w: tag has leading zero", ErrMalformed)
		}
		d := int(b - '0')
		if c.tag > (1<<31-1-d)/10 {
			return false, fmt.Errorf("%w: tag overflow", ErrMalformed)
		}
		if c.tagValid {
			c.tag = c.tag*10 + d
		} else {
			c.tagValid = true
			c.tag = d
		}
		return false, nil

	case phaseValue:
		if b != soh {
			c.value = append(c.value, b)
			return false, nil
		}
		return c.completeField()
	}
	return false, fmt.Errorf("%w: unknown parser phase", ErrMalformed)
}

func (c *Collector) completeField() (bool, error) {
	tag := c.tag
	value := string(c.value)
	index := c.fieldCount // 0: tag8, 1: tag9, 2: first body field (tag35)
	fieldSumStart := c.sumAtField
	fieldBodyStart := c.bodyAtField

	switch {
	case index == 0:
		if tag != 8 || (value != "FIX.4.2" && value != "FIX.4.4") {
			return false, fmt.Errorf("%w: message must start with tag 8 set to FIX.4.2 or FIX.4.4", ErrMalformed)
		}
	case index == 1:
		if tag != 9 {
			return false, fmt.Errorf("%w: tag 9 must follow tag 8", ErrMalformed)
		}
		n, ok := parseDecimal(value)
		if !ok {
			return false, fmt.Errorf("%w: tag 9 body length is not a decimal number", ErrMalformed)
		}
		if n > c.maxBody {
			return false, fmt.Errorf("%w: declared %d > maxBody %d", ErrMaxBody, n, c.maxBody)
		}
		c.declaredBody = n
	case tag == 10:
		if index < 3 {
			return false, fmt.Errorf("%w: tag 10 before required header fields", ErrMalformed)
		}
		if !c.has35 {
			return false, fmt.Errorf("%w: tag 35 must be the first field after the body length", ErrMalformed)
		}
		if len(value) != 3 {
			return false, fmt.Errorf("%w: tag 10 value must be exactly three digits", ErrChecksumTag)
		}
		want, ok := parseThreeDigits(value)
		if !ok || want > 255 {
			return false, fmt.Errorf("%w: tag 10 value %q out of range 000..255", ErrChecksumTag, value)
		}
		// Bytes of the tag 10 field must be excluded from both the body
		// length and the checksum range.
		body := fieldBodyStart
		if body != c.declaredBody {
			return false, fmt.Errorf("%w: declared %d, counted %d", ErrBodyLength, c.declaredBody, body)
		}
		got := fieldSumStart
		if got != want {
			return false, fmt.Errorf("%w: tag 10 declares %03d, unsigned byte sum is %03d", ErrChecksum, want, got)
		}

		c.fields = append(c.fields, Field{Tag: tag, Value: value})
		msg := Message{
			Raw:    append([]byte(nil), c.raw...),
			Fields: append([]Field(nil), c.fields...),
		}
		c.messages = append(c.messages, msg)
		c.resetMessage()
		return true, nil
	default:
		if tag == 8 || tag == 9 {
			return false, fmt.Errorf("%w: tag %d is reserved for the message header", ErrMalformed, tag)
		}
		if index == 2 {
			if tag != 35 {
				return false, fmt.Errorf("%w: tag 35 must be the first field after the body length", ErrMalformed)
			}
			if value == "" {
				return false, fmt.Errorf("%w: tag 35 value must be non-empty", ErrMalformed)
			}
			c.has35 = true
		} else if tag == 35 {
			return false, fmt.Errorf("%w: tag 35 must not repeat", ErrMalformed)
		}
	}

	c.fields = append(c.fields, Field{Tag: tag, Value: value})
	c.fieldCount = index + 1
	c.resetField()
	return false, nil
}

func (c *Collector) resetField() {
	c.tag = 0
	c.tagValid = false
	c.seenEq = false
	c.value = c.value[:0]
	c.phase = phaseTag
	c.sumAtField = c.sum
	c.bodyAtField = c.bodyCount
}

func (c *Collector) resetMessage() {
	c.raw = c.raw[:0]
	c.fields = c.fields[:0]
	c.fieldCount = 0
	c.declaredBody = 0
	c.bodyCount = 0
	c.bodyAtField = 0
	c.sum = 0
	c.sumAtField = 0
	c.has35 = false
	c.tag = 0
	c.tagValid = false
	c.seenEq = false
	c.value = c.value[:0]
	c.phase = phaseTag
}

// parseDecimal accepts a no-leading-zero non-negative decimal, with "0" allowed.
func parseDecimal(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	n := 0
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch < '0' || ch > '9' {
			return 0, false
		}
		if i == 0 && len(s) > 1 && ch == '0' {
			return 0, false
		}
		d := int(ch - '0')
		if n > (1<<31-1-d)/10 {
			return 0, false
		}
		n = n*10 + d
	}
	return n, true
}

func parseThreeDigits(s string) (int, bool) {
	n := 0
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch < '0' || ch > '9' {
			return 0, false
		}
		n = n*10 + int(ch-'0')
	}
	return n, true
}
