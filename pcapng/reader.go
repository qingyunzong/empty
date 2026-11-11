// Package pcapng is a minimal, dependency-free reader for the PCAP Next
// Generation Capture File Format (pcapng).
//
// It understands the three block types needed to decode captured packets:
//
//   - Section Header Block (SHB), which also defines the section byte order
//   - Interface Description Block (IDB), which describes a capture interface
//   - Enhanced Packet Block (EPB), which carries a captured packet
//
// Every other block type is treated as an unknown block and skipped using the
// block total length declared in its header.
//
// A reader is strict rather than tolerant: any malformed block makes Next
// return an error and stops the stream, so a bad block can never publish a
// half-parsed packet nor mutate the interface table.
package pcapng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
)

// Block type codes defined by the pcapng specification.
const (
	BlockSHB uint32 = 0x0A0D0D0A
	BlockIDB uint32 = 0x00000001
	BlockEPB uint32 = 0x00000006
)

const (
	optEOO     uint16 = 0 // End of Options
	optTSResol uint16 = 9 // if_tsresol

	// minBlockLen is the smallest possible block: 12-byte header plus
	// 4-byte trailing total length.
	minBlockLen = 12

	// minSHBLen is the smallest Section Header Block: 12-byte header, 4-byte
	// magic, 2+2 version fields, 8-byte section length and 4-byte trailer.
	minSHBLen = 32
)

// byteOrderMagic is the byte-order magic stored inside an SHB body. Its byte
// layout reveals which endianness the section uses.
var (
	// The byte-order magic is the 32-bit value 0x1A2B3C4D written with the
	// section's own byte order.
	byteOrderMagic   = [4]byte{0x4D, 0x3C, 0x2B, 0x1A} // little-endian section
	byteOrderMagicBE = [4]byte{0x1A, 0x2B, 0x3C, 0x4D} // big-endian section
)

// Reader decodes a pcapng byte stream. Each section keeps its own byte order
// and its own interface table; opening a new section discards the old table.
type Reader struct {
	r   io.Reader
	bo  binary.ByteOrder
	sec bool
	ifs []*Interface

	err error
}

// NewReader returns a Reader that consumes pcapng data from r.
func NewReader(r io.Reader) *Reader {
	return &Reader{r: r}
}

// Next returns the next captured packet. It returns io.EOF when the stream is
// exhausted after a well-formed block boundary. Any malformed block returns a
// descriptive error and all subsequent calls return the same error.
func (rd *Reader) Next() (*Packet, error) {
	if rd.err != nil {
		return nil, rd.err
	}
	pkt, err := rd.readBlock()
	if err != nil {
		rd.err = err
		return nil, err
	}
	return pkt, nil
}

// Interfaces returns a snapshot of the interface table for the current section.
// It is empty before the first Section Header Block.
func (rd *Reader) Interfaces() []*Interface {
	out := make([]*Interface, len(rd.ifs))
	copy(out, rd.ifs)
	return out
}

// ByteOrder reports the byte order of the current section, or nil before the
// first Section Header Block has been parsed.
func (rd *Reader) ByteOrder() binary.ByteOrder {
	return rd.bo
}

func (rd *Reader) readBlock() (*Packet, error) {
	var hdr [12]byte
	if _, err := io.ReadFull(rd.r, hdr[:]); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.EOF
		}
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, fmt.Errorf("pcapng: truncated block header: %w", err)
		}
		return nil, err
	}

	var (
		bo    binary.ByteOrder
		total int
		body  []byte
	)

	// BlockSHB's type code 0x0A0D0D0A is an endian-independent palindrome, so
	// it can be recognized before the section byte order is known.
	btype := binary.LittleEndian.Uint32(hdr[0:4])

	if btype == BlockSHB {
		// The first four body bytes are the byte-order magic; read them on
		// their own so the rest of the block can be decoded correctly.
		var magic [4]byte
		if _, err := io.ReadFull(rd.r, magic[:]); err != nil {
			return nil, fmt.Errorf("pcapng: section header block is truncated: %w", err)
		}
		switch {
		case bytes.Equal(magic[:], byteOrderMagic[:]):
			bo = binary.LittleEndian
		case bytes.Equal(magic[:], byteOrderMagicBE[:]):
			bo = binary.BigEndian
		default:
			return nil, errors.New("pcapng: section header block has invalid byte-order magic")
		}
		total = int(bo.Uint32(hdr[8:12]))
		if total < minSHBLen || total%4 != 0 {
			return nil, fmt.Errorf("pcapng: section header block total length %d is invalid (minimum %d, 4-byte aligned)", total, minSHBLen)
		}
		// Four magic bytes are already consumed; read the rest of the body.
		rest := make([]byte, total-16)
		if _, err := io.ReadFull(rd.r, rest); err != nil {
			return nil, fmt.Errorf("pcapng: section header block is truncated: %w", err)
		}
		body = make([]byte, total-12)
		copy(body, magic[:])
		copy(body[4:], rest)
	} else {
		if !rd.sec || rd.bo == nil {
			return nil, fmt.Errorf("pcapng: block type %#x appears before a section header block", btype)
		}
		bo = rd.bo
		// Non-SHB type codes are encoded with the section byte order; re-decode
		// the header fields rather than trusting the little-endian view.
		btype = bo.Uint32(hdr[0:4])
		total = int(bo.Uint32(hdr[8:12]))
		if err := checkLength(btype, total); err != nil {
			return nil, err
		}
		body = make([]byte, total-12)
		if _, err := io.ReadFull(rd.r, body); err != nil {
			return nil, fmt.Errorf("pcapng: block type %#x is truncated: %w", btype, err)
		}
	}

	trailer := bo.Uint32(body[len(body)-4:])
	if int(trailer) != total {
		return nil, fmt.Errorf("pcapng: block type %#x header length %d != trailer length %d", btype, total, trailer)
	}

	switch btype {
	case BlockSHB:
		if err := rd.parseSHB(body, bo); err != nil {
			return nil, err
		}
		// A new section starts clean: its byte order and interface numbering
		// are independent from anything seen before.
		rd.bo = bo
		rd.sec = true
		rd.ifs = nil
		return nil, nil
	case BlockIDB:
		itf, err := parseIDB(body, bo)
		if err != nil {
			return nil, err
		}
		// The interface is published only after the whole block validated.
		rd.ifs = append(rd.ifs, itf)
		return nil, nil
	case BlockEPB:
		return parseEPB(body, bo, rd.ifs)
	default:
		// Unknown blocks carry no meaning here: the declared total length has
		// already been consumed and checked, so simply skip the block.
		return nil, nil
	}
}

// checkLength enforces the minimum block size and 4-byte alignment of the
// declared block total length.
func checkLength(btype uint32, total int) error {
	if total < minBlockLen {
		return fmt.Errorf("pcapng: block type %#x total length %d is smaller than %d", btype, total, minBlockLen)
	}
	if total%4 != 0 {
		return fmt.Errorf("pcapng: block type %#x total length %d is not 4-byte aligned", btype, total)
	}
	return nil
}

// parseSHB validates the fixed fields and option area of a Section Header
// Block. The body excludes the 12-byte block header but still contains the
// 4-byte trailing total length.
func (rd *Reader) parseSHB(body []byte, bo binary.ByteOrder) error {
	// magic(4) + major(2) + minor(2) + section length(8) + trailer(4)
	const fixed = 20
	if len(body) < fixed {
		return fmt.Errorf("pcapng: section header block body too short: %d bytes", len(body))
	}
	return parseOptions(body[fixed:len(body)-4], bo, "section header block")
}

// Interface describes one Interface Description Block in the current section.
type Interface struct {
	LinkType   uint16
	SnapLength uint32
	Resolution Resolution
}

// parseIDB validates an Interface Description Block and returns it without
// touching the reader's interface table.
func parseIDB(body []byte, bo binary.ByteOrder) (*Interface, error) {
	// link type(2) + reserved(2) + snap length(4) + trailer(4)
	const fixed = 12
	if len(body) < fixed {
		return nil, fmt.Errorf("pcapng: interface description block body too short: %d bytes", len(body))
	}
	if bo.Uint16(body[2:4]) != 0 {
		return nil, errors.New("pcapng: interface description block reserved field is not zero")
	}

	itf := &Interface{
		LinkType:   bo.Uint16(body[0:2]),
		SnapLength: bo.Uint32(body[4:8]),
		Resolution: defaultResolution(),
	}

	err := parseOptions(body[8:len(body)-4], bo, "interface description block", func(code uint16, value []byte) error {
		switch code {
		case optTSResol:
			if len(value) != 1 {
				return fmt.Errorf("pcapng: if_tsresol option must be one byte, got %d", len(value))
			}
			res, err := parseResolution(value[0])
			if err != nil {
				return err
			}
			itf.Resolution = res
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return itf, nil
}

// Packet is one decoded Enhanced Packet Block.
type Packet struct {
	Interface int
	LinkType  uint16
	// Timestamp is the capture timestamp expressed as exact rational seconds
	// since the interface timestamp origin (normally 1970-01-01 UTC).
	Timestamp *big.Rat
	// OriginalLength is the packet length as seen on the wire.
	OriginalLength uint32
	// Data is the captured packet bytes, never larger than OriginalLength.
	Data []byte
}

// Seconds reports the timestamp as floating-point seconds. Use Timestamp when
// exactness matters.
func (p *Packet) Seconds() float64 {
	if p.Timestamp == nil {
		return 0
	}
	f, _ := p.Timestamp.Float64()
	return f
}

// parseEPB validates an Enhanced Packet Block and returns its packet.
func parseEPB(body []byte, bo binary.ByteOrder, ifs []*Interface) (*Packet, error) {
	// interface id(4) + ts high(4) + ts low(4) + cap len(4) + orig len(4) +
	// trailer(4)
	const fixed = 24
	if len(body) < fixed {
		return nil, fmt.Errorf("pcapng: enhanced packet block body too short: %d bytes", len(body))
	}

	id := int(bo.Uint32(body[0:4]))
	if id < 0 || id >= len(ifs) {
		return nil, fmt.Errorf("pcapng: enhanced packet block references interface %d but section has %d interface(s)", id, len(ifs))
	}
	itf := ifs[id]

	tsHigh := bo.Uint32(body[4:8])
	tsLow := bo.Uint32(body[8:12])
	capLen := int64(bo.Uint32(body[12:16]))
	origLen := int64(bo.Uint32(body[16:20]))
	if capLen > origLen {
		return nil, fmt.Errorf("pcapng: captured length %d exceeds original length %d", capLen, origLen)
	}

	padded := int((capLen + 3) &^ 3)
	dataEnd := 20 + padded
	if dataEnd+4 > len(body) {
		return nil, fmt.Errorf("pcapng: packet data (%d padded bytes) exceeds block boundary", padded)
	}
	// Padding bytes between captured data and the next 4-byte boundary must be
	// zero.
	for _, b := range body[20+int(capLen) : dataEnd] {
		if b != 0 {
			return nil, errors.New("pcapng: packet data padding is not zero")
		}
	}

	if err := parseOptions(body[dataEnd:len(body)-4], bo, "enhanced packet block"); err != nil {
		return nil, err
	}

	raw := uint64(tsHigh)<<32 | uint64(tsLow)
	data := make([]byte, capLen)
	copy(data, body[20:20+int(capLen)])

	return &Packet{
		Interface:      id,
		LinkType:       itf.LinkType,
		Timestamp:      itf.Resolution.toRat(raw),
		OriginalLength: uint32(origLen),
		Data:           data,
	}, nil
}

// parseOptions walks a block option area. Every option is consumed according
// to its own length and its padding is checked. The optional visit callback
// receives each non-EOO option's value and may reject it.
func parseOptions(area []byte, bo binary.ByteOrder, ctx string, visit ...func(code uint16, value []byte) error) error {
	i := 0
	for i < len(area) {
		if len(area)-i < 4 {
			return fmt.Errorf("pcapng: %s option area is truncated", ctx)
		}
		code := bo.Uint16(area[i : i+2])
		length := int(bo.Uint16(area[i+2 : i+4]))
		valueStart := i + 4
		valueEnd := valueStart + length
		if valueEnd > len(area) {
			return fmt.Errorf("pcapng: %s option code %#x length %d exceeds option area", ctx, code, length)
		}

		if code == optEOO {
			if length != 0 {
				return fmt.Errorf("pcapng: %s end-of-options option must have zero length", ctx)
			}
			// Everything remaining up to the block trailer is alignment
			// padding and therefore must be zero.
			for _, b := range area[valueEnd:] {
				if b != 0 {
					return fmt.Errorf("pcapng: %s trailing option padding is not zero", ctx)
				}
			}
			return nil
		}

		if len(visit) == 1 && visit[0] != nil {
			if err := visit[0](code, area[valueStart:valueEnd]); err != nil {
				return err
			}
		}

		padded := (length + 3) &^ 3
		for _, b := range area[valueEnd : valueStart+padded] {
			if b != 0 {
				return fmt.Errorf("pcapng: %s option code %#x padding is not zero", ctx, code)
			}
		}
		i = valueStart + padded
	}
	// An empty option area is legal; a non-empty area must end with EOO.
	return nil
}
