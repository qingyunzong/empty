package dataeng

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	// CommonHeaderLen is the length of the packet common header.
	CommonHeaderLen = 12
	// chunkHeaderLen is type + flags + length.
	chunkHeaderLen = 4
	// dataChunkMinLen is chunk header plus the fixed DATA value fields.
	dataChunkMinLen = 16

	chunkTypeData = 0x00

	flagUnordered = 0x04
	flagBeginning = 0x02
	flagEnding    = 0x01
	flagReserved  = 0xF8
)

var (
	// ErrFailed is returned by every call after the collector has failed.
	ErrFailed = errors.New("dataeng: collector has failed")
	// ErrChecksum reports a packet whose CRC-32C does not match.
	ErrChecksum = errors.New("dataeng: checksum mismatch")
	// ErrChunkLen reports a chunk length smaller than the chunk header.
	ErrChunkLen = errors.New("dataeng: chunk length smaller than header")
	// ErrChunkTooLarge reports a chunk length above the host maximum.
	ErrChunkTooLarge = errors.New("dataeng: chunk length exceeds maxChunk")
	// ErrPadding reports non-zero chunk padding bytes.
	ErrPadding = errors.New("dataeng: non-zero chunk padding")
	// ErrChunkType reports an unknown chunk type with the high bit clear.
	ErrChunkType = errors.New("dataeng: unknown chunk type")
	// ErrFlags reports reserved DATA flag bits being set.
	ErrFlags = errors.New("dataeng: reserved flag bits set")
	// ErrDataLen reports a DATA chunk shorter than its fixed fields.
	ErrDataLen = errors.New("dataeng: data chunk too short")
	// ErrIncomplete reports an unfinished packet at Finish.
	ErrIncomplete = errors.New("dataeng: incomplete packet at finish")
)

// crc32cTable is the reflected CRC-32C (Castagnoli) table.
var crc32cTable = makeCRC32CTable()

func makeCRC32CTable() [256]uint32 {
	var table [256]uint32
	for i := 0; i < 256; i++ {
		crc := uint32(i)
		for j := 0; j < 8; j++ {
			if crc&1 != 0 {
				crc = (crc >> 1) ^ 0x82F63B78
			} else {
				crc >>= 1
			}
		}
		table[i] = crc
	}
	return table
}

// crc32cUpdate folds data into a running reflected CRC-32C state.
func crc32cUpdate(crc uint32, data []byte) uint32 {
	for _, b := range data {
		crc = (crc >> 8) ^ crc32cTable[byte(crc)^b]
	}
	return crc
}

// DataChunk is a delivered DATA chunk (type 0).
type DataChunk struct {
	Unordered    bool
	Beginning    bool
	Ending       bool
	TSN          uint32
	StreamID     uint16
	StreamSeq    uint16
	PayloadProto uint32
	Payload      []byte
}

// Packet is a delivered packet: common header plus its DATA chunks.
type Packet struct {
	SourcePort uint16
	DestPort   uint16
	VerifyTag  uint32
	Checksum   uint32
	Chunks     []DataChunk
}

// Collector reassembles packets from a byte stream. It never opens
// connections; the host feeds bytes with Push and ends input with Finish.
// A packet boundary is reached when chunks consume the buffered bytes
// exactly. Once a call fails the collector is stopped and keeps only the
// packets delivered so far.
type Collector struct {
	maxChunk int
	buf      []byte
	packets  []Packet
	err      error
}

// NewCollector returns a Collector rejecting chunks longer than maxChunk.
// A maxChunk below chunkHeaderLen disables the limit.
func NewCollector(maxChunk int) *Collector {
	return &Collector{maxChunk: maxChunk}
}

// Packets returns the packets delivered so far, kept even after failure.
func (c *Collector) Packets() []Packet {
	return c.packets
}

// Err returns the error that stopped the collector, if any.
func (c *Collector) Err() error {
	return c.err
}

// Push feeds stream bytes. It may stop in the middle of a chunk; parsing
// resumes once the rest arrives. It returns the first failure, if any.
func (c *Collector) Push(p []byte) error {
	if c.err != nil {
		return c.err
	}
	c.buf = append(c.buf, p...)
	if err := c.parse(); err != nil {
		c.err = err
		return err
	}
	return nil
}

// Finish ends the input. It fails if a packet is still incomplete.
func (c *Collector) Finish() error {
	if c.err != nil {
		return c.err
	}
	if len(c.buf) != 0 {
		c.err = fmt.Errorf("%w: %d bytes left", ErrIncomplete, len(c.buf))
		return c.err
	}
	return nil
}

// parse consumes complete packets from buf until only a partial packet
// remains. buf always holds exactly the unparsed rest of one packet, so a
// packet is complete when chunk parsing empties buf.
func (c *Collector) parse() error {
	for len(c.buf) > 0 {
		pkt, err := c.parsePacket()
		if err != nil {
			return err
		}
		if pkt == nil {
			return nil
		}
		c.packets = append(c.packets, *pkt)
	}
	return nil
}

// parsePacket parses one packet from the front of buf. It returns nil
// without consuming anything when more bytes are needed.
func (c *Collector) parsePacket() (*Packet, error) {
	if len(c.buf) < CommonHeaderLen {
		return nil, nil
	}
	pkt := &Packet{
		SourcePort: binary.BigEndian.Uint16(c.buf[0:2]),
		DestPort:   binary.BigEndian.Uint16(c.buf[2:4]),
		VerifyTag:  binary.BigEndian.Uint32(c.buf[4:8]),
		Checksum:   binary.BigEndian.Uint32(c.buf[8:12]),
	}
	offset := CommonHeaderLen
	for {
		if offset == len(c.buf) {
			if err := verifyChecksum(c.buf, pkt.Checksum); err != nil {
				return nil, err
			}
			c.buf = c.buf[offset:]
			return pkt, nil
		}
		if len(c.buf)-offset < chunkHeaderLen {
			return nil, nil
		}
		typ := c.buf[offset]
		flags := c.buf[offset+1]
		length := int(binary.BigEndian.Uint16(c.buf[offset+2 : offset+4]))
		if length < chunkHeaderLen {
			return nil, fmt.Errorf("%w: %d", ErrChunkLen, length)
		}
		if c.maxChunk >= chunkHeaderLen && length > c.maxChunk {
			return nil, fmt.Errorf("%w: %d > %d", ErrChunkTooLarge, length, c.maxChunk)
		}
		pad := (chunkHeaderLen - length%chunkHeaderLen) % chunkHeaderLen
		if len(c.buf)-offset < length+pad {
			return nil, nil
		}
		for _, b := range c.buf[offset+length : offset+length+pad] {
			if b != 0 {
				return nil, fmt.Errorf("%w: 0x%02x", ErrPadding, b)
			}
		}
		chunk, err := parseChunk(typ, flags, c.buf[offset+chunkHeaderLen:offset+length])
		if err != nil {
			return nil, err
		}
		if chunk != nil {
			pkt.Chunks = append(pkt.Chunks, *chunk)
		}
		offset += length + pad
	}
}

// parseChunk handles one chunk value. Chunks whose type has the high bit
// set are skipped and return nil without failing the packet.
func parseChunk(typ, flags byte, value []byte) (*DataChunk, error) {
	if typ != chunkTypeData {
		if typ&0x80 != 0 {
			return nil, nil
		}
		return nil, fmt.Errorf("%w: 0x%02x", ErrChunkType, typ)
	}
	if flags&flagReserved != 0 {
		return nil, fmt.Errorf("%w: 0x%02x", ErrFlags, flags)
	}
	if len(value)+chunkHeaderLen < dataChunkMinLen {
		return nil, fmt.Errorf("%w: %d", ErrDataLen, len(value)+chunkHeaderLen)
	}
	payload := make([]byte, len(value)-12)
	copy(payload, value[12:])
	return &DataChunk{
		Unordered:    flags&flagUnordered != 0,
		Beginning:    flags&flagBeginning != 0,
		Ending:       flags&flagEnding != 0,
		TSN:          binary.BigEndian.Uint32(value[0:4]),
		StreamID:     binary.BigEndian.Uint16(value[4:6]),
		StreamSeq:    binary.BigEndian.Uint16(value[6:8]),
		PayloadProto: binary.BigEndian.Uint32(value[8:12]),
		Payload:      payload,
	}, nil
}

// verifyChecksum checks the CRC-32C of raw with the checksum field
// (bytes 8-11 of the common header) treated as zero.
func verifyChecksum(raw []byte, want uint32) error {
	crc := crc32cUpdate(0xFFFFFFFF, raw[:8])
	crc = crc32cUpdate(crc, []byte{0, 0, 0, 0})
	crc = crc32cUpdate(crc, raw[CommonHeaderLen:])
	if crc^0xFFFFFFFF != want {
		return fmt.Errorf("%w: want 0x%08x", ErrChecksum, want)
	}
	return nil
}
