package pcapng_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"testing"

	"example.com/dlks/q208/pcapng"
)

// rawEPB builds an Enhanced Packet Block with explicit cap/orig lengths so the
// tests can craft inconsistent boundaries.
func rawEPB(b *fixtureBuilder, id, capLen, origLen uint32, data []byte) {
	b.currentBlockStart = len(b.buf)
	b.beginBlock(6)
	b.u32(id)
	b.u32(0)
	b.u32(0)
	b.u32(capLen)
	b.u32(origLen)
	b.raw(data)
	for pad := (4 - len(data)%4) % 4; pad > 0; pad-- {
		b.buf = append(b.buf, 0)
	}
	b.eoo()
	b.endBlock()
}

func runAndErr(t *testing.T, data []byte) error {
	t.Helper()
	rd := pcapng.NewReader(bytes.NewReader(data))
	for {
		_, err := rd.Next()
		if err != nil {
			return err
		}
	}
}

func TestValidationErrors(t *testing.T) {
	t.Run("length trailer mismatch", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		data := b.bytes()
		b.bo.PutUint32(data[len(data)-4:], 999)
		if err := runAndErr(t, data); !strings.Contains(err.Error(), "header length") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("unaligned length", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		data := b.bytes()
		b.bo.PutUint32(data[8:], 25)
		if err := runAndErr(t, data); !strings.Contains(err.Error(), "4-byte aligned") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("capture exceeds original", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.idb(1, 0)
		rawEPB(b, 0, 3, 2, []byte{1, 2, 3})
		if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "captured length") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("packet data beyond boundary", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.idb(1, 0)
		rawEPB(b, 0, 40, 40, nil)
		if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "block boundary") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("bad interface id", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.epb(5, 0, []byte{1}, 1)
		if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "references interface") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("block before section", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.epb(0, 0, []byte{1}, 1)
		err := runAndErr(t, b.bytes())
		if errors.Is(err, io.EOF) || !strings.Contains(err.Error(), "section header") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("bad shb magic", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		data := b.bytes()
		data[12] ^= 0xFF // first magic byte lives at body offset 0
		if err := runAndErr(t, data); !strings.Contains(err.Error(), "byte-order magic") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("idb reserved nonzero", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.currentBlockStart = len(b.buf)
		b.beginBlock(1)
		b.u16(1)
		b.u16(1)
		b.u32(0)
		b.eoo()
		b.endBlock()
		if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "reserved field") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("bad decimal tsresol exponent", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.idb(1, 0, tsResolOption(0x0A)) // 10^-10 is outside the allowed range
		if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "decimal timestamp exponent") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("option padding nonzero", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.currentBlockStart = len(b.buf)
		b.beginBlock(1)
		b.u16(1)
		b.u16(0)
		b.u32(0)
		b.option(9, []byte{0x06})
		b.buf[len(b.buf)-3] = 0xFF
		b.eoo()
		b.endBlock()
		if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "padding is not zero") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("option value exceeds area", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.currentBlockStart = len(b.buf)
		b.beginBlock(1)
		b.u16(1)
		b.u16(0)
		b.u32(0)
		b.u16(42)
		b.u16(200)
		b.raw([]byte{1, 2})
		b.endBlock()
		if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "exceeds option area") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("packet padding nonzero", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.idb(1, 0)
		b.currentBlockStart = len(b.buf)
		b.beginBlock(6)
		b.u32(0)
		b.u32(0)
		b.u32(0)
		b.u32(3)
		b.u32(3)
		b.raw([]byte{1, 2, 3, 0xFF}) // fourth byte is padding, must be zero
		b.eoo()
		b.endBlock()
		if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "packet data padding") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("unknown block still validated", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.unknownBlock(0x40000001, []byte{1, 2, 3})
		data := b.bytes()
		b.bo.PutUint32(data[len(data)-4:], 1234)
		if err := runAndErr(t, data); !strings.Contains(err.Error(), "header length") {
			t.Fatalf("got %v", err)
		}
	})
}

// TestBadBlockDoesNotPublishOrPollute is the core safety requirement: after a
// malformed block, no partial packet is published and the interface table for
// the section stays exactly as it was before the bad block.
func TestBadBlockDoesNotPublishOrPollute(t *testing.T) {
	t.Run("bad idb is not registered", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.idb(1, 0) // one good interface
		b.currentBlockStart = len(b.buf)
		b.beginBlock(1)
		b.u16(2)
		b.u16(7) // nonzero reserved -> invalid block
		b.u32(0)
		b.eoo()
		b.endBlock()

		rd := pcapng.NewReader(bytes.NewReader(b.bytes()))
		var packets int
		var err error
		for {
			pkt, e := rd.Next()
			if e != nil {
				err = e
				break
			}
			if pkt != nil {
				packets++
			}
		}
		if err == nil || errors.Is(err, io.EOF) {
			t.Fatalf("expected a validation error, got %v", err)
		}
		if packets != 0 {
			t.Fatalf("bad IDB published %d packets", packets)
		}
		if rd.IfaceCount() != 1 {
			t.Fatalf("interface table polluted: count=%d, want 1", rd.IfaceCount())
		}
		if !rd.SectionOpen() || rd.Fail() == nil {
			t.Fatalf("reader state inconsistent after error")
		}
	})

	t.Run("bad epb leaves interfaces intact", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.idb(1, 0)
		b.idb(2, 0)
		rawEPB(b, 9, 1, 1, []byte{0}) // unknown interface id

		rd := pcapng.NewReader(bytes.NewReader(b.bytes()))
		var err error
		for {
			_, e := rd.Next()
			if e != nil {
				err = e
				break
			}
		}
		if errors.Is(err, io.EOF) || !strings.Contains(err.Error(), "references interface") {
			t.Fatalf("got %v", err)
		}
		if rd.IfaceCount() != 2 {
			t.Fatalf("interface count=%d after bad EPB, want 2", rd.IfaceCount())
		}
	})

	t.Run("new section drops old interfaces", func(t *testing.T) {
		b := newFixtureBuilder(littleEndian())
		b.shb()
		b.idb(1, 0)
		b.idb(2, 0)
		b.shb() // second section: previous interfaces must be gone

		rd := pcapng.NewReader(bytes.NewReader(b.bytes()))
		for {
			_, err := rd.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		}
		if rd.IfaceCount() != 0 {
			t.Fatalf("old interfaces survived the new section: count=%d", rd.IfaceCount())
		}

		// Referencing the old interface number in the new section must fail.
		b.epb(0, 0, []byte{1}, 1)
		if err := runAndErr(t, b.bytes()); !strings.Contains(err.Error(), "references interface") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("big endian section keeps own numbering", func(t *testing.T) {
		le := newFixtureBuilder(binary.LittleEndian)
		le.shb()
		le.idb(1, 0)
		le.epb(0, 100, []byte{1}, 1)

		be := newFixtureBuilder(binary.BigEndian)
		be.shb()
		be.idb(99, 0)
		be.epb(0, 200, []byte{2}, 2)

		data := append(le.bytes(), be.bytes()...)
		pkts := mustPackets(t, data)
		if len(pkts) != 2 {
			t.Fatalf("got %d packets, want 2", len(pkts))
		}
		if pkts[0].LinkType != 1 || pkts[1].LinkType != 99 {
			t.Fatalf("interface numbering leaked across sections: %+v %+v", pkts[0], pkts[1])
		}
	})
}
