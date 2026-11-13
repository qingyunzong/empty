package dataeng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

// testCRC32C is an independent bit-wise reflected CRC-32C used only to
// build expected packets; it never calls the code under test.
func testCRC32C(data []byte) uint32 {
	crc := uint32(0xFFFFFFFF)
	for _, b := range data {
		crc ^= uint32(b)
		for i := 0; i < 8; i++ {
			if crc&1 != 0 {
				crc = (crc >> 1) ^ 0x82F63B78
			} else {
				crc >>= 1
			}
		}
	}
	return crc ^ 0xFFFFFFFF
}

func TestCRC32CVector(t *testing.T) {
	if got := testCRC32C([]byte("123456789")); got != 0xE3069283 {
		t.Fatalf("test CRC-32C vector: got 0x%08X, want 0xE3069283", got)
	}
}

// buildChunk assembles type, flags, big-endian length, value and zero
// padding up to a multiple of 4 bytes.
func buildChunk(typ, flags byte, value []byte) []byte {
	chunk := make([]byte, 4, 4+len(value)+3)
	chunk[0] = typ
	chunk[1] = flags
	binary.BigEndian.PutUint16(chunk[2:4], uint16(4+len(value)))
	chunk = append(chunk, value...)
	for len(chunk)%4 != 0 {
		chunk = append(chunk, 0)
	}
	return chunk
}

// dataValue builds the fixed DATA chunk value fields plus user payload.
func dataValue(tsn uint32, stream, seq uint16, proto uint32, payload []byte) []byte {
	value := make([]byte, 12, 12+len(payload))
	binary.BigEndian.PutUint32(value[0:4], tsn)
	binary.BigEndian.PutUint16(value[4:6], stream)
	binary.BigEndian.PutUint16(value[6:8], seq)
	binary.BigEndian.PutUint32(value[8:12], proto)
	return append(value, payload...)
}

// buildPacket assembles a packet and fills the checksum field with the
// CRC-32C computed with that field treated as zero.
func buildPacket(src, dst uint16, tag uint32, chunks ...[]byte) []byte {
	pkt := make([]byte, CommonHeaderLen)
	binary.BigEndian.PutUint16(pkt[0:2], src)
	binary.BigEndian.PutUint16(pkt[2:4], dst)
	binary.BigEndian.PutUint32(pkt[4:8], tag)
	for _, chunk := range chunks {
		pkt = append(pkt, chunk...)
	}
	binary.BigEndian.PutUint32(pkt[8:12], testCRC32C(pkt))
	return pkt
}

func TestDataChunkWithPadding(t *testing.T) {
	// Length 17 (4 header + 12 fixed + 1 payload) leaves 3 padding bytes.
	payload := []byte{0xAB}
	chunk := buildChunk(0, flagBeginning|flagEnding, dataValue(0x01020304, 7, 9, 0x11223344, payload))
	if got := len(chunk) % 4; got != 0 {
		t.Fatalf("padded chunk length not multiple of 4: %d", got)
	}
	if binary.BigEndian.Uint16(chunk[2:4]) != 17 {
		t.Fatalf("chunk length = %d, want 17", binary.BigEndian.Uint16(chunk[2:4]))
	}
	if !bytes.Equal(chunk[len(chunk)-3:], []byte{0, 0, 0}) {
		t.Fatalf("expected 3 zero padding bytes, got % x", chunk[len(chunk)-3:])
	}
	pkt := buildPacket(5000, 6000, 0xDEADBEEF, chunk)

	c := NewCollector(1 << 16)
	// Push may stop in the middle of a chunk.
	for _, cut := range [][2]int{{0, 5}, {5, 19}, {19, 26}, {26, len(pkt)}} {
		if err := c.Push(pkt[cut[0]:cut[1]]); err != nil {
			t.Fatalf("Push(%d:%d): %v", cut[0], cut[1], err)
		}
	}
	if err := c.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	pkts := c.Packets()
	if len(pkts) != 1 {
		t.Fatalf("delivered %d packets, want 1", len(pkts))
	}
	got := pkts[0]
	if got.SourcePort != 5000 || got.DestPort != 6000 || got.VerifyTag != 0xDEADBEEF {
		t.Fatalf("header = %+v", got)
	}
	if got.Checksum != binary.BigEndian.Uint32(pkt[8:12]) {
		t.Fatalf("checksum = 0x%08X, want 0x%08X", got.Checksum, binary.BigEndian.Uint32(pkt[8:12]))
	}
	if len(got.Chunks) != 1 {
		t.Fatalf("delivered %d chunks, want 1", len(got.Chunks))
	}
	dc := got.Chunks[0]
	if dc.Unordered || !dc.Beginning || !dc.Ending {
		t.Fatalf("flags: unordered=%v beginning=%v ending=%v", dc.Unordered, dc.Beginning, dc.Ending)
	}
	if dc.TSN != 0x01020304 || dc.StreamID != 7 || dc.StreamSeq != 9 || dc.PayloadProto != 0x11223344 {
		t.Fatalf("data fields = %+v", dc)
	}
	if !bytes.Equal(dc.Payload, payload) {
		t.Fatalf("payload = % x, want % x", dc.Payload, payload)
	}
}

func TestSkipHighBitChunk(t *testing.T) {
	skipped := buildChunk(0xC0, 0xFF, []byte{1, 2, 3, 4, 5})
	data := buildChunk(0, flagEnding, dataValue(42, 1, 1, 7, []byte("hi")))
	pkt := buildPacket(1, 2, 3, skipped, data)

	c := NewCollector(1 << 16)
	if err := c.Push(pkt); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := c.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	pkts := c.Packets()
	if len(pkts) != 1 {
		t.Fatalf("delivered %d packets, want 1", len(pkts))
	}
	if len(pkts[0].Chunks) != 1 {
		t.Fatalf("delivered %d chunks, want 1 (skipped chunk not delivered)", len(pkts[0].Chunks))
	}
	if pkts[0].Chunks[0].TSN != 42 {
		t.Fatalf("TSN = %d, want 42", pkts[0].Chunks[0].TSN)
	}
}

func TestUnknownLowBitTypeFails(t *testing.T) {
	good := buildPacket(1, 2, 3, buildChunk(0, flagEnding, dataValue(1, 1, 1, 1, nil)))
	bad := buildPacket(1, 2, 3, buildChunk(0x01, 0, []byte{9, 9, 9, 9}))

	c := NewCollector(1 << 16)
	if err := c.Push(good); err != nil {
		t.Fatalf("Push good: %v", err)
	}
	if err := c.Push(bad); !errors.Is(err, ErrChunkType) {
		t.Fatalf("Push bad: got %v, want ErrChunkType", err)
	}
	// Failure stops the component; delivered packets are kept.
	if err := c.Push(good); err == nil {
		t.Fatal("Push after failure: got nil, want error")
	}
	if err := c.Finish(); err == nil {
		t.Fatal("Finish after failure: got nil, want error")
	}
	if got := len(c.Packets()); got != 1 {
		t.Fatalf("kept %d packets, want 1", got)
	}
}

func TestChecksumFieldNotZeroed(t *testing.T) {
	chunk := buildChunk(0, flagEnding, dataValue(7, 3, 5, 11, []byte("data")))

	// Checksum computed with the field left at a non-zero placeholder
	// instead of being treated as zero must be rejected.
	pkt := make([]byte, CommonHeaderLen)
	binary.BigEndian.PutUint16(pkt[0:2], 100)
	binary.BigEndian.PutUint16(pkt[2:4], 200)
	binary.BigEndian.PutUint32(pkt[4:8], 0x0BADF00D)
	binary.BigEndian.PutUint32(pkt[8:12], 0xAABBCCDD)
	pkt = append(pkt, chunk...)
	binary.BigEndian.PutUint32(pkt[8:12], testCRC32C(pkt))

	c := NewCollector(1 << 16)
	if err := c.Push(pkt); !errors.Is(err, ErrChecksum) {
		t.Fatalf("Push: got %v, want ErrChecksum", err)
	}
	if got := len(c.Packets()); got != 0 {
		t.Fatalf("delivered %d packets, want 0", got)
	}

	// A packet whose checksum is computed with the field zeroed passes.
	good := buildPacket(100, 200, 0x0BADF00D, chunk)
	c2 := NewCollector(1 << 16)
	if err := c2.Push(good); err != nil {
		t.Fatalf("Push good: %v", err)
	}
	if err := c2.Finish(); err != nil {
		t.Fatalf("Finish good: %v", err)
	}
	if got := len(c2.Packets()); got != 1 {
		t.Fatalf("delivered %d packets, want 1", got)
	}
}

func TestChunkTooLargeRejectedEarly(t *testing.T) {
	c := NewCollector(16)
	pkt := make([]byte, CommonHeaderLen+4)
	binary.BigEndian.PutUint16(pkt[12:14], 0)
	binary.BigEndian.PutUint16(pkt[14:16], 0xFFFF) // declared length
	// Rejected as soon as the 2 length bytes are readable; the declared
	// value bytes never arrive and nothing is allocated for them.
	if err := c.Push(pkt); !errors.Is(err, ErrChunkTooLarge) {
		t.Fatalf("Push: got %v, want ErrChunkTooLarge", err)
	}
}

func TestChunkLengthTooSmall(t *testing.T) {
	c := NewCollector(1 << 16)
	pkt := make([]byte, CommonHeaderLen+4)
	binary.BigEndian.PutUint16(pkt[14:16], 3)
	if err := c.Push(pkt); !errors.Is(err, ErrChunkLen) {
		t.Fatalf("Push: got %v, want ErrChunkLen", err)
	}
}

func TestNonZeroPadding(t *testing.T) {
	chunk := buildChunk(0, flagEnding, dataValue(1, 1, 1, 1, []byte{0x01}))
	chunk[len(chunk)-1] = 0xFF // corrupt one of the 3 padding bytes
	pkt := buildPacket(1, 2, 3, chunk)
	c := NewCollector(1 << 16)
	if err := c.Push(pkt); !errors.Is(err, ErrPadding) {
		t.Fatalf("Push: got %v, want ErrPadding", err)
	}
}

func TestReservedFlags(t *testing.T) {
	chunk := buildChunk(0, 0x08, dataValue(1, 1, 1, 1, nil))
	pkt := buildPacket(1, 2, 3, chunk)
	c := NewCollector(1 << 16)
	if err := c.Push(pkt); !errors.Is(err, ErrFlags) {
		t.Fatalf("Push: got %v, want ErrFlags", err)
	}
}

func TestDataChunkTooShort(t *testing.T) {
	chunk := buildChunk(0, flagEnding, make([]byte, 8)) // length 12 < 16
	pkt := buildPacket(1, 2, 3, chunk)
	c := NewCollector(1 << 16)
	if err := c.Push(pkt); !errors.Is(err, ErrDataLen) {
		t.Fatalf("Push: got %v, want ErrDataLen", err)
	}
}

func TestFinishIncomplete(t *testing.T) {
	pkt := buildPacket(1, 2, 3, buildChunk(0, flagEnding, dataValue(1, 1, 1, 1, []byte("hello"))))
	c := NewCollector(1 << 16)
	if err := c.Push(pkt[:len(pkt)-2]); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := c.Finish(); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("Finish: got %v, want ErrIncomplete", err)
	}
}

func TestMultiplePacketsOneStream(t *testing.T) {
	p1 := buildPacket(10, 20, 30, buildChunk(0, flagBeginning|flagEnding, dataValue(1, 1, 1, 1, []byte("a"))))
	p2 := buildPacket(40, 50, 60, buildChunk(0, flagUnordered|flagEnding, dataValue(2, 2, 2, 2, []byte("bc"))))
	c := NewCollector(1 << 16)
	// A packet is delivered once its chunks consume the pushed bytes
	// exactly; the next Push starts the next packet.
	if err := c.Push(p1); err != nil {
		t.Fatalf("Push p1: %v", err)
	}
	if got := len(c.Packets()); got != 1 {
		t.Fatalf("delivered %d packets after p1, want 1", got)
	}
	if err := c.Push(p2); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := c.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	pkts := c.Packets()
	if len(pkts) != 2 {
		t.Fatalf("delivered %d packets, want 2", len(pkts))
	}
	if pkts[0].SourcePort != 10 || pkts[1].SourcePort != 40 {
		t.Fatalf("source ports = %d, %d", pkts[0].SourcePort, pkts[1].SourcePort)
	}
}
