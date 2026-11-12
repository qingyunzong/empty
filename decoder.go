package dataeng

import (
	"encoding/binary"
	"errors"
)

// Wire-level sizes of a binary-protocol response.
const (
	headerSize = 24

	magicResponse = 0x81

	opcodeGet     = 0x00
	opcodeSet     = 0x01
	opcodeDelete  = 0x04
	opcodeGetKQ   = 0x0C
	bodyLenSize   = 4
	bodyLenOffset = 8
)

// Errors reported by the response decoder. They may be wrapped, so use
// errors.Is rather than comparing values directly.
var (
	ErrStopped         = errors.New("dataeng: decoder stopped after an earlier failure")
	ErrBadMagic        = errors.New("dataeng: invalid response magic")
	ErrBadOpcode       = errors.New("dataeng: unsupported response opcode")
	ErrBadDataType     = errors.New("dataeng: response data type must be zero")
	ErrBadExtrasLength = errors.New("dataeng: invalid extras length")
	ErrBadKeyLength    = errors.New("dataeng: invalid key length")
	ErrBodyTooLarge    = errors.New("dataeng: response body exceeds maxBody")
	ErrTruncated       = errors.New("dataeng: incomplete response at end of input")
)

// Response is one decoded binary-protocol response. Extras, Key and Value
// slice the decoder's delivered payload: Extras is the leading extras region,
// Key the middle region and Value the trailing region. Any region may be empty.
type Response struct {
	Opcode     byte
	KeyLength  uint16
	ExtrasLen  byte
	Status     uint16
	BodyLength uint32
	Opaque     uint32
	CAS        uint64
	Extras     []byte
	Key        []byte
	Value      []byte
}

// Decoder incrementally parses binary-protocol responses delivered through
// Push. Push is allowed to stop in the middle of a response; Finish reports
// any response that was not fully received. The first failure stops the
// decoder permanently, while responses already delivered remain valid.
type Decoder struct {
	maxBody uint32
	buf     []byte
	header  Response
	haveHdr bool
	stopped error
}

// NewDecoder creates a Decoder that rejects any response whose declared body
// length exceeds maxBody. The limit is enforced as soon as the four-byte body
// length field is readable, before the body itself is buffered or allocated.
func NewDecoder(maxBody uint32) *Decoder {
	return &Decoder{maxBody: maxBody}
}

// Push feeds inbound bytes and returns every response that became complete in
// this call. Input may end at any byte boundary, including inside a header or
// a body. After a failure the decoder is stopped: subsequent calls return the
// recorded failure without consuming input.
func (d *Decoder) Push(p []byte) ([]Response, error) {
	if d.stopped != nil {
		return nil, d.stopped
	}
	d.buf = append(d.buf, p...)

	var delivered []Response
	for {
		if !d.haveHdr {
			if len(d.buf) < bodyLenOffset+bodyLenSize {
				return delivered, nil
			}
			bodyLen := binary.BigEndian.Uint32(d.buf[bodyLenOffset : bodyLenOffset+bodyLenSize])
			if bodyLen > d.maxBody {
				return delivered, d.fail(ErrBodyTooLarge)
			}
			if len(d.buf) < headerSize {
				return delivered, nil
			}
			resp, err := parseHeader(d.buf[:headerSize], bodyLen)
			if err != nil {
				return delivered, d.fail(err)
			}
			d.header = resp
			d.haveHdr = true
		}

		if uint32(len(d.buf)-headerSize) < d.header.BodyLength {
			return delivered, nil
		}

		body := d.buf[headerSize : headerSize+int(d.header.BodyLength)]
		extrasEnd := int(d.header.ExtrasLen)
		keyEnd := extrasEnd + int(d.header.KeyLength)
		d.header.Extras = body[:extrasEnd:extrasEnd]
		d.header.Key = body[extrasEnd:keyEnd:keyEnd]
		d.header.Value = body[keyEnd:]
		delivered = append(delivered, d.header)

		d.buf = d.buf[headerSize+int(d.header.BodyLength):]
		d.haveHdr = false
		d.header = Response{}
	}
}

// Finish signals that no more input will arrive. It returns ErrTruncated when
// a response has been started but not fully received. A stopped decoder keeps
// returning its original failure.
func (d *Decoder) Finish() error {
	if d.stopped != nil {
		return d.stopped
	}
	if d.haveHdr || len(d.buf) > 0 {
		return d.fail(ErrTruncated)
	}
	return nil
}

// Stopped returns nil while the decoder is active. After a failure it returns
// the original failure, which every subsequent Push and Finish also returns;
// errors.Is(err, ErrStopped) identifies the stopped state itself.
func (d *Decoder) Stopped() error {
	return d.stopped
}

func (d *Decoder) fail(err error) error {
	d.stopped = stoppedError{err}
	d.buf = nil
	d.haveHdr = false
	d.header = Response{}
	return err
}

// stoppedError wraps the original failure so callers can detect the stopped
// state with errors.Is(err, ErrStopped) while the underlying cause is still
// reachable with errors.Is or errors.As.
type stoppedError struct {
	err error
}

func (e stoppedError) Error() string { return e.err.Error() }

func (e stoppedError) Unwrap() error { return e.err }

func (e stoppedError) Is(target error) bool {
	return target == ErrStopped || target == e.err
}

func parseHeader(hdr []byte, bodyLen uint32) (Response, error) {
	if hdr[0] != magicResponse {
		return Response{}, ErrBadMagic
	}

	opcode := hdr[1]
	switch opcode {
	case opcodeGet, opcodeSet, opcodeDelete, opcodeGetKQ:
	default:
		return Response{}, ErrBadOpcode
	}

	keyLength := binary.BigEndian.Uint16(hdr[2:4])
	extrasLen := hdr[4]
	dataType := hdr[5]
	status := binary.BigEndian.Uint16(hdr[6:8])
	opaque := binary.BigEndian.Uint32(hdr[12:16])
	cas := binary.BigEndian.Uint64(hdr[16:24])

	if dataType != 0 {
		return Response{}, ErrBadDataType
	}

	switch opcode {
	case opcodeGet, opcodeGetKQ:
		if status == 0 {
			if extrasLen != 4 {
				return Response{}, ErrBadExtrasLength
			}
		} else {
			if extrasLen != 0 {
				return Response{}, ErrBadExtrasLength
			}
			if opcode == opcodeGetKQ && keyLength != 0 {
				return Response{}, ErrBadKeyLength
			}
		}
		if opcode == opcodeGet && keyLength != 0 {
			return Response{}, ErrBadKeyLength
		}
	case opcodeSet, opcodeDelete:
		if extrasLen != 0 {
			return Response{}, ErrBadExtrasLength
		}
	}

	if uint32(extrasLen) > bodyLen {
		return Response{}, ErrBadExtrasLength
	}
	if uint32(keyLength) > bodyLen {
		return Response{}, ErrBadKeyLength
	}
	if uint32(extrasLen)+uint32(keyLength) > bodyLen {
		return Response{}, ErrBadExtrasLength
	}

	return Response{
		Opcode:     opcode,
		KeyLength:  keyLength,
		ExtrasLen:  extrasLen,
		Status:     status,
		BodyLength: bodyLen,
		Opaque:     opaque,
		CAS:        cas,
	}, nil
}
