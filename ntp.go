package dataeng

import (
	"encoding/binary"
	"errors"
)

// NTP packet layout constants.
const (
	headerSize       = 48
	extensionHead    = 4
	minExtensionLen  = 16
	macKeyIDSize     = 4
	macShortSize     = 20
	macLongSize      = 24
	extensionGate    = 24
	defaultMaxPacket = 1 << 16
)

// Sentinel errors returned by the parser. All failures stop the parser;
// afterwards Push, Feed and Finish keep returning the stored failure error.
var (
	// ErrVersion means the 3-bit version is not 4.
	ErrVersion = errors.New("dataeng: NTP version must be 4")
	// ErrMode means the 3-bit mode is neither 3 (client) nor 4 (server).
	ErrMode = errors.New("dataeng: NTP mode must be 3 or 4")
	// ErrExtensionLen means an extension length is below 16, not a multiple
	// of 4, or runs past the bytes available for the packet.
	ErrExtensionLen = errors.New("dataeng: invalid extension field length")
	// ErrExtensionLarge means an extension declares a length above maxPacket.
	ErrExtensionLarge = errors.New("dataeng: extension length exceeds max packet")
	// ErrPacketLarge means the buffered packet grew beyond maxPacket.
	ErrPacketLarge = errors.New("dataeng: packet exceeds max packet size")
	// ErrTrailingBytes means a complete packet ends with a tail that is not
	// 0, 20 or 24 bytes long.
	ErrTrailingBytes = errors.New("dataeng: invalid trailing byte count")
	// ErrIncomplete means Finish was reached while a packet was still split.
	ErrIncomplete = errors.New("dataeng: incomplete packet at end of stream")
)

// Timestamp is an NTP 64-bit timestamp: 32-bit seconds and 32-bit fraction,
// both big-endian on the wire.
type Timestamp struct {
	Seconds  uint32
	Fraction uint32
}

// Extension is one NTPv4 extension field (RFC 5905). Value holds the bytes
// after the 4-byte type/length header and is owned by the Packet.
type Extension struct {
	Type   uint16
	Length uint16
	Value  []byte
}

// Packet is one fully framed and parsed NTPv4 packet.
type Packet struct {
	Leap           uint8
	Version        uint8
	Mode           uint8
	Stratum        uint8
	Poll           int8
	Precision      int8
	RootDelay      uint32
	RootDispersion uint32
	ReferenceID    [4]byte
	ReferenceTime  Timestamp
	OriginTime     Timestamp
	ReceiveTime    Timestamp
	TransmitTime   Timestamp
	Extensions     []Extension
	KeyID          uint32
	Digest         []byte
	HasMAC         bool
}

// Config configures a Parser. MaxPacket caps both the buffered packet size
// and any declared extension length; a non-positive value selects 65536.
// OnPacket, when set, is called for every delivered packet in stream order.
type Config struct {
	MaxPacket int
	OnPacket  func(*Packet)
}

// Parser incrementally frames NTPv4 packets from byte chunks handed to Push.
// It never sends network requests. A failure stops the parser permanently;
// packets already delivered before the failure remain available.
type Parser struct {
	maxPacket int
	onPacket  func(*Packet)
	buf       []byte
	packets   []*Packet
	stopped   bool
	err       error
}

// NewParser creates a Parser from cfg.
func NewParser(cfg Config) *Parser {
	maxPacket := cfg.MaxPacket
	if maxPacket <= 0 {
		maxPacket = defaultMaxPacket
	}
	return &Parser{
		maxPacket: maxPacket,
		onPacket:  cfg.OnPacket,
	}
}

// Push appends chunk to the internal buffer and frames as many complete
// packets as possible. It may be called with a chunk that ends in the middle
// of an extension. It returns the first fatal error, after which the parser
// is stopped. The chunk is copied and may be reused by the caller.
func (p *Parser) Push(chunk []byte) error {
	if p.stopped {
		return p.err
	}
	if len(chunk) > 0 {
		if len(p.buf)+len(chunk) > p.maxPacket {
			return p.fail(ErrPacketLarge)
		}
		p.buf = append(p.buf, chunk...)
	}
	return p.runFraming(true, false)
}

// Feed appends a fragment that is known not to end on a datagram boundary.
// Use it to continue a packet whose earlier bytes were delivered by another
// Feed/Push; unlike Push it never finalizes a header-only packet on its own.
func (p *Parser) Feed(chunk []byte) error {
	if p.stopped {
		return p.err
	}
	if len(chunk) > 0 {
		if len(p.buf)+len(chunk) > p.maxPacket {
			return p.fail(ErrPacketLarge)
		}
		p.buf = append(p.buf, chunk...)
	}
	return p.runFraming(false, false)
}

// Finish marks the end of the stream. It fails with ErrIncomplete if a packet
// is only partially buffered, and reports any earlier failure.
func (p *Parser) Finish() error {
	if p.stopped {
		return p.err
	}
	if err := p.processFinal(); err != nil {
		return p.fail(err)
	}
	if len(p.buf) != 0 {
		return p.fail(ErrIncomplete)
	}
	return nil
}

// Packets returns all packets delivered so far in stream order. The returned
// slice is shared with the parser and must not be modified concurrently.
func (p *Parser) Packets() []*Packet {
	return p.packets
}

// Err returns the error that stopped the parser, or nil while it is running.
func (p *Parser) Err() error {
	return p.err
}

func (p *Parser) fail(err error) error {
	p.stopped = true
	p.err = err
	return err
}

func (p *Parser) deliver(pkt *Packet) {
	p.packets = append(p.packets, pkt)
	if p.onPacket != nil {
		p.onPacket(pkt)
	}
}

// runFraming repeatedly frames the packet at the front of the buffer.
// boundary marks the current buffer end as a datagram boundary (a Push or
// Finish), final additionally guarantees no more bytes will ever arrive.
func (p *Parser) runFraming(boundary, final bool) error {
	for len(p.buf) >= headerSize {
		consumed, err := framePacket(p.buf, p.maxPacket, boundary || final, final)
		if err != nil {
			return p.fail(err)
		}
		if consumed == 0 {
			// Front packet is valid so far but needs more bytes.
			return nil
		}
		pkt, err := parsePacket(p.buf[:consumed], p.maxPacket)
		if err != nil {
			return p.fail(err)
		}
		p.deliver(pkt)
		p.buf = p.buf[consumed:]
		// After consuming the leading datagram, any leftover bytes are a new,
		// not-yet-bound datagram: stop treating the buffer end as a boundary.
		boundary = false
	}
	return nil
}

// processFinal drives framing with the knowledge that no more bytes will
// arrive, so a buffered packet whose tail is empty can be finalized.
func (p *Parser) processFinal() error {
	if err := p.runFraming(true, true); err != nil {
		return err
	}
	if len(p.buf) != 0 {
		return ErrIncomplete
	}
	return nil
}

// framePacket decides how many bytes the packet at the front of buf occupies.
// It returns consumed == 0 with a nil error when the packet is still
// incomplete, and a non-nil error on any framing/validation failure. It only
// A zero-length tail cannot be told apart from a packet still awaiting bytes
// while the stream continues. boundary or final resolves it as a header-only
// packet; otherwise framing waits for more bytes.
func framePacket(buf []byte, maxPacket int, boundary, final bool) (consumed int, err error) {
	first := buf[0]
	if version := (first >> 3) & 0x07; version != 4 {
		return 0, ErrVersion
	}
	if mode := first & 0x07; mode != 3 && mode != 4 {
		return 0, ErrMode
	}

	pos := headerSize
	for {
		remaining := len(buf) - pos
		// After all extensions are consumed, the tail must be empty or a
		// 20/24-byte MAC. Such a tail can only be accepted at a datagram
		// boundary or at stream end; otherwise more bytes may still arrive.
		if remaining == 0 || remaining == macShortSize || remaining == macLongSize {
			if boundary || final {
				return len(buf), nil
			}
			return 0, nil
		}
		// Only read an extension while more than 24 bytes remain; anything
		// smaller that is not a valid MAC can never frame successfully.
		if remaining <= extensionGate {
			if final {
				// A non-multiple-of-4 length means the stream was cut in the
				// middle of a field; a multiple-of-4 tail is simply illegal.
				if remaining%4 != 0 {
					return 0, ErrIncomplete
				}
				return 0, ErrTrailingBytes
			}
			return 0, nil
		}

		extLen := int(binary.BigEndian.Uint16(buf[pos+2:]))
		// Reject as soon as the length field is readable, before the full
		// extension arrives and without honoring the declared size.
		if extLen > maxPacket {
			return 0, ErrExtensionLarge
		}
		if extLen < minExtensionLen || extLen%4 != 0 {
			return 0, ErrExtensionLen
		}
		if extLen > remaining {
			if final {
				return 0, ErrIncomplete
			}
			return 0, nil
		}
		pos += extLen
	}
}

// parsePacket parses a fully framed packet in buf. All variable-length fields
// are copied so the result stays valid after the parser buffer is reused.
func parsePacket(buf []byte, maxPacket int) (*Packet, error) {
	if len(buf) < headerSize {
		return nil, ErrIncomplete
	}
	first := buf[0]
	version := (first >> 3) & 0x07
	mode := first & 0x07
	if version != 4 {
		return nil, ErrVersion
	}
	if mode != 3 && mode != 4 {
		return nil, ErrMode
	}

	pkt := &Packet{
		Leap:           first >> 6,
		Version:        version,
		Mode:           mode,
		Stratum:        buf[1],
		Poll:           int8(buf[2]),
		Precision:      int8(buf[3]),
		RootDelay:      binary.BigEndian.Uint32(buf[4:8]),
		RootDispersion: binary.BigEndian.Uint32(buf[8:12]),
	}
	copy(pkt.ReferenceID[:], buf[12:16])
	pkt.ReferenceTime = readTimestamp(buf[16:24])
	pkt.OriginTime = readTimestamp(buf[24:32])
	pkt.ReceiveTime = readTimestamp(buf[32:40])
	pkt.TransmitTime = readTimestamp(buf[40:48])

	pos := headerSize
	for len(buf)-pos > extensionGate {
		extType := binary.BigEndian.Uint16(buf[pos:])
		extLen := int(binary.BigEndian.Uint16(buf[pos+2:]))
		remaining := len(buf) - pos
		if extLen > maxPacket {
			return nil, ErrExtensionLarge
		}
		if extLen < minExtensionLen || extLen%4 != 0 || extLen > remaining {
			return nil, ErrExtensionLen
		}
		value := make([]byte, extLen-extensionHead)
		copy(value, buf[pos+extensionHead:pos+extLen])
		pkt.Extensions = append(pkt.Extensions, Extension{
			Type:   extType,
			Length: uint16(extLen),
			Value:  value,
		})
		pos += extLen
	}

	switch remaining := len(buf) - pos; remaining {
	case 0:
		// No message authentication code.
	case macShortSize, macLongSize:
		pkt.HasMAC = true
		pkt.KeyID = binary.BigEndian.Uint32(buf[pos:])
		pkt.Digest = make([]byte, remaining-macKeyIDSize)
		copy(pkt.Digest, buf[pos+macKeyIDSize:])
	default:
		return nil, ErrTrailingBytes
	}
	return pkt, nil
}

func readTimestamp(b []byte) Timestamp {
	return Timestamp{
		Seconds:  binary.BigEndian.Uint32(b[0:4]),
		Fraction: binary.BigEndian.Uint32(b[4:8]),
	}
}
