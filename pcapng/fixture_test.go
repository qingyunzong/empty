package pcapng_test

import (
	"encoding/binary"
)

// fixtureBuilder assembles pcapng blocks byte by byte using only the standard
// library, so the tests never depend on a second pcapng implementation.
type fixtureBuilder struct {
	buf               []byte
	bo                binary.ByteOrder
	currentBlockStart int
}

func newFixtureBuilder(bo binary.ByteOrder) *fixtureBuilder {
	return &fixtureBuilder{bo: bo}
}

func (b *fixtureBuilder) bytes() []byte { return b.buf }

// beginBlock appends a 12-byte block header with a placeholder total length.
// endBlock patches it.
func (b *fixtureBuilder) beginBlock(btype uint32) {
	var hdr [12]byte
	b.bo.PutUint32(hdr[0:4], btype)
	b.bo.PutUint32(hdr[8:12], 0) // patched in endBlock
	b.buf = append(b.buf, hdr[:]...)
}

func (b *fixtureBuilder) endBlock() {
	start := b.blockStart()
	for pad := (4 - (len(b.buf)-start)%4) % 4; pad > 0; pad-- {
		b.buf = append(b.buf, 0)
	}
	length := len(b.buf) - start + 4 // header+body padding so far, plus the trailer
	b.bo.PutUint32(b.buf[start+8:], uint32(length))
	var trailer [4]byte
	b.bo.PutUint32(trailer[:], uint32(length))
	b.buf = append(b.buf, trailer[:]...)
}

// blockStart returns the offset of the block currently being built.
func (b *fixtureBuilder) blockStart() int {
	return b.currentBlockStart
}

func (b *fixtureBuilder) u16(v uint16) {
	var buf [2]byte
	b.bo.PutUint16(buf[:], v)
	b.buf = append(b.buf, buf[:]...)
}

func (b *fixtureBuilder) u32(v uint32) {
	var buf [4]byte
	b.bo.PutUint32(buf[:], v)
	b.buf = append(b.buf, buf[:]...)
}

func (b *fixtureBuilder) u64(v uint64) {
	var buf [8]byte
	b.bo.PutUint64(buf[:], v)
	b.buf = append(b.buf, buf[:]...)
}

func (b *fixtureBuilder) raw(p []byte) {
	b.buf = append(b.buf, p...)
}

// option appends one option plus zero padding to the next 4-byte boundary.
func (b *fixtureBuilder) option(code uint16, value []byte) {
	b.u16(code)
	b.u16(uint16(len(value)))
	b.raw(value)
	for pad := (4 - len(value)%4) % 4; pad > 0; pad-- {
		b.buf = append(b.buf, 0)
	}
}

func (b *fixtureBuilder) eoo() { b.option(0, nil) }

// shb appends a Section Header Block for the builder's byte order.
func (b *fixtureBuilder) shb() {
	b.currentBlockStart = len(b.buf)
	b.beginBlock(0x0A0D0D0A)
	if b.bo == binary.BigEndian {
		b.raw([]byte{0x1A, 0x2B, 0x3C, 0x4D})
	} else {
		b.raw([]byte{0x4D, 0x3C, 0x2B, 0x1A})
	}
	b.u16(1) // major version
	b.u16(0) // minor version
	b.u64(0xFFFFFFFFFFFFFFFF)
	b.eoo()
	b.endBlock()
}

// idb appends an Interface Description Block. opts is appended before EOO.
func (b *fixtureBuilder) idb(linkType, snapLen uint32, opts ...func(*fixtureBuilder)) {
	b.currentBlockStart = len(b.buf)
	b.beginBlock(1)
	b.u16(uint16(linkType))
	b.u16(0) // reserved
	b.u32(snapLen)
	for _, opt := range opts {
		opt(b)
	}
	b.eoo()
	b.endBlock()
}

// epb appends an Enhanced Packet Block with zero-padded packet data.
func (b *fixtureBuilder) epb(iface uint32, ts uint64, data []byte, origLen uint32) {
	b.currentBlockStart = len(b.buf)
	b.beginBlock(6)
	b.u32(iface)
	b.u32(uint32(ts >> 32))
	b.u32(uint32(ts))
	b.u32(uint32(len(data)))
	b.u32(origLen)
	b.raw(data)
	for pad := (4 - len(data)%4) % 4; pad > 0; pad-- {
		b.buf = append(b.buf, 0)
	}
	b.eoo()
	b.endBlock()
}

// unknownBlock appends a block whose type the reader does not know.
func (b *fixtureBuilder) unknownBlock(btype uint32, payload []byte) {
	b.currentBlockStart = len(b.buf)
	b.beginBlock(btype)
	b.raw(payload)
	for pad := (4 - len(payload)%4) % 4; pad > 0; pad-- {
		b.buf = append(b.buf, 0)
	}
	b.endBlock()
}

func tsResolOption(v byte) func(*fixtureBuilder) {
	return func(b *fixtureBuilder) { b.option(9, []byte{v}) }
}
