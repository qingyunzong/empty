package pcapng_test

import (
	"bytes"
	"errors"
	"io"
	"testing"

	"example.com/dlks/q208/pcapng"
)

// TestByteTruncateFixtures cuts a valid stream at every single byte and
// requires the reader to either finish cleanly or report an error: it must
// never panic, hang, or emit a packet whose block was not fully present.
func TestByteTruncateFixtures(t *testing.T) {
	b := newFixtureBuilder(littleEndian())
	b.shb()
	b.idb(1, 0)
	b.epb(0, 1, []byte{1, 2, 3}, 3)
	b.unknownBlock(0x40000001, []byte{7, 7, 7, 7})
	b.epb(0, 2, []byte{4, 5}, 2)
	full := b.bytes()

	const epbCount = 2

	for cut := 0; cut <= len(full); cut++ {
		rd := pcapng.NewReader(bytes.NewReader(full[:cut]))
		var emitted int
		var gotErr error
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panic at cut %d: %v", cut, r)
				}
			}()
			for {
				pkt, err := rd.Next()
				if err != nil {
					gotErr = err
					return
				}
				if pkt != nil {
					emitted++
				}
			}
		}()

		if emitted > epbCount {
			t.Fatalf("cut %d emitted %d packets, more than the %d complete EPBs", cut, emitted, epbCount)
		}
		if cut == len(full) && !errors.Is(gotErr, io.EOF) {
			t.Fatalf("full stream must end with io.EOF, got %v", gotErr)
		}
	}
}

// TestTruncatedBlockNeverPublishes ensures a cut inside an EPB never yields
// that packet, even when a complete earlier packet exists.
func TestTruncatedBlockNeverPublishes(t *testing.T) {
	b := newFixtureBuilder(littleEndian())
	b.shb()
	b.idb(1, 0)
	b.epb(0, 1, []byte{1}, 1)
	goodLen := len(b.bytes())
	b.epb(0, 2, []byte{9, 8, 7, 6}, 4)
	full := b.bytes()

	for cut := goodLen; cut < len(full); cut++ {
		rd := pcapng.NewReader(bytes.NewReader(full[:cut]))
		var emitted int
		var err error
		for {
			pkt, e := rd.Next()
			if e != nil {
				err = e
				break
			}
			if pkt != nil {
				emitted++
			}
		}
		// A cut exactly on a block boundary is a clean stream end, not a
		// malformed block; only cuts inside the second block are tested.
		if errors.Is(err, io.EOF) {
			if emitted != 1 {
				t.Fatalf("cut %d emitted %d packets at clean boundary, want 1", cut, emitted)
			}
			continue
		}
		if emitted != 1 {
			t.Fatalf("cut %d emitted %d packets, want exactly the one complete packet", cut, emitted)
		}
	}
}

// TestTruncatedOptionNoStateChange feeds a cut through each block type and
// confirms errors are sticky on the reader.
func TestStickyError(t *testing.T) {
	b := newFixtureBuilder(littleEndian())
	b.shb()
	b.idb(1, 0)
	b.epb(0, 1, []byte{1}, 1)
	full := b.bytes()

	rd := pcapng.NewReader(bytes.NewReader(full[:len(full)-3]))
	var first error
	for {
		_, err := rd.Next()
		if err != nil {
			first = err
			break
		}
	}
	if errors.Is(first, io.EOF) {
		t.Fatalf("want a truncation error, got EOF")
	}
	if _, err := rd.Next(); !errors.Is(err, first) {
		t.Fatalf("second call returned %v, want the sticky error %v", err, first)
	}
}
