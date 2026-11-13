package dataeng

import (
	"encoding/binary"
	"errors"
	"unicode/utf8"
)

// Opcode identifies the operation represented by a WebSocket frame. It is an
// alias for byte so callers can compare it directly with their own byte values.
type Opcode = byte

const (
	OpContinuation Opcode = 0
	OpText         Opcode = 1
	OpBinary       Opcode = 2
	OpClose        Opcode = 8
	OpPing         Opcode = 9
	OpPong         Opcode = 10
)

// DefaultMaxPayload is used by constructors when no payload limit is supplied.
const DefaultMaxPayload = 16 << 20

// Frame is a complete client WebSocket frame with an unmasked payload.
// Fragmented data frames are returned with their wire opcode: the first
// frame has OpText or OpBinary, and later fragments have OpContinuation.
type Frame struct {
	Opcode  Opcode
	Payload []byte
	Fin     bool
}

var (
	ErrFinished = errors.New("frame decoder has been finished")

	ErrReservedBits = errors.New("reserved frame bits are not zero")
	ErrMaskRequired = errors.New("client frame is not masked")
	ErrBadOpcode    = errors.New("unsupported frame opcode")

	ErrControlFin     = errors.New("control frame is fragmented")
	ErrControlTooLong = errors.New("control frame payload exceeds 125 bytes")

	ErrNonCanonicalLength126 = errors.New("extended length 126 is less than 126")
	ErrExtendedLengthMSB     = errors.New("extended length 127 has its high bit set")
	ErrNonCanonicalLength127 = errors.New("extended length 127 is less than 65536")
	ErrPayloadTooLarge       = errors.New("frame payload exceeds maxPayload")

	ErrIncompleteFrame   = errors.New("input ended in the middle of a frame")
	ErrIncompleteMessage = errors.New("input ended in the middle of a message")

	ErrUnexpectedContinuation = errors.New("continuation frame without a message")
	ErrMessageInProgress      = errors.New("new data frame while a message is in progress")

	ErrInvalidUTF8       = errors.New("text or close reason is not strict UTF-8")
	ErrShortClosePayload = errors.New("close payload is shorter than its code")
)

// Decoder incrementally decodes masked client WebSocket frames. It performs
// no I/O. Push may receive any number of bytes, including a partial header or
// partial payload. A decoding error is sticky: later calls return the same
// error, while frames returned before the error remain valid.
type Decoder struct {
	maxPayload int

	pending []byte

	inMessage     bool
	messageOpcode Opcode
	messageData   []byte

	err      error
	finished bool
}

// NewDecoder creates a frame decoder. The optional maxPayload is the largest
// frame payload accepted; the first value is used and DefaultMaxPayload is used
// when it is omitted. A negative limit is treated as zero.
func NewDecoder(maxPayload ...int) *Decoder {
	limit := DefaultMaxPayload
	if len(maxPayload) > 0 {
		limit = maxPayload[0]
	}
	if limit < 0 {
		limit = 0
	}
	return &Decoder{maxPayload: limit}
}

// NewFrameDecoder is an alias for NewDecoder.
func NewFrameDecoder(maxPayload ...int) *Decoder {
	return NewDecoder(maxPayload...)
}

// New is an alias for NewDecoder.
func New(maxPayload ...int) *Decoder {
	return NewDecoder(maxPayload...)
}

// FrameDecoder is an alias for Decoder.
type FrameDecoder = Decoder

// Push appends client bytes to the decoder and returns every frame completed
// by this call. If a frame is malformed, the frames completed earlier in the
// chunk are returned along with the error, and the decoder stops permanently.
func (d *Decoder) Push(chunk []byte) ([]Frame, error) {
	if d.err != nil {
		return nil, d.err
	}
	if d.finished {
		return nil, ErrFinished
	}

	d.pending = append(d.pending, chunk...)

	var frames []Frame
	for {
		frame, consumed, complete, err := d.parseFrame(d.pending)
		if err != nil {
			d.fail(err)
			return frames, err
		}
		if !complete {
			break
		}

		frames = append(frames, frame)
		d.pending = d.pending[consumed:]
	}

	if len(d.pending) == 0 {
		d.pending = nil
	}
	return frames, nil
}

// Finish reports whether the byte stream ended between frames and messages.
// It does not discard an incomplete frame or message. Finish is idempotent
// after a successful call, but Push cannot be called afterwards.
func (d *Decoder) Finish() error {
	if d.err != nil {
		return d.err
	}
	if d.finished {
		return nil
	}
	d.finished = true

	if len(d.pending) != 0 {
		d.fail(ErrIncompleteFrame)
		return d.err
	}
	if d.inMessage {
		d.fail(ErrIncompleteMessage)
		return d.err
	}
	return nil
}

func (d *Decoder) fail(err error) {
	d.err = err
	d.pending = nil
	d.inMessage = false
	d.messageOpcode = 0
	d.messageData = nil
}

func (d *Decoder) parseFrame(data []byte) (Frame, int, bool, error) {
	var zero Frame
	if len(data) < 1 {
		return zero, 0, false, nil
	}

	first := data[0]
	fin := first&0x80 != 0
	if first&0x70 != 0 {
		return zero, 0, false, ErrReservedBits
	}
	opcode := Opcode(first & 0x0f)
	if !validOpcode(opcode) {
		return zero, 0, false, ErrBadOpcode
	}

	isControl := opcode >= OpClose
	if isControl && !fin {
		return zero, 0, false, ErrControlFin
	}

	if opcode == OpContinuation && !d.inMessage {
		return zero, 0, false, ErrUnexpectedContinuation
	}
	if (opcode == OpText || opcode == OpBinary) && d.inMessage {
		return zero, 0, false, ErrMessageInProgress
	}

	if len(data) < 2 {
		return zero, 0, false, nil
	}
	second := data[1]
	if second&0x80 == 0 {
		return zero, 0, false, ErrMaskRequired
	}
	lengthMarker := uint64(second & 0x7f)

	if isControl && lengthMarker > 125 {
		return zero, 0, false, ErrControlTooLong
	}

	headerLen := 2
	var payloadLen uint64
	switch lengthMarker {
	case 126:
		if len(data) < headerLen+2 {
			return zero, 0, false, nil
		}
		payloadLen = uint64(binary.BigEndian.Uint16(data[headerLen:]))
		headerLen += 2
		if payloadLen < 126 {
			return zero, 0, false, ErrNonCanonicalLength126
		}
	case 127:
		if len(data) < headerLen+8 {
			return zero, 0, false, nil
		}
		rawLength := binary.BigEndian.Uint64(data[headerLen:])
		headerLen += 8
		if rawLength&(uint64(1)<<63) != 0 {
			return zero, 0, false, ErrExtendedLengthMSB
		}
		payloadLen = rawLength
		if payloadLen < 65536 {
			return zero, 0, false, ErrNonCanonicalLength127
		}
	default:
		payloadLen = lengthMarker
	}

	if payloadLen > uint64(d.maxPayload) {
		return zero, 0, false, ErrPayloadTooLarge
	}

	headerLen += 4
	if len(data) < headerLen {
		return zero, 0, false, nil
	}
	if uint64(len(data)-headerLen) < payloadLen {
		return zero, 0, false, nil
	}
	total := headerLen + int(payloadLen)

	mask := data[headerLen-4 : headerLen]
	payload := make([]byte, int(payloadLen))
	wirePayload := data[headerLen:total]
	for i := range payload {
		payload[i] = wirePayload[i] ^ mask[i&3]
	}

	frame := Frame{Opcode: opcode, Payload: payload, Fin: fin}
	if err := d.acceptFrame(frame); err != nil {
		return zero, 0, false, err
	}
	return frame, total, true, nil
}

func (d *Decoder) acceptFrame(frame Frame) error {
	switch frame.Opcode {
	case OpText, OpBinary:
		if frame.Fin {
			if frame.Opcode == OpText && !utf8.Valid(frame.Payload) {
				return ErrInvalidUTF8
			}
			return nil
		}

		d.inMessage = true
		d.messageOpcode = frame.Opcode
		if frame.Opcode == OpText {
			d.messageData = append(d.messageData[:0], frame.Payload...)
		}
	case OpContinuation:
		if d.messageOpcode == OpText {
			d.messageData = append(d.messageData, frame.Payload...)
		}
		if frame.Fin {
			if d.messageOpcode == OpText && !utf8.Valid(d.messageData) {
				return ErrInvalidUTF8
			}
			d.inMessage = false
			d.messageOpcode = 0
			d.messageData = nil
		}
	case OpClose:
		if len(frame.Payload) == 1 {
			return ErrShortClosePayload
		}
		if len(frame.Payload) > 2 && !utf8.Valid(frame.Payload[2:]) {
			return ErrInvalidUTF8
		}
	}
	return nil
}

func validOpcode(opcode Opcode) bool {
	switch opcode {
	case OpContinuation, OpText, OpBinary, OpClose, OpPing, OpPong:
		return true
	default:
		return false
	}
}

// CloseCode returns the big-endian status code at the start of a close
// payload. It is zero when the payload is empty.
func (f Frame) CloseCode() uint16 {
	if f.Opcode != OpClose || len(f.Payload) < 2 {
		return 0
	}
	return binary.BigEndian.Uint16(f.Payload[:2])
}

// CloseReason returns the UTF-8 reason following a close code. It is nil when
// the close payload is empty or has no bytes after the code.
func (f Frame) CloseReason() []byte {
	if f.Opcode != OpClose || len(f.Payload) <= 2 {
		return nil
	}
	return f.Payload[2:]
}
