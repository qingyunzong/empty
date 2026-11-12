package dataeng

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// FrameEnd terminates every frame on the wire.
const FrameEnd = 0xCE

// Frame types carried on the wire.
const (
	FrameMethod    = 1
	FrameHeader    = 2
	FrameBody      = 3
	FrameHeartbeat = 8
)

const (
	headerSize   = 7 // type(1) + channel(2) + length(4)
	minMethodLen = 4 // class-id + method-id
	minHeaderLen = 2 + 2 + 8 + 2
)

// MethodFrame is a type-1 frame. Args holds the payload after the
// class and method ids, uninterpreted.
type MethodFrame struct {
	Channel  uint16
	ClassID  uint16
	MethodID uint16
	Args     []byte
}

// ContentHeader is a type-2 frame. Props holds the property flags and
// any remaining property payload, uninterpreted.
type ContentHeader struct {
	Channel  uint16
	ClassID  uint16
	BodySize uint64
	Props    []byte
}

// BodyFrame is a type-3 frame carrying a chunk of a channel's body.
type BodyFrame struct {
	Channel uint16
	Payload []byte
}

// Handler receives decoded frames in wire order. Frames delivered
// before an error remain delivered; the component does not roll back.
type Handler interface {
	OnMethod(MethodFrame)
	OnContentHeader(ContentHeader)
	OnBody(BodyFrame)
	OnHeartbeat()
}

// Parser incrementally decodes interleaved frames pushed by the
// message collector. It never opens connections and never allocates
// based on a frame's declared length.
type Parser struct {
	maxFrame uint32
	handler  Handler

	buf []byte
	// remaining tracks unfinished body bytes per channel; an entry
	// greater than zero means the channel has an open content body.
	remaining map[uint16]uint64
	err       error
}

// NewParser returns a Parser that rejects frames whose declared
// payload length exceeds maxFrame.
func NewParser(maxFrame uint32, handler Handler) *Parser {
	return &Parser{
		maxFrame:  maxFrame,
		handler:   handler,
		remaining: make(map[uint16]uint64),
	}
}

// Push feeds bytes into the parser. It may stop in the middle of a
// frame; decoding resumes when more bytes arrive. Once Push fails the
// parser is stopped and every later call returns the same error.
func (p *Parser) Push(data []byte) error {
	if p.err != nil {
		return p.err
	}
	p.buf = append(p.buf, data...)
	for {
		if len(p.buf) < headerSize {
			return p.compact()
		}
		declared := binary.BigEndian.Uint32(p.buf[3:headerSize])
		if declared > p.maxFrame {
			return p.fail(fmt.Errorf("frame length %d exceeds maxFrame %d", declared, p.maxFrame))
		}
		total := headerSize + int(declared) + 1
		if len(p.buf) < total {
			return p.compact()
		}
		frame := p.buf[:total]
		if frame[total-1] != FrameEnd {
			return p.fail(errors.New("missing frame-end byte 0xCE"))
		}
		typ := frame[0]
		channel := binary.BigEndian.Uint16(frame[1:3])
		payload := frame[headerSize : headerSize+int(declared)]
		if err := p.dispatch(typ, channel, payload); err != nil {
			return p.fail(err)
		}
		p.buf = p.buf[total:]
	}
}

// Finish reports success only if no partial frame is buffered and no
// channel has an unfinished content body.
func (p *Parser) Finish() error {
	if p.err != nil {
		return p.err
	}
	if len(p.buf) != 0 {
		return p.fail(fmt.Errorf("finish with %d bytes of an incomplete frame buffered", len(p.buf)))
	}
	for channel, left := range p.remaining {
		if left > 0 {
			return p.fail(fmt.Errorf("finish with %d body bytes outstanding on channel %d", left, channel))
		}
	}
	return nil
}

// Err reports whether the parser has stopped and why.
func (p *Parser) Err() error { return p.err }

func (p *Parser) fail(err error) error {
	p.err = err
	return err
}

func (p *Parser) compact() error {
	if len(p.buf) == 0 {
		p.buf = nil
		return nil
	}
	buf := make([]byte, len(p.buf))
	copy(buf, p.buf)
	p.buf = buf
	return nil
}

func (p *Parser) dispatch(typ byte, channel uint16, payload []byte) error {
	if typ == FrameHeartbeat {
		if channel != 0 || len(payload) != 0 {
			return errors.New("heartbeat requires channel 0 and zero length")
		}
		p.handler.OnHeartbeat()
		return nil
	}
	if channel == 0 {
		return fmt.Errorf("frame type %d not allowed on channel 0", typ)
	}
	switch typ {
	case FrameMethod:
		if len(payload) < minMethodLen {
			return fmt.Errorf("method payload %d bytes, need at least %d", len(payload), minMethodLen)
		}
		p.handler.OnMethod(MethodFrame{
			Channel:  channel,
			ClassID:  binary.BigEndian.Uint16(payload[0:2]),
			MethodID: binary.BigEndian.Uint16(payload[2:4]),
			Args:     append([]byte(nil), payload[minMethodLen:]...),
		})
		return nil
	case FrameHeader:
		return p.contentHeader(channel, payload)
	case FrameBody:
		return p.body(channel, payload)
	default:
		return fmt.Errorf("unknown frame type %d", typ)
	}
}

func (p *Parser) contentHeader(channel uint16, payload []byte) error {
	if len(payload) < minHeaderLen {
		return fmt.Errorf("content header payload %d bytes, need at least %d", len(payload), minHeaderLen)
	}
	if p.remaining[channel] > 0 {
		return fmt.Errorf("channel %d: new content header with %d body bytes outstanding", channel, p.remaining[channel])
	}
	weight := binary.BigEndian.Uint16(payload[2:4])
	if weight != 0 {
		return fmt.Errorf("channel %d: content header weight %d, must be 0", channel, weight)
	}
	header := ContentHeader{
		Channel:  channel,
		ClassID:  binary.BigEndian.Uint16(payload[0:2]),
		BodySize: binary.BigEndian.Uint64(payload[4:12]),
		Props:    append([]byte(nil), payload[12:]...),
	}
	p.remaining[channel] = header.BodySize
	p.handler.OnContentHeader(header)
	return nil
}

func (p *Parser) body(channel uint16, payload []byte) error {
	left := p.remaining[channel]
	if left == 0 {
		return fmt.Errorf("channel %d: body frame without an open content body", channel)
	}
	if uint64(len(payload)) > left {
		return fmt.Errorf("channel %d: body payload %d bytes exceeds %d remaining", channel, len(payload), left)
	}
	p.remaining[channel] = left - uint64(len(payload))
	p.handler.OnBody(BodyFrame{Channel: channel, Payload: append([]byte(nil), payload...)})
	return nil
}
