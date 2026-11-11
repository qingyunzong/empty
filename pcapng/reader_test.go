package pcapng_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"math/big"
	"testing"

	"example.com/dlks/q208/pcapng"
)

func mustPackets(t *testing.T, data []byte) []*pcapng.Packet {
	t.Helper()
	rd := pcapng.NewReader(bytes.NewReader(data))
	var out []*pcapng.Packet
	for {
		pkt, err := rd.Next()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if pkt != nil {
			out = append(out, pkt)
		}
	}
}

func wantRat(t *testing.T, got *big.Rat, num, den int64) {
	t.Helper()
	want := big.NewRat(num, den)
	if got.Cmp(want) != 0 {
		t.Fatalf("timestamp = %s, want %s", got.RatString(), want.RatString())
	}
}

// TestMixedEndianSections builds sections with opposite byte orders and
// independent interface numbering, then switches back again.
func TestMixedEndianSections(t *testing.T) {
	le := newFixtureBuilder(binary.LittleEndian)
	le.shb()
	le.idb(1, 65535)                    // section 0 interface 0
	le.idb(12, 0)                       // section 0 interface 1
	le.epb(1, 7, []byte{0xAA, 0xBB}, 4) // via interface 1

	be := newFixtureBuilder(binary.BigEndian)
	be.shb()
	be.idb(101, 128)              // section 1 interface 0, fresh table
	be.epb(0, 9, []byte{0xCC}, 1) // via the new interface 0
	be.unknownBlock(0x40000001, []byte{1, 2, 3, 4, 5})

	leAgain := newFixtureBuilder(binary.LittleEndian)
	leAgain.shb() // third section, table reset again
	leAgain.idb(7, 0)
	leAgain.epb(0, 11, []byte{1, 2, 3}, 3)

	data := append(le.bytes(), be.bytes()...)
	data = append(data, leAgain.bytes()...)

	pkts := mustPackets(t, data)
	if len(pkts) != 3 {
		t.Fatalf("got %d packets, want 3", len(pkts))
	}

	if pkts[0].Interface != 1 || pkts[0].LinkType != 12 || !bytes.Equal(pkts[0].Data, []byte{0xAA, 0xBB}) {
		t.Fatalf("packet 0 mismatch: %+v", pkts[0])
	}
	wantRat(t, pkts[0].Timestamp, 7, 1_000_000)
	if pkts[0].OriginalLength != 4 || len(pkts[0].Data) != 2 {
		t.Fatalf("packet 0 lengths wrong: orig=%d data=%d", pkts[0].OriginalLength, len(pkts[0].Data))
	}

	if pkts[1].Interface != 0 || pkts[1].LinkType != 101 || !bytes.Equal(pkts[1].Data, []byte{0xCC}) {
		t.Fatalf("packet 1 mismatch: %+v", pkts[1])
	}
	wantRat(t, pkts[1].Timestamp, 9, 1_000_000)

	if pkts[2].LinkType != 7 {
		t.Fatalf("packet 2 should use new section's interface, got link type %d", pkts[2].LinkType)
	}
	wantRat(t, pkts[2].Timestamp, 11, 1_000_000)
}

// TestUnknownBlocksSkipped places unknown blocks before, between and after
// meaningful blocks.
func TestUnknownBlocksSkipped(t *testing.T) {
	b := newFixtureBuilder(binary.LittleEndian)
	b.shb()
	b.unknownBlock(0x40000001, []byte{9, 9, 9})
	b.unknownBlock(0x00001234, []byte("hello world"))
	b.idb(1, 0)
	b.unknownBlock(0x7FFFFFFF, []byte{0xDE, 0xAD})
	b.epb(0, 5, []byte{1, 2, 3, 4, 5}, 5)
	b.unknownBlock(0x40000002, nil)

	pkts := mustPackets(t, b.bytes())
	if len(pkts) != 1 || !bytes.Equal(pkts[0].Data, []byte{1, 2, 3, 4, 5}) {
		t.Fatalf("unexpected packets: %+v", pkts)
	}
}

// TestTimestampResolution covers the absent-option default, decimal exponents
// and binary exponents, asserting exact rational seconds in every case.
func TestTimestampResolution(t *testing.T) {
	b := newFixtureBuilder(binary.LittleEndian)
	b.shb()
	b.idb(1, 0)                           // if 0: default microseconds
	b.idb(1, 0, tsResolOption(0x09))      // if 1: 10^-9 s
	b.idb(1, 0, tsResolOption(0x03))      // if 2: 10^-3 s
	b.idb(1, 0, tsResolOption(0x80|0x17)) // if 3: 2^-23 s
	b.idb(1, 0, tsResolOption(0x80))      // if 4: 2^0 = 1 s

	b.epb(0, 1_234_567, nil, 0)
	b.epb(1, 1_000_000_000, nil, 0)
	b.epb(2, 2_500, nil, 0)
	b.epb(3, 1<<23, nil, 0)
	b.epb(4, 42, nil, 0)

	pkts := mustPackets(t, b.bytes())
	if len(pkts) != 5 {
		t.Fatalf("got %d packets, want 5", len(pkts))
	}
	wantRat(t, pkts[0].Timestamp, 1_234_567, 1_000_000)
	wantRat(t, pkts[1].Timestamp, 1, 1)
	wantRat(t, pkts[2].Timestamp, 5, 2)
	wantRat(t, pkts[3].Timestamp, 1, 1)
	wantRat(t, pkts[4].Timestamp, 42, 1)

	if got := pkts[0].Seconds(); got != 1.234567 {
		t.Fatalf("Seconds() = %v, want 1.234567", got)
	}

	if ifs := pcapng.NewReader(bytes.NewReader(b.bytes())).Interfaces(); len(ifs) != 0 {
		t.Fatalf("Interfaces() before reading must be empty")
	}
}
