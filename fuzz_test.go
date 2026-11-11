package q212

import (
	"bytes"
	"math/rand"
	"testing"
)

// TestRandomReassembly shuffles randomly chopped segments of a known byte
// stream, duplicates some of them, and verifies the delivered output equals
// the original stream once the FIN arrives.
func TestRandomReassembly(t *testing.T) {
	rng := rand.New(rand.NewSource(20261111))
	isn := uint32(0xFFFFFFFF - 123) // force the stream to cross the wrap
	total := 4000
	stream := make([]byte, total)
	for i := range stream {
		stream[i] = byte(i*31 + 7)
	}

	c := NewConn([2]uint32{isn, 1}, &Options{MaxBufferedBytes: 1 << 14, HistoryBytes: 512})

	// Split [0,total) into variable-length segments.
	bounds := []int{0}
	for bounds[len(bounds)-1] < total {
		next := bounds[len(bounds)-1] + 1 + rng.Intn(25)
		if next > total {
			next = total
		}
		bounds = append(bounds, next)
	}
	type seg struct{ lo, hi int }
	segs := make([]seg, 0, len(bounds)-1)
	for i := 0; i+1 < len(bounds); i++ {
		segs = append(segs, seg{bounds[i], bounds[i+1]})
	}
	rng.Shuffle(len(segs), func(i, j int) { segs[i], segs[j] = segs[j], segs[i] })

	got := make([]byte, 0, total)
	finOff := -1
	delivered := 0
	for _, sg := range segs {
		seq := isn + uint32(sg.lo)
		fin := false
		if sg.hi == total && rng.Intn(2) == 0 {
			fin = true
		}
		res, err := c.Push(ClientToServer, seq, stream[sg.lo:sg.hi], fin)
		if err != nil {
			// Backpressure is tolerable: retry after draining the prefix.
			if err != ErrBackpressure {
				t.Fatalf("offset %d: %v", sg.lo, err)
			}
			if res.Consumed {
				t.Fatal("backpressure packet must remain unconsumed")
			}
			// Unblock by feeding the next missing prefix segment.
			repairLo := delivered
			repairHi := repairLo + 1 + rng.Intn(20)
			if repairHi > total {
				repairHi = total
			}
			res = mustPush(t, c, ClientToServer, isn+uint32(repairLo),
				stream[repairLo:repairHi], false)
		}
		got = append(got, res.Delivered...)
		delivered = len(got)

		// Replay a random earlier segment as an identical retransmission.
		if sg.lo > 0 && rng.Intn(3) == 0 {
			lo := rng.Intn(sg.lo)
			hi := lo + 1 + rng.Intn(30)
			if hi > total {
				hi = total
			}
			replay, err := c.Push(ClientToServer, isn+uint32(lo), stream[lo:hi], false)
			if err != nil {
				t.Fatalf("replay [%d,%d): %v", lo, hi, err)
			}
			got = append(got, replay.Delivered...)
			delivered = len(got)
		}

		if fin {
			finOff = sg.hi
		}
		if finOff >= 0 && delivered == total {
			break
		}
	}

	// If the FIN rode along with a data segment, closure happens on full
	// delivery; otherwise send a standalone FIN at the end of stream.
	if !c.Closed(ClientToServer) {
		res := mustPush(t, c, ClientToServer, isn+uint32(total), nil, true)
		got = append(got, res.Delivered...)
		if !res.Closed {
			t.Fatal("FIN with all holes filled must close")
		}
	}

	if !bytes.Equal(got, stream) {
		t.Fatalf("reassembled stream mismatch: got %d bytes, want %d", len(got), total)
	}
	if c.Delivered(ClientToServer) != uint64(total) || c.Buffered(ClientToServer) != 0 {
		t.Fatalf("final state delivered=%d buffered=%d",
			c.Delivered(ClientToServer), c.Buffered(ClientToServer))
	}

	// Everything after closure is a late packet.
	wantErr(t, c, ClientToServer, isn+uint32(total), []byte("x"), false, ErrClosed)
}
