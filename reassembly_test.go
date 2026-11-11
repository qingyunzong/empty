package q212

import (
	"bytes"
	"errors"
	"sync"
	"testing"
)

func mustPush(t *testing.T, c *Conn, dir Direction, seq uint32, payload []byte, fin bool) Result {
	t.Helper()
	res, err := c.Push(dir, seq, payload, fin)
	if err != nil {
		t.Fatalf("Push(seq=%d, len=%d, fin=%v): %v", seq, len(payload), fin, err)
	}
	return res
}

func wantErr(t *testing.T, c *Conn, dir Direction, seq uint32, payload []byte, fin bool, want error) {
	t.Helper()
	res, err := c.Push(dir, seq, payload, fin)
	if !errors.Is(err, want) {
		t.Fatalf("Push(seq=%d): got err %v, want %v", seq, err, want)
	}
	if res.Consumed {
		t.Fatalf("rejected packet must not be consumed: %+v", res)
	}
}

// TestWraparoundReassembly drives a stream whose bytes cross the 2^32
// sequence-number boundary, arriving out of order with a hole.
func TestWraparoundReassembly(t *testing.T) {
	isn := uint32(0xFFFFFFFF - 4)
	c := NewConn([2]uint32{isn, 1000}, nil)

	first := []byte("0123456789")  // offsets 0..9, crossing the wrap
	second := []byte("ABCDEFGHIJ") // offsets 10..19 beyond the wrap

	res := mustPush(t, c, ClientToServer, isn+10, second, false)
	if !res.Consumed || len(res.Delivered) != 0 || c.Buffered(ClientToServer) != 10 {
		t.Fatalf("out-of-order segment: %+v buffered=%d", res, c.Buffered(ClientToServer))
	}

	res = mustPush(t, c, ClientToServer, isn, first, false)
	want := append(append([]byte(nil), first...), second...)
	if !bytes.Equal(res.Delivered, want) {
		t.Fatalf("delivered %q, want %q", res.Delivered, want)
	}
	if c.Delivered(ClientToServer) != 20 {
		t.Fatalf("delivered count = %d, want 20", c.Delivered(ClientToServer))
	}
}

// TestOutOfOrderFIN requires every hole ahead of the FIN to be filled before
// the stream closes.
func TestOutOfOrderFIN(t *testing.T) {
	c := NewConn([2]uint32{100, 200}, nil)

	res := mustPush(t, c, ClientToServer, 110, nil, true) // FIN at offset 10
	if !res.Consumed || res.Closed || c.Closed(ClientToServer) {
		t.Fatalf("FIN with hole must not close: %+v", res)
	}

	res = mustPush(t, c, ClientToServer, 100, []byte("01234"), false)
	if res.Closed || !bytes.Equal(res.Delivered, []byte("01234")) {
		t.Fatalf("prefix delivery: %+v", res)
	}

	res = mustPush(t, c, ClientToServer, 105, []byte("56789"), false)
	if !res.Closed || !c.Closed(ClientToServer) {
		t.Fatalf("stream should close once the FIN hole is filled: %+v", res)
	}
	if !bytes.Equal(res.Delivered, []byte("56789")) {
		t.Fatalf("final delivery %q", res.Delivered)
	}

	// Data and FIN together in one segment: FIN adds a sequence number but
	// never a delivered data byte.
	c2 := NewConn([2]uint32{0, 0}, nil)
	res = mustPush(t, c2, ServerToClient, 0, []byte("abcde"), true)
	if !res.Closed || !bytes.Equal(res.Delivered, []byte("abcde")) {
		t.Fatalf("data+FIN packet: %+v", res)
	}
	if c2.Delivered(ServerToClient) != 5 {
		t.Fatal("FIN must not count as a data byte")
	}
}

// TestPartialRetransmission covers identical retransmits (merged) and
// disagreeing ones (freeze with both packet offsets reported).
func TestPartialRetransmission(t *testing.T) {
	c := NewConn([2]uint32{0, 0}, nil)
	mustPush(t, c, ClientToServer, 0, []byte("0123456789"), false)

	// Identical partial retransmission spanning delivered and new bytes.
	res, err := c.Push(ClientToServer, 5, []byte("56789AB"), false)
	if err != nil || !res.Consumed {
		t.Fatalf("identical partial retransmit: %v %+v", err, res)
	}
	if !bytes.Equal(res.Delivered, []byte("AB")) {
		t.Fatalf("only the fresh suffix delivers: %q", res.Delivered)
	}

	// Identical fully-buffered overlap merges without duplication.
	mustPush(t, c, ClientToServer, 15, []byte("CDEFG"), false) // offsets 12..16
	res, err = c.Push(ClientToServer, 14, []byte("B"), false)  // retransmit offset 11
	if err != nil || len(res.Delivered) != 0 {
		t.Fatalf("buffered duplicate: %v %+v", err, res)
	}

	// Conflicting retransmission of an already delivered byte.
	res, err = c.Push(ClientToServer, 5, []byte("X"), false)
	if !errors.Is(err, ErrFrozen) || res.Consumed {
		t.Fatalf("conflict must freeze and not consume: %v %+v", err, res)
	}
	if !c.Frozen() {
		t.Fatal("connection must report frozen")
	}
	cf := c.Conflict()
	if cf == nil || cf.At != 5 || cf.FirstOff != 0 || cf.SecondOff != 5 ||
		cf.FirstByte != '5' || cf.SecondByte != 'X' {
		t.Fatalf("bad conflict report: %+v", cf)
	}

	// Everything afterwards, even on the other direction, is rejected.
	wantErr(t, c, ServerToClient, 0, []byte("z"), false, ErrFrozen)
}

// TestConflictInPendingHole names both packets for bytes never delivered.
func TestConflictInPendingHole(t *testing.T) {
	c := NewConn([2]uint32{0, 0}, nil)
	mustPush(t, c, ClientToServer, 10, []byte("HELLO"), false) // offsets 10..14
	wantErr(t, c, ClientToServer, 12, []byte("XX"), false, ErrFrozen)
	cf := c.Conflict()
	if cf == nil || cf.At != 12 || cf.FirstOff != 10 || cf.SecondOff != 12 {
		t.Fatalf("bad pending conflict: %+v", cf)
	}
}

// TestLatePacketAfterClose verifies post-FIN packets are rejected unconsumed.
func TestLatePacketAfterClose(t *testing.T) {
	c := NewConn([2]uint32{7, 7}, nil)
	mustPush(t, c, ClientToServer, 7, []byte("abc"), true)

	wantErr(t, c, ClientToServer, 11, []byte("late"), false, ErrClosed)
	wantErr(t, c, ClientToServer, 11, nil, false, ErrClosed)
	// Retransmission extending beyond the FIN sequence number.
	wantErr(t, c, ClientToServer, 9, []byte("bcX"), false, ErrClosed)
	if c.Delivered(ClientToServer) != 3 {
		t.Fatalf("rejected late packet changed state: %d", c.Delivered(ClientToServer))
	}
}

// TestWindowBoundaries pins the strict half-circle window rule, including the
// exact 2^31 boundary and segments straddling it.
func TestWindowBoundaries(t *testing.T) {
	isn := uint32(0xFFFFFFF0)
	c := NewConn([2]uint32{isn, 0}, &Options{MaxBufferedBytes: 64 << 20})

	// The active window spans strictly less than 2^31: an occupied range
	// ending at distance 2^31-1 is acceptable.
	res := mustPush(t, c, ClientToServer, isn+(1<<31)-2, []byte("12"), false)
	if !res.Consumed || c.Buffered(ClientToServer) != 2 {
		t.Fatalf("half-window-minus-one range must buffer: %+v", res)
	}

	// Forward distance exactly 2^31 is outside the window.
	wantErr(t, c, ClientToServer, isn+(1<<31), []byte("x"), false, ErrOutsideWindow)

	// Segment straddling the 2^31 boundary is outside.
	wantErr(t, c, ClientToServer, isn+(1<<31)-2, []byte("1234"), false, ErrOutsideWindow)

	// A segment ending at or before the initial sequence number is stale.
	wantErr(t, c, ClientToServer, isn-1, []byte("z"), false, ErrOutsideWindow)

	// A near-origin duplicate whose range stays inside the half-circle is
	// accepted and merged against the buffered bytes.
	res = mustPush(t, c, ClientToServer, isn+(1<<31)-2, []byte("12"), false)
	if !res.Consumed || c.Buffered(ClientToServer) != 2 {
		t.Fatalf("identical near-window duplicate must merge: %+v buffered=%d",
			res, c.Buffered(ClientToServer))
	}
}

// TestBackpressure enforces the per-connection buffered cap and guarantees the
// rejected packet is neither consumed nor partially stored.
func TestBackpressure(t *testing.T) {
	c := NewConn([2]uint32{0, 0}, &Options{MaxBufferedBytes: 8, HistoryBytes: 64})

	// Hole segment offsets 4..11 buffers 8 bytes, exactly at the cap.
	res := mustPush(t, c, ClientToServer, 4, []byte("456789AB"), false)
	if c.Buffered(ClientToServer) != 8 {
		t.Fatalf("buffered = %d, want 8", c.Buffered(ClientToServer))
	}

	// Another hole segment would exceed the cap: backpressure, no consumption.
	wantErr(t, c, ClientToServer, 20, []byte("xyz"), false, ErrBackpressure)
	if c.Buffered(ClientToServer) != 8 {
		t.Fatalf("backpressure must not change buffer: %d", c.Buffered(ClientToServer))
	}

	// The cap is per connection: the reverse direction is blocked too.
	wantErr(t, c, ServerToClient, 5, []byte("zz"), false, ErrBackpressure)

	// In-order delivery frees capacity; the buffered hole data then delivers.
	res = mustPush(t, c, ClientToServer, 0, []byte("0123"), false)
	if !bytes.Equal(res.Delivered, []byte("0123456789AB")) {
		t.Fatalf("full prefix after unblocking: %q", res.Delivered)
	}
	if c.Buffered(ClientToServer) != 0 {
		t.Fatalf("buffer should drain: %d", c.Buffered(ClientToServer))
	}

	// Reverse direction can buffer again once capacity is free.
	res = mustPush(t, c, ServerToClient, 9, []byte("q"), false)
	if !res.Consumed || c.Buffered(ServerToClient) != 1 {
		t.Fatalf("freed capacity must be reusable: %+v", res)
	}
}

// TestContiguousPrefixOnly makes sure only the prefix is delivered and that
// duplicate overlapping data does not corrupt or duplicate it.
func TestContiguousPrefixOnly(t *testing.T) {
	c := NewConn([2]uint32{0, 0}, nil)

	mustPush(t, c, ClientToServer, 6, []byte("FGHIJ"), false) // offsets 6..10
	mustPush(t, c, ClientToServer, 3, []byte("CDE"), false)   // offsets 3..5

	res := mustPush(t, c, ClientToServer, 0, []byte("012"), false) // offsets 0..2
	if !bytes.Equal(res.Delivered, []byte("012CDEFGHIJ")) {
		t.Fatalf("contiguous delivery %q", res.Delivered)
	}

	// The same byte range again with identical content merges to one copy.
	res, err := c.Push(ClientToServer, 1, []byte("12CDEFGH"), false)
	if err != nil || len(res.Delivered) != 0 {
		t.Fatalf("identical overlap must merge: %v %+v", err, res)
	}
	if c.Delivered(ClientToServer) != 11 {
		t.Fatalf("duplicates must not add bytes: %d", c.Delivered(ClientToServer))
	}
}

// TestFINMismatchFreezes when two FINs claim different sequence numbers.
func TestFINMismatchFreezes(t *testing.T) {
	c := NewConn([2]uint32{0, 0}, nil)
	mustPush(t, c, ClientToServer, 0, nil, true) // FIN at offset 0
	wantErr(t, c, ClientToServer, 1, nil, true, ErrFrozen)
	if !c.Frozen() || c.Conflict() == nil {
		t.Fatal("FIN sequence mismatch must freeze and report a conflict")
	}
}

// TestConcurrentPush drives both directions concurrently and verifies the
// assembled streams afterwards.
func TestConcurrentPush(t *testing.T) {
	c := NewConn([2]uint32{0, 0}, &Options{MaxBufferedBytes: 4096})
	var wg sync.WaitGroup
	for _, dir := range []Direction{ClientToServer, ServerToClient} {
		wg.Add(1)
		go func(dir Direction) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				res, err := c.Push(dir, uint32(i), []byte{byte(i)}, false)
				if err != nil {
					t.Errorf("dir %d offset %d: %v", dir, i, err)
					return
				}
				if len(res.Delivered) != 1 || res.Delivered[0] != byte(i) {
					t.Errorf("dir %d offset %d bad delivery %+v", dir, i, res)
					return
				}
			}
		}(dir)
	}
	wg.Wait()

	for _, dir := range []Direction{ClientToServer, ServerToClient} {
		if c.Delivered(dir) != 200 || c.Buffered(dir) != 0 {
			t.Fatalf("dir %d delivered=%d buffered=%d", dir, c.Delivered(dir), c.Buffered(dir))
		}
	}
}

// TestFINAcrossWraparound closes a stream whose FIN sequence number wraps
// through 2^32, arriving before the final data.
func TestFINAcrossWraparound(t *testing.T) {
	isn := uint32(0xFFFFFFFF - 6)
	c := NewConn([2]uint32{isn, 0}, &Options{HistoryBytes: 128})

	finSeq := isn + 10 // wraps to isn+2
	res := mustPush(t, c, ClientToServer, finSeq, nil, true)
	if res.Closed {
		t.Fatal("FIN with outstanding holes must not close")
	}

	mustPush(t, c, ClientToServer, isn+4, []byte("456789"), false) // offsets 4..9
	if c.Closed(ClientToServer) {
		t.Fatal("hole before FIN still open")
	}

	res = mustPush(t, c, ClientToServer, isn, []byte("0123"), false)
	if !res.Closed || !bytes.Equal(res.Delivered, []byte("0123456789")) {
		t.Fatalf("wrapped FIN closure: closed=%v delivered=%q", res.Closed, res.Delivered)
	}

	wantErr(t, c, ClientToServer, finSeq+1, nil, false, ErrClosed)
}

func TestUnknownDirection(t *testing.T) {
	c := NewConn([2]uint32{0, 0}, nil)
	if _, err := c.Push(Direction(9), 0, []byte("x"), false); err == nil {
		t.Fatal("unknown direction must return an error")
	}
}
