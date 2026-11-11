package pcapng_test

import (
	"bytes"
	"encoding/binary"
	"io"
	"math/big"
	"strings"
	"testing"

	"example.com/dlks/q208/pcapng"
)

func TestByteOrderAndInterfaceSnapshot(t *testing.T) {
	b := newFixtureBuilder(binary.BigEndian)
	b.shb()
	b.idb(1, 0)
	b.idb(2, 0, tsResolOption(0x09))

	rd := pcapng.NewReader(bytes.NewReader(b.bytes()))
	if rd.ByteOrder() != nil {
		t.Fatalf("ByteOrder must be nil before the first SHB")
	}
	for {
		_, err := rd.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if rd.ByteOrder() != binary.BigEndian {
		t.Fatalf("ByteOrder = %v, want big-endian", rd.ByteOrder())
	}
	ifs := rd.Interfaces()
	if len(ifs) != 2 || ifs[0].LinkType != 1 || ifs[1].LinkType != 2 {
		t.Fatalf("interface snapshot wrong: %+v", ifs)
	}

	// The snapshot must be independent from the reader's internal slice.
	ifs[0] = nil
	again := rd.Interfaces()
	if again[0] == nil || again[0].LinkType != 1 {
		t.Fatalf("Interfaces() did not return an independent snapshot")
	}
}

func TestResolutionString(t *testing.T) {
	b := newFixtureBuilder(binary.LittleEndian)
	b.shb()
	b.idb(1, 0)
	b.idb(1, 0, tsResolOption(0x80|0x17))
	rd := pcapng.NewReader(bytes.NewReader(b.bytes()))
	for {
		_, err := rd.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	ifs := rd.Interfaces()
	if got := ifs[0].Resolution.String(); got != "10^-6 s" {
		t.Fatalf("default resolution string = %q", got)
	}
	if got := ifs[1].Resolution.String(); got != "2^-23 s" {
		t.Fatalf("binary resolution string = %q", got)
	}
}

func TestLargeBinaryResolutionExact(t *testing.T) {
	// 2^-60 seconds: a large exponent that cannot be represented as a decimal
	// fraction, so the rational result must stay exact.
	b := newFixtureBuilder(binary.LittleEndian)
	b.shb()
	b.idb(1, 0, tsResolOption(0x80|60))
	b.epb(0, 3, nil, 0)
	pkts := mustPackets(t, b.bytes())
	want := new(big.Rat).SetFrac(big.NewInt(3), new(big.Int).Lsh(big.NewInt(1), 60))
	if pkts[0].Timestamp.Cmp(want) != 0 {
		t.Fatalf("timestamp = %s, want %s", pkts[0].Timestamp.RatString(), want.RatString())
	}
}

func TestUnknownOptionsAreSkipped(t *testing.T) {
	// A custom, unknown option code with 3 value bytes (hence 1 padding byte)
	// must be skipped using its own length, and the following EPB still parses.
	b := newFixtureBuilder(binary.LittleEndian)
	b.shb()
	b.currentBlockStart = len(b.buf)
	b.beginBlock(1)
	b.u16(1)
	b.u16(0)
	b.u32(0)
	b.option(0x0BAD, []byte{1, 2, 3}) // unknown to the reader
	b.eoo()
	b.endBlock()
	b.epb(0, 2, []byte{0x0F}, 1)

	pkts := mustPackets(t, b.bytes())
	if len(pkts) != 1 || pkts[0].Data[0] != 0x0F {
		t.Fatalf("packet after unknown option not decoded: %+v", pkts)
	}
}

func TestNoOptionsArea(t *testing.T) {
	// Blocks are legal without any options (and without an EOO option).
	b := newFixtureBuilder(binary.LittleEndian)
	b.shb()
	b.currentBlockStart = len(b.buf)
	b.beginBlock(1)
	b.u16(1)
	b.u16(0)
	b.u32(0)
	b.endBlock()
	b.epb(0, 1, []byte{7}, 1)
	pkts := mustPackets(t, b.bytes())
	if len(pkts) != 1 {
		t.Fatalf("got %d packets, want 1", len(pkts))
	}
}

func TestMalformedSHBTooShort(t *testing.T) {
	data := []byte{
		0x0A, 0x0D, 0x0D, 0x0A, // block type
		0x14, 0x00, 0x00, 0x00, // total length 20 (< minimum 32)
		0x4D, 0x3C, 0x2B, 0x1A, // little-endian magic
		0x01, 0x00, 0x00, 0x00,
		0x14, 0x00, 0x00, 0x00, // trailer
	}
	err := runAndErr(t, data)
	if !strings.Contains(err.Error(), "invalid") {
		t.Fatalf("got %v", err)
	}
}

func TestBadTSResolValueLength(t *testing.T) {
	b := newFixtureBuilder(binary.LittleEndian)
	b.shb()
	b.currentBlockStart = len(b.buf)
	b.beginBlock(1)
	b.u16(1)
	b.u16(0)
	b.u32(0)
	b.option(9, []byte{0x06, 0x06}) // tsresol must be exactly one byte
	b.eoo()
	b.endBlock()
	if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "if_tsresol") {
		t.Fatalf("got %v", err)
	}
}

func TestEOOWithNonZeroLength(t *testing.T) {
	b := newFixtureBuilder(binary.LittleEndian)
	b.shb()
	b.currentBlockStart = len(b.buf)
	b.beginBlock(1)
	b.u16(1)
	b.u16(0)
	b.u32(0)
	b.u16(0) // EOO code
	b.u16(2) // but a non-zero length
	b.u16(0)
	b.endBlock()
	if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "end-of-options") {
		t.Fatalf("got %v", err)
	}
}

func TestNonSHBLengthTooSmall(t *testing.T) {
	b := newFixtureBuilder(binary.LittleEndian)
	b.shb()
	b.currentBlockStart = len(b.buf)
	b.beginBlock(1)
	// Patch the total length to something below the 12-byte minimum.
	b.bo.PutUint32(b.buf[len(b.buf)-4:], 8)
	if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "smaller than") {
		t.Fatalf("got %v", err)
	}
}

func TestNonSHBUnalignedLength(t *testing.T) {
	b := newFixtureBuilder(binary.LittleEndian)
	b.shb()
	b.currentBlockStart = len(b.buf)
	b.beginBlock(1)
	b.u16(1)
	b.u16(0)
	b.u32(0)
	b.eoo()
	b.endBlock()
	// Rewrite the header total length to an odd value without changing how
	// many bytes the stream actually contains; the alignment check fires
	// before the body is consumed.
	length := uint32(25) // aligned check order: non-multiple of 4, above the minimum
	b.bo.PutUint32(b.buf[b.currentBlockStart+8:], length)
	if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "4-byte aligned") {
		t.Fatalf("got %v", err)
	}
}

func TestSHBBodyTooShort(t *testing.T) {
	// Valid-looking header and magic, but the declared body cannot hold the
	// fixed SHB fields plus trailer.
	data := []byte{
		0x0A, 0x0D, 0x0D, 0x0A,
		0x20, 0x00, 0x00, 0x00, // total length 32
		0x4D, 0x3C, 0x2B, 0x1A,
		0x01, 0x00, // major only; stream then ends before the fixed fields
	}
	err := runAndErr(t, data)
	if err == nil || err == io.EOF {
		t.Fatalf("expected a truncation/body error, got %v", err)
	}
}
