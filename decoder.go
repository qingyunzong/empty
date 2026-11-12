package dataeng

import (
	"errors"
)

const (
	// defaultMaxMessage bounds the bytes retained for one message.
	defaultMaxMessage = 65535
	// defaultMaxRdata bounds one resource record's rdata length.
	defaultMaxRdata = 65535

	maxNameWire    = 255 // uncompressed name length including length octets
	maxNameJumps   = 16  // compression pointer jumps permitted per name
	headerLength   = 12
	qrMask         = 0x8000
	pointerMask    = 0xc0
	pointerValue   = 0xc0
	pointerLowBits = 0x3f
	labelMaxLength = 63
)

// Record types that receive dedicated rdata handling. All other types keep
// their rdata as untouched wire bytes.
const (
	TypeA    uint16 = 1
	TypeMX   uint16 = 15
	TypeAAAA uint16 = 28
)

// Sentinel errors returned for rejected input.
var (
	// ErrTruncated means the buffered bytes do not yet form a complete
	// message; Push keeps the prefix and waits for more bytes.
	ErrTruncated = errors.New("dataeng: message truncated")
	// ErrMalformed covers malformed wire format other than the named errors.
	ErrMalformed = errors.New("dataeng: malformed message")
	// ErrNotResponse means the flags' most significant bit is zero.
	ErrNotResponse = errors.New("dataeng: QR bit not set")
	// ErrPointer is returned for any invalid compression pointer.
	ErrPointer = errors.New("dataeng: invalid compression pointer")
	// ErrNameTooLong means the reconstructed name exceeds 255 wire octets.
	ErrNameTooLong = errors.New("dataeng: name exceeds 255 octets")
	// ErrRdataLength means a typed record's rdata has the wrong length.
	ErrRdataLength = errors.New("dataeng: unexpected rdata length")
	// ErrRdataTooLarge means rdlength exceeds Options.MaxRdata.
	ErrRdataTooLarge = errors.New("dataeng: rdata exceeds MaxRdata")
	// ErrMessageTooLarge means buffered bytes exceed Options.MaxMessage.
	ErrMessageTooLarge = errors.New("dataeng: message exceeds MaxMessage")
	// ErrStopped means a previous failure already stopped the Decoder.
	ErrStopped = errors.New("dataeng: decoder stopped")
)

// Options configures a Decoder. Zero values select the defaults.
type Options struct {
	MaxMessage int
	MaxRdata   int
}

// Header mirrors the fixed 12-byte DNS header in wire order.
type Header struct {
	ID      uint16
	Flags   uint16
	QDCount uint16
	ANCount uint16
	NSCount uint16
	ARCount uint16
}

// Question is one entry of the question section.
type Question struct {
	Name  string
	Type  uint16
	Class uint16
}

// Record is one resource record. Rdata always holds the original wire bytes.
// For type 15 (MX), Preference and Exchange are additionally decoded; the
// exchange name may itself use compression pointers.
type Record struct {
	Name       string
	Type       uint16
	Class      uint16
	TTL        uint32
	Rdata      []byte
	Preference uint16
	Exchange   string
}

// Message is one fully parsed DNS response.
type Message struct {
	Header     Header
	Questions  []Question
	Answers    []Record
	Authority  []Record
	Additional []Record
}

// Decoder reassembles a byte stream into complete messages. A Decoder is not
// safe for concurrent use.
type Decoder struct {
	maxMessage int
	maxRdata   int
	buf        []byte
	stopped    bool
}

// NewDecoder builds a Decoder with the given limits.
func NewDecoder(opts Options) *Decoder {
	maxMessage := opts.MaxMessage
	if maxMessage <= 0 {
		maxMessage = defaultMaxMessage
	}
	maxRdata := opts.MaxRdata
	if maxRdata <= 0 {
		maxRdata = defaultMaxRdata
	}
	return &Decoder{maxMessage: maxMessage, maxRdata: maxRdata}
}

// Push appends chunk, retains any prefix of an incomplete message, and returns
// every message completed by this chunk. On a hard error no partial message is
// delivered for the failing data and the Decoder stops permanently.
func (d *Decoder) Push(chunk []byte) ([]Message, error) {
	if d.stopped {
		return nil, ErrStopped
	}
	d.buf = append(d.buf, chunk...)
	if len(d.buf) > d.maxMessage {
		d.stopped = true
		return nil, ErrMessageTooLarge
	}

	var delivered []Message
	base := 0
	for len(d.buf)-base >= headerLength {
		msg, end, err := parseOne(d.buf, base, d.maxRdata)
		switch {
		case errors.Is(err, ErrTruncated):
			// Wait for more bytes; the prefix stays buffered.
			d.buf = d.buf[base:]
			return delivered, nil
		case err != nil:
			d.stopped = true
			return delivered, err
		}
		base = end
		remaining := len(d.buf) - base
		if remaining > 0 && remaining < headerLength {
			// The last message is complete but leaves bytes that can never be
			// a header: counts and actual bytes disagree, so fail hard.
			d.stopped = true
			return delivered, ErrMalformed
		}
		delivered = append(delivered, msg)
	}
	// Keep only the unconsumed prefix for the next Push.
	d.buf = d.buf[base:]
	return delivered, nil
}

// Finish fails when bytes remain for an unfinished message. A truncation does
// not stop the Decoder, but any earlier hard failure stays sticky.
func (d *Decoder) Finish() error {
	if d.stopped {
		return ErrStopped
	}
	if len(d.buf) > 0 {
		return ErrTruncated
	}
	return nil
}
