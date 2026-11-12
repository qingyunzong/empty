package dataeng

import "fmt"

type decoderState uint8

const (
	readingLength decoderState = iota
	readingPayload
)

// Decoder incrementally separates octet-counted frames and parses their
// payloads. A Decoder is not safe for concurrent use.
//
// Feed may be called with chunks of any size. Complete messages are returned
// in order. On the first error the decoder stops permanently; messages
// returned before that error remain valid.
type Decoder struct {
	maxMessageBytes int

	state        decoderState
	lengthValue  int64
	lengthDigits int
	payload      []byte
	payloadNeed  int

	stopped error
	done    bool
}

// NewDecoder creates a decoder whose maximum accepted payload length is
// maxMessageBytes. Payload lengths above this value are rejected as soon as
// their decimal prefix makes them known.
func NewDecoder(maxMessageBytes int) *Decoder {
	if maxMessageBytes < 0 {
		maxMessageBytes = 0
	}
	return &Decoder{maxMessageBytes: maxMessageBytes}
}

// MaxMessageBytes returns the configured payload size limit.
func (d *Decoder) MaxMessageBytes() int {
	return d.maxMessageBytes
}

// Feed consumes a chunk and returns every message completed by it. It returns
// nil for no messages. Once an error is returned, every later Feed or Finish
// returns that same error.
func (d *Decoder) Feed(chunk []byte) ([]Message, error) {
	if d.stopped != nil {
		return nil, d.stopped
	}
	if d.done {
		return nil, ErrFinished
	}

	var messages []Message
	for len(chunk) > 0 {
		switch d.state {
		case readingLength:
			b := chunk[0]
			chunk = chunk[1:]

			if d.lengthDigits == 0 {
				if b < '0' || b > '9' {
					return messages, d.fail(fmt.Sprintf("length must start with a decimal digit, got 0x%02x", b))
				}
				if b == '0' {
					return messages, d.fail("length must be greater than zero and have no leading zero")
				}
				d.lengthValue = int64(b - '0')
				d.lengthDigits = 1
				if d.lengthValue > int64(d.maxMessageBytes) {
					return messages, d.fail(fmt.Sprintf("declared length %d exceeds maximum %d", d.lengthValue, d.maxMessageBytes))
				}
				continue
			}

			if b >= '0' && b <= '9' {
				if d.lengthDigits == 9 {
					return messages, d.fail("length has more than 9 digits")
				}
				d.lengthValue = d.lengthValue*10 + int64(b-'0')
				d.lengthDigits++
				if d.lengthValue > int64(d.maxMessageBytes) {
					return messages, d.fail(fmt.Sprintf("declared length %d exceeds maximum %d", d.lengthValue, d.maxMessageBytes))
				}
				continue
			}
			if b != ' ' {
				return messages, d.fail(fmt.Sprintf("length must be followed by one 0x20, got 0x%02x", b))
			}

			d.state = readingPayload
			d.payloadNeed = int(d.lengthValue)
			d.payload = nil

		case readingPayload:
			take := d.payloadNeed - len(d.payload)
			if take > len(chunk) {
				take = len(chunk)
			}
			if take > 0 {
				if d.payload == nil {
					d.payload = make([]byte, 0, take)
				}
				d.payload = append(d.payload, chunk[:take]...)
				chunk = chunk[take:]
			}
			if len(d.payload) < d.payloadNeed {
				continue
			}

			message, err := ParseMessage(d.payload)
			d.resetFrame()
			if err != nil {
				d.stopped = err
				return messages, err
			}
			messages = append(messages, message)

		default:
			return messages, d.fail("invalid decoder state")
		}
	}

	return messages, nil
}

// Push is an alias for Feed.
func (d *Decoder) Push(chunk []byte) ([]Message, error) {
	return d.Feed(chunk)
}

// Finish verifies that the input ended exactly on a frame boundary. A partial
// length prefix or payload causes ErrIncomplete.
func (d *Decoder) Finish() error {
	if d.stopped != nil {
		return d.stopped
	}
	if d.done {
		return nil
	}
	if d.state != readingLength || d.lengthDigits != 0 || len(d.payload) != 0 {
		d.resetFrame()
		d.done = true
		d.stopped = ErrIncomplete
		return ErrIncomplete
	}
	d.done = true
	return nil
}

// Close is an alias for Finish.
func (d *Decoder) Close() error {
	return d.Finish()
}

func (d *Decoder) fail(reason string) error {
	err := &FrameError{Reason: reason}
	d.stopped = err
	return err
}

func (d *Decoder) resetFrame() {
	d.state = readingLength
	d.lengthValue = 0
	d.lengthDigits = 0
	d.payload = nil
	d.payloadNeed = 0
}
