package serialframe

import (
	"bytes"
	"math/rand"
	"testing"
)

const testMaxPayload = 64

func feedAll(t *testing.T, p *Parser, chunks ...[]byte) []Frame {
	t.Helper()
	var out []Frame
	for _, c := range chunks {
		out = append(out, p.Feed(c)...)
	}
	return out
}

func framesEqual(a, b []Frame) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Seq != b[i].Seq || !bytes.Equal(a[i].Payload, b[i].Payload) {
			return false
		}
	}
	return true
}

// testStream builds a stream of valid frames covering edge cases:
// empty payload, magic bytes inside payload, max-size payload.
func testStream() (stream []byte, want []Frame) {
	payloads := [][]byte{
		{},
		[]byte("hello"),
		{0xAA, 0x55, 0xAA, 0x55, 0x01}, // magic inside payload
		bytes.Repeat([]byte{0xAA}, 10), // repeated first magic byte
		bytes.Repeat([]byte{0x5A}, testMaxPayload),
	}
	for i, pl := range payloads {
		stream = append(stream, EncodeFrame(byte(i+1), pl)...)
		want = append(want, Frame{Seq: byte(i + 1), Payload: pl})
	}
	return stream, want
}

// TestAllSplitPositions feeds the stream split at every possible position;
// every split must yield exactly the same successful frames.
func TestAllSplitPositions(t *testing.T) {
	stream, want := testStream()
	for i := 0; i <= len(stream); i++ {
		p := NewParser(testMaxPayload)
		got := feedAll(t, p, stream[:i], stream[i:])
		if !framesEqual(got, want) {
			t.Fatalf("split at %d: got %+v, want %+v", i, got, want)
		}
		if p.Discarded != 0 {
			t.Fatalf("split at %d: discarded %d bytes from a clean stream", i, p.Discarded)
		}
		if p.Buffered() != 0 {
			t.Fatalf("split at %d: %d bytes left buffered", i, p.Buffered())
		}
	}
}

// TestByteByByte and random chunkings must behave identically.
func TestChunkings(t *testing.T) {
	stream, want := testStream()

	p := NewParser(testMaxPayload)
	var got []Frame
	for _, b := range stream {
		got = append(got, p.Feed([]byte{b})...)
	}
	if !framesEqual(got, want) {
		t.Fatalf("byte-by-byte: got %+v, want %+v", got, want)
	}

	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 50; trial++ {
		p := NewParser(testMaxPayload)
		got = nil
		for off := 0; off < len(stream); {
			n := 1 + rng.Intn(17)
			if off+n > len(stream) {
				n = len(stream) - off
			}
			got = append(got, p.Feed(stream[off:off+n])...)
			off += n
		}
		if !framesEqual(got, want) {
			t.Fatalf("random chunking %d: got %+v, want %+v", trial, got, want)
		}
	}
}

// TestGarbageDiscard: garbage before, between and after frames is discarded
// and accounted for exactly.
func TestGarbageDiscard(t *testing.T) {
	garbage1 := []byte{0x00, 0x11, 0xAA, 0x22, 0x55} // contains lone magic bytes
	f1 := EncodeFrame(7, []byte("abc"))
	garbage2 := []byte{0xAA, 0xAA, 0xAA} // magic0 never followed by magic1
	f2 := EncodeFrame(8, []byte("defgh"))
	tail := []byte{0x99}

	stream := append(append(append(append(append([]byte{}, garbage1...), f1...), garbage2...), f2...), tail...)

	want := []Frame{{Seq: 7, Payload: []byte("abc")}, {Seq: 8, Payload: []byte("defgh")}}
	for i := 0; i <= len(stream); i++ {
		p := NewParser(testMaxPayload)
		got := feedAll(t, p, stream[:i], stream[i:])
		if !framesEqual(got, want) {
			t.Fatalf("split %d: got %+v, want %+v", i, got, want)
		}
		// Byte conservation: fed = discarded + consumed by frames + buffered.
		consumed := len(f1) + len(f2)
		if got, want := len(stream), p.Discarded+consumed+p.Buffered(); got != want {
			t.Fatalf("split %d: byte conservation violated: fed %d != %d", i, got, want)
		}
	}
	// Whole stream at once: all garbage plus the 1-byte tail are accounted.
	p := NewParser(testMaxPayload)
	feedAll(t, p, stream)
	if p.Discarded != len(garbage1)+len(garbage2)+len(tail) {
		t.Fatalf("discarded %d, want %d", p.Discarded, len(garbage1)+len(garbage2)+len(tail))
	}
}

// TestBadCRCResync: a frame with a corrupted CRC is dropped byte by byte
// starting one byte after its magic, and the following valid frame — whose
// magic sits inside the bad frame's span — is still recovered.
func TestBadCRCResync(t *testing.T) {
	// Payload embeds a magic followed by an oversize length, so the
	// resync after the bad CRC walks through it and recovers.
	bad := EncodeFrame(1, []byte{0xAA, 0x55, 0xFF, 0xFF})
	bad[len(bad)-1] ^= 0xFF // corrupt CRC
	good := EncodeFrame(2, []byte("ok"))
	stream := append(append([]byte{}, bad...), good...)

	for i := 0; i <= len(stream); i++ {
		p := NewParser(testMaxPayload)
		got := feedAll(t, p, stream[:i], stream[i:])
		want := []Frame{{Seq: 2, Payload: []byte("ok")}}
		if !framesEqual(got, want) {
			t.Fatalf("split %d: got %+v, want %+v", i, got, want)
		}
	}
	p := NewParser(testMaxPayload)
	feedAll(t, p, stream)
	if p.Discarded != len(bad) {
		t.Fatalf("discarded %d, want %d (the whole bad frame)", p.Discarded, len(bad))
	}
}

// TestOversizeLength: a length field beyond the limit must not trigger a
// large allocation or stall; parsing resynchronizes on the next real frame.
func TestOversizeLength(t *testing.T) {
	evil := []byte{Magic0, Magic1, 0xFF, 0xFF, 0x01} // length = 65535
	good := EncodeFrame(9, []byte("hi"))
	stream := append(append([]byte{}, evil...), good...)

	p := NewParser(testMaxPayload)
	got := feedAll(t, p, stream)
	want := []Frame{{Seq: 9, Payload: []byte("hi")}}
	if !framesEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if p.Discarded != len(evil) {
		t.Fatalf("discarded %d, want %d", p.Discarded, len(evil))
	}
	if p.Buffered() > magicLen-1 {
		t.Fatalf("buffered %d bytes after oversize length, want <= %d", p.Buffered(), magicLen-1)
	}
}

// TestMemoryBound: the retained buffer never exceeds the maximum frame
// size, no matter what is fed or how it is chunked.
func TestMemoryBound(t *testing.T) {
	p := NewParser(testMaxPayload)
	maxObserved := 0
	check := func() {
		if n := p.Buffered(); n > maxObserved {
			maxObserved = n
		}
		if p.Buffered() > p.MaxFrameSize() {
			t.Fatalf("retained buffer %d exceeds max frame size %d", p.Buffered(), p.MaxFrameSize())
		}
	}

	// Flood with 1 MiB of garbage containing no magic, in odd-sized chunks.
	rng := rand.New(rand.NewSource(2))
	garbage := make([]byte, 1<<20)
	for i := range garbage {
		garbage[i] = byte(rng.Intn(256))
		if garbage[i] == Magic0 {
			garbage[i] = Magic0 + 1
		}
	}
	for off := 0; off < len(garbage); {
		n := 1 + rng.Intn(4096)
		if off+n > len(garbage) {
			n = len(garbage) - off
		}
		if got := p.Feed(garbage[off : off+n]); len(got) != 0 {
			t.Fatalf("frames parsed from garbage: %+v", got)
		}
		check()
		off += n
	}
	if p.Buffered() > magicLen-1 {
		t.Fatalf("retained %d bytes of garbage, want <= %d", p.Buffered(), magicLen-1)
	}

	// Feed a max-size valid frame byte by byte; retention peaks at one frame.
	big := bytes.Repeat([]byte{0x42}, testMaxPayload)
	wire := EncodeFrame(3, big)
	var got []Frame
	for _, b := range wire {
		got = append(got, p.Feed([]byte{b})...)
		check()
	}
	if !framesEqual(got, []Frame{{Seq: 3, Payload: big}}) {
		t.Fatalf("got %+v, want max-size frame", got)
	}
	if maxObserved > p.MaxFrameSize() {
		t.Fatalf("peak retention %d exceeds max frame size %d", maxObserved, p.MaxFrameSize())
	}
}

// TestIncompleteFrameWaits: a partial frame is retained (bounded) and
// completed once the rest arrives, even when the length field is valid.
func TestIncompleteFrameWaits(t *testing.T) {
	wire := EncodeFrame(5, []byte("partial-frame"))
	p := NewParser(testMaxPayload)
	if got := p.Feed(wire[:len(wire)-1]); len(got) != 0 {
		t.Fatalf("unexpected frames: %+v", got)
	}
	got := p.Feed(wire[len(wire)-1:])
	want := []Frame{{Seq: 5, Payload: []byte("partial-frame")}}
	if !framesEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}
