package q225

import (
	"bytes"
	"errors"
	"testing"
)

func clHeader(v string) Header {
	return Header{canonicalKey("Content-Length"): {v}}
}

func teHeader(v string) Header {
	return Header{canonicalKey("Transfer-Encoding"): {v}}
}

// feedAll drives all currently available wire bytes through the decoder.
func feedAll(d *Decoder, wire []byte) (string, int64, bool, error) {
	var payload bytes.Buffer
	var consumed int64
	for {
		if consumed >= int64(len(wire)) {
			return payload.String(), consumed, false, nil
		}
		out, n, done, err := d.Feed(wire[consumed:])
		payload.Write(out)
		consumed += int64(n)
		if err != nil {
			return payload.String(), consumed, false, err
		}
		if done {
			return payload.String(), consumed, true, nil
		}
		if n == 0 {
			return payload.String(), consumed, false, nil
		}
	}
}

// feedAllBytewise drives wire through the decoder one byte at a time,
// mirroring a handler that applies strict backpressure.
func feedAllBytewise(t *testing.T, d *Decoder, wire []byte) ([]byte, int64, bool, error) {
	t.Helper()
	var payload bytes.Buffer
	var consumed int64
	var done bool
	for consumed < int64(len(wire)) {
		out, n, callDone, err := d.Feed(wire[consumed : consumed+1])
		payload.Write(out)
		if n == 0 {
			// A dangling CR or partial line needs another byte before
			// any progress is possible; feed it together with the next.
			if consumed+1 >= int64(len(wire)) {
				return payload.Bytes(), consumed, false, nil
			}
			out, n, callDone, err = d.Feed(wire[consumed : consumed+2])
			payload.Write(out)
		}
		consumed += int64(n)
		if err != nil {
			return payload.Bytes(), consumed, false, err
		}
		if callDone {
			done = true
			break
		}
	}
	return payload.Bytes(), consumed, done, nil
}

// feedSplits verifies that every split point of the input produces an
// identical parse, so partial feeds behave like one big feed.
func feedSplits(t *testing.T, framing Header, wire []byte) {
	t.Helper()
	reference, refConsumed, refDone, refErr := feedAll(mustDecoder(t, framing), cloneWire(wire))
	for split := 0; split <= len(wire); split++ {
		d := mustDecoder(t, framing)
		var got bytes.Buffer
		var consumed int64
		var done bool
		out, n, callDone, err := d.Feed(wire[:split])
		got.Write(out)
		consumed += int64(n)
		done = callDone
		if err != nil && !errors.Is(err, refErr) {
			t.Fatalf("split=%d first err=%v want %v", split, err, refErr)
		}
		out, n, callDone, err = d.Feed(wire[consumed:])
		got.Write(out)
		consumed += int64(n)
		done = done || callDone
		if err != nil && !errors.Is(err, refErr) {
			t.Fatalf("split=%d second err=%v want %v", split, err, refErr)
		}
		if refErr != nil {
			continue
		}
		if got.String() != reference {
			t.Fatalf("split=%d payload %q want %q", split, got.String(), reference)
		}
		if consumed != refConsumed || done != refDone {
			t.Fatalf("split=%d consumed=%d done=%v want %d/%v",
				split, consumed, done, refConsumed, refDone)
		}
	}
}

func mustDecoder(t *testing.T, header Header) *Decoder {
	t.Helper()
	d, err := NewDecoder(header, DefaultLimits)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	return d
}

func cloneWire(wire []byte) []byte {
	out := make([]byte, len(wire))
	copy(out, wire)
	return out
}
