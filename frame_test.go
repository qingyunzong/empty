package dataeng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

var testMask = [4]byte{0x11, 0x22, 0x33, 0x44}

// rawClientFrame builds wire bytes independently of the decoder. lengthBytes
// starts with the seven-bit length marker and may include extended length
// bytes. The four mask bytes are inserted after lengthBytes.
func rawClientFrame(first byte, lengthBytes []byte, mask [4]byte, payload []byte) []byte {
	out := make([]byte, 0, 2+len(lengthBytes)+len(mask)+len(payload))
	out = append(out, first)
	out = append(out, 0x80|lengthBytes[0])
	out = append(out, lengthBytes[1:]...)
	out = append(out, mask[:]...)
	for i, value := range payload {
		out = append(out, value^mask[i&3])
	}
	return out
}

func clientFrame(op byte, fin bool, payload []byte, mask [4]byte) []byte {
	first := op
	if fin {
		first |= 0x80
	}
	switch {
	case len(payload) < 126:
		return rawClientFrame(first, []byte{byte(len(payload))}, mask, payload)
	case len(payload) <= 0xffff:
		lengthBytes := []byte{126, 0, 0}
		binary.BigEndian.PutUint16(lengthBytes[1:], uint16(len(payload)))
		return rawClientFrame(first, lengthBytes, mask, payload)
	default:
		lengthBytes := []byte{127, 0, 0, 0, 0, 0, 0, 0, 0}
		binary.BigEndian.PutUint64(lengthBytes[1:], uint64(len(payload)))
		return rawClientFrame(first, lengthBytes, mask, payload)
	}
}

func checkFrames(t *testing.T, got, want []Frame) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d frames, want %d: %#v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].Opcode != want[i].Opcode {
			t.Errorf("frame %d opcode = %d, want %d", i, got[i].Opcode, want[i].Opcode)
		}
		if got[i].Fin != want[i].Fin {
			t.Errorf("frame %d fin = %v, want %v", i, got[i].Fin, want[i].Fin)
		}
		if !bytes.Equal(got[i].Payload, want[i].Payload) {
			t.Errorf("frame %d payload = %v, want %v", i, got[i].Payload, want[i].Payload)
		}
	}
}

func TestClientFramesAreUnmaskedInOrder(t *testing.T) {
	text := []byte("hello")
	binaryPayload := []byte{0x00, 0xff, 0x81, 0x00}
	wire := append(clientFrame(byte(OpText), true, text, testMask),
		clientFrame(byte(OpBinary), true, binaryPayload, testMask)...)

	got, err := NewDecoder(64).Push(wire)
	if err != nil {
		t.Fatal(err)
	}
	checkFrames(t, got, []Frame{
		{Opcode: OpText, Payload: text, Fin: true},
		{Opcode: OpBinary, Payload: binaryPayload, Fin: true},
	})
}

func TestClosePayloadIsMaskedBeforeDecoded(t *testing.T) {
	closePayload := []byte{0x03, 0xe8, 'o', 'k'}
	wire := clientFrame(byte(OpClose), true, closePayload, testMask)

	got, err := NewDecoder(64).Push(wire)
	if err != nil {
		t.Fatal(err)
	}
	checkFrames(t, got, []Frame{{Opcode: OpClose, Payload: closePayload, Fin: true}})
	if got[0].CloseCode() != 1000 {
		t.Fatalf("close code = %d, want 1000", got[0].CloseCode())
	}
	if string(got[0].CloseReason()) != "ok" {
		t.Fatalf("close reason = %q, want ok", got[0].CloseReason())
	}
}

func TestControlFrameLength126IsRejected(t *testing.T) {
	payload := bytes.Repeat([]byte{'x'}, 126)
	wire := rawClientFrame(0x88, []byte{126, 0, 126}, testMask, payload)

	_, err := NewDecoder(256).Push(wire)
	if !errors.Is(err, ErrControlTooLong) {
		t.Fatalf("error = %v, want ErrControlTooLong", err)
	}
}

func TestContinuationAfterCloseFailsAndKeepsCloseFrame(t *testing.T) {
	closePayload := []byte{0x03, 0xe8}
	closeWire := clientFrame(byte(OpClose), true, closePayload, testMask)
	continuationWire := clientFrame(byte(OpContinuation), true, []byte("late"), testMask)
	wire := append(closeWire, continuationWire...)

	decoder := NewDecoder(64)
	got, err := decoder.Push(wire)
	if !errors.Is(err, ErrUnexpectedContinuation) {
		t.Fatalf("error = %v, want ErrUnexpectedContinuation", err)
	}
	checkFrames(t, got, []Frame{{Opcode: OpClose, Payload: closePayload, Fin: true}})

	if _, nextErr := decoder.Push([]byte("x")); !errors.Is(nextErr, ErrUnexpectedContinuation) {
		t.Fatalf("next push error = %v, want sticky ErrUnexpectedContinuation", nextErr)
	}
}

func TestLength126Below126IsRejected(t *testing.T) {
	payload := bytes.Repeat([]byte{'a'}, 125)
	wire := rawClientFrame(0x81, []byte{126, 0, 125}, testMask, payload)

	_, err := NewDecoder(256).Push(wire)
	if !errors.Is(err, ErrNonCanonicalLength126) {
		t.Fatalf("error = %v, want ErrNonCanonicalLength126", err)
	}
}

func TestPayloadLimitCheckedBeforePayloadArrives(t *testing.T) {
	wire := clientFrame(byte(OpText), true, []byte("abc"), testMask)
	// Keep only the two header bytes; the declared length is already known.
	_, err := NewDecoder(2).Push(wire[:2])
	if !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("error = %v, want ErrPayloadTooLarge", err)
	}
}

func TestPushCanEndMidFrame(t *testing.T) {
	payload := []byte("partial")
	wire := clientFrame(byte(OpText), true, payload, testMask)

	for split := 1; split < len(wire); split++ {
		decoder := NewDecoder(64)
		got, err := decoder.Push(wire[:split])
		if err != nil {
			t.Fatalf("split %d first push: %v", split, err)
		}
		if len(got) != 0 {
			t.Fatalf("split %d delivered a partial frame: %#v", split, got)
		}
		got, err = decoder.Push(wire[split:])
		if err != nil {
			t.Fatalf("split %d second push: %v", split, err)
		}
		checkFrames(t, got, []Frame{{Opcode: OpText, Payload: payload, Fin: true}})
	}
}

func TestFinishRejectsPartialFrameAndMessage(t *testing.T) {
	decoder := NewDecoder(64)
	if _, err := decoder.Push([]byte{0x81}); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Finish(); !errors.Is(err, ErrIncompleteFrame) {
		t.Fatalf("error = %v, want ErrIncompleteFrame", err)
	}

	decoder = NewDecoder(64)
	if _, err := decoder.Push(clientFrame(byte(OpText), false, []byte("open"), testMask)); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Finish(); !errors.Is(err, ErrIncompleteMessage) {
		t.Fatalf("error = %v, want ErrIncompleteMessage", err)
	}
}

func TestControlFramesMayInterleaveMessages(t *testing.T) {
	first := clientFrame(byte(OpText), false, []byte("a"), testMask)
	ping := clientFrame(byte(OpPing), true, []byte("p"), testMask)
	last := clientFrame(byte(OpContinuation), true, []byte("b"), testMask)

	got, err := NewDecoder(64).Push(append(append(first, ping...), last...))
	if err != nil {
		t.Fatal(err)
	}
	checkFrames(t, got, []Frame{
		{Opcode: OpText, Payload: []byte("a"), Fin: false},
		{Opcode: OpPing, Payload: []byte("p"), Fin: true},
		{Opcode: OpContinuation, Payload: []byte("b"), Fin: true},
	})
}

func TestTextUTF8ValidationSpansFragments(t *testing.T) {
	// The three bytes of the euro sign are split between two data frames.
	first := clientFrame(byte(OpText), false, []byte{0xe2}, testMask)
	last := clientFrame(byte(OpContinuation), true, []byte{0x82, 0xac}, testMask)

	got, err := NewDecoder(64).Push(append(first, last...))
	if err != nil {
		t.Fatal(err)
	}
	checkFrames(t, got, []Frame{
		{Opcode: OpText, Payload: []byte{0xe2}, Fin: false},
		{Opcode: OpContinuation, Payload: []byte{0x82, 0xac}, Fin: true},
	})
}

func TestInvalidUTF8AcrossMessageFramesFails(t *testing.T) {
	first := clientFrame(byte(OpText), false, []byte{0xe2}, testMask)
	last := clientFrame(byte(OpContinuation), true, []byte{'x'}, testMask)

	got, err := NewDecoder(64).Push(append(first, last...))
	if !errors.Is(err, ErrInvalidUTF8) {
		t.Fatalf("error = %v, want ErrInvalidUTF8", err)
	}
	checkFrames(t, got, []Frame{{Opcode: OpText, Payload: []byte{0xe2}, Fin: false}})
}

func TestProtocolViolations(t *testing.T) {
	tests := []struct {
		name string
		wire []byte
		want error
	}{
		{
			name: "reserved bit",
			wire: []byte{0xc1, 0x80, 0, 0, 0, 0},
			want: ErrReservedBits,
		},
		{
			name: "bad opcode",
			wire: []byte{0x83, 0x80, 0, 0, 0, 0},
			want: ErrBadOpcode,
		},
		{
			name: "unmasked client frame",
			wire: []byte{0x81, 0x00},
			want: ErrMaskRequired,
		},
		{
			name: "fragmented ping",
			wire: []byte{0x09, 0x80, 0, 0, 0, 0},
			want: ErrControlFin,
		},
		{
			name: "close payload length one",
			wire: clientFrame(byte(OpClose), true, []byte{0x03}, testMask),
			want: ErrShortClosePayload,
		},
		{
			name: "close reason invalid UTF-8",
			wire: clientFrame(byte(OpClose), true, []byte{0x03, 0xe8, 0xff}, testMask),
			want: ErrInvalidUTF8,
		},
		{
			name: "extended length 127 high bit",
			wire: []byte{0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0},
			want: ErrExtendedLengthMSB,
		},
		{
			name: "extended length 127 below 65536",
			wire: []byte{0x81, 0xff, 0, 0, 0, 0, 0, 0, 0xff, 0xff},
			want: ErrNonCanonicalLength127,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewDecoder(1 << 20).Push(test.wire); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestExtendedLengths(t *testing.T) {
	payload126 := bytes.Repeat([]byte{'a'}, 126)
	wire126 := clientFrame(byte(OpBinary), true, payload126, testMask)
	got, err := NewDecoder(126).Push(wire126)
	if err != nil {
		t.Fatal(err)
	}
	checkFrames(t, got, []Frame{{Opcode: OpBinary, Payload: payload126, Fin: true}})

	payload65536 := bytes.Repeat([]byte{'b'}, 65536)
	wire65536 := clientFrame(byte(OpBinary), true, payload65536, testMask)
	got, err = NewDecoder(65536).Push(wire65536)
	if err != nil {
		t.Fatal(err)
	}
	checkFrames(t, got, []Frame{{Opcode: OpBinary, Payload: payload65536, Fin: true}})
}

func TestHugeDeclaredLengthWaitsWithoutAllocating(t *testing.T) {
	maxInt := int(^uint(0) >> 1)
	// A valid 127-form length of MaxInt is accepted by the host limit, but only
	// the header and mask arrive. The decoder must wait, not size a payload.
	extended := []byte{0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	wire := append([]byte{0x81, 0xff}, extended...)
	wire = append(wire, testMask[:]...)

	decoder := NewDecoder(maxInt)
	got, err := decoder.Push(wire)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("delivered frames without a payload: %#v", got)
	}
	if err := decoder.Finish(); !errors.Is(err, ErrIncompleteFrame) {
		t.Fatalf("finish error = %v, want ErrIncompleteFrame", err)
	}
}

func TestErrorIsSticky(t *testing.T) {
	decoder := NewDecoder(64)
	wire := []byte{0x81, 0x00}
	if _, err := decoder.Push(wire); !errors.Is(err, ErrMaskRequired) {
		t.Fatalf("error = %v, want ErrMaskRequired", err)
	}
	if _, err := decoder.Push(clientFrame(byte(OpText), true, []byte("ok"), testMask)); !errors.Is(err, ErrMaskRequired) {
		t.Fatalf("second push error = %v, want sticky ErrMaskRequired", err)
	}
	if err := decoder.Finish(); !errors.Is(err, ErrMaskRequired) {
		t.Fatalf("finish error = %v, want sticky ErrMaskRequired", err)
	}
}

func TestFinishAfterCleanStream(t *testing.T) {
	decoder := NewDecoder(64)
	if _, err := decoder.Push(clientFrame(byte(OpText), true, []byte("ok"), testMask)); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Finish(); err != nil {
		t.Fatalf("first finish: %v", err)
	}
	if err := decoder.Finish(); err != nil {
		t.Fatalf("second finish: %v", err)
	}
	if _, err := decoder.Push(nil); !errors.Is(err, ErrFinished) {
		t.Fatalf("push after finish error = %v, want ErrFinished", err)
	}
}
