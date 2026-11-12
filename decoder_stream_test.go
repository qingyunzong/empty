package dataeng_test

import (
	"errors"
	"reflect"
	"testing"

	"example.org/dataeng/q0330"
)

// assertHardError pushes raw once and requires the exact sentinel failure,
// then verifies the Decoder stays stopped.
func assertHardError(t *testing.T, raw []byte, want error) {
	t.Helper()
	d := dataeng.NewDecoder(dataeng.Options{})
	msgs, err := d.Push(raw)
	if !errors.Is(err, want) {
		t.Fatalf("Push error = %v, want %v", err, want)
	}
	if len(msgs) != 0 {
		t.Fatalf("failing Push delivered %d messages", len(msgs))
	}
	if _, err := d.Push([]byte{0}); !errors.Is(err, dataeng.ErrStopped) {
		t.Fatalf("Push after failure = %v, want ErrStopped", err)
	}
	if err := d.Finish(); !errors.Is(err, dataeng.ErrStopped) {
		t.Fatalf("Finish after failure = %v, want ErrStopped", err)
	}
}

func TestCountMismatch(t *testing.T) {
	// Declared questions exceed the bytes present: record ends mid-stream, so
	// Push retains the prefix and Finish fails.
	w := &builder{}
	w.put(header(0, 0x8000, 2, 0, 0, 0)...)
	w.put(0) // only one truncated question, no type/class
	d := dataeng.NewDecoder(dataeng.Options{})
	if msgs, err := d.Push(w.buf); err != nil || len(msgs) != 0 {
		t.Fatalf("truncated Push: msgs=%d err=%v", len(msgs), err)
	}
	if err := d.Finish(); !errors.Is(err, dataeng.ErrTruncated) {
		t.Fatalf("Finish = %v, want ErrTruncated", err)
	}

	// Declared sections consumed but bytes remain: hard malformed error.
	w = &builder{}
	w.put(header(0, 0x8000, 1, 0, 0, 0)...)
	w.put(0)
	w.u16(1)
	w.u16(1)
	w.put(0xab, 0xcd)
	assertHardError(t, w.buf, dataeng.ErrMalformed)
}

func TestHeaderSplitAcrossChunks(t *testing.T) {
	raw := validMessage()
	for _, cut := range []int{5, 11} {
		d := dataeng.NewDecoder(dataeng.Options{})
		if msgs, err := d.Push(raw[:cut]); err != nil || len(msgs) != 0 {
			t.Fatalf("cut=%d prefix Push: msgs=%d err=%v", cut, len(msgs), err)
		}
		msgs := mustPush(t, d, raw[cut:], 1)
		if !reflect.DeepEqual(msgs[0], expectedValidMessage()) {
			t.Fatalf("cut=%d parsed message mismatch", cut)
		}
		if err := d.Finish(); err != nil {
			t.Fatalf("cut=%d Finish: %v", cut, err)
		}
	}

	// Byte-at-a-time streaming must produce the same single message.
	d := dataeng.NewDecoder(dataeng.Options{})
	var got *dataeng.Message
	for i, b := range raw {
		msgs, err := d.Push([]byte{b})
		if err != nil {
			t.Fatalf("byte %d Push: %v", i, err)
		}
		switch len(msgs) {
		case 0:
		case 1:
			if got != nil {
				t.Fatalf("byte %d delivered an extra message", i)
			}
			got = &msgs[0]
		default:
			t.Fatalf("byte %d delivered %d messages", i, len(msgs))
		}
	}
	if got == nil {
		t.Fatal("streaming never delivered the message")
	}
	if !reflect.DeepEqual(*got, expectedValidMessage()) {
		t.Fatalf("streaming parsed message mismatch")
	}
}

func TestQRBitRequired(t *testing.T) {
	raw := validMessage()
	// Clear the most significant flag bit; every other bit is unchanged.
	raw[2] &^= 0x80
	assertHardError(t, raw, dataeng.ErrNotResponse)

	// With QR set again the same bytes parse.
	raw[2] |= 0x80
	d := dataeng.NewDecoder(dataeng.Options{})
	mustPush(t, d, raw, 1)
}

func TestLimits(t *testing.T) {
	raw := validMessage()
	d := dataeng.NewDecoder(dataeng.Options{MaxMessage: len(raw) - 1})
	msgs, err := d.Push(raw)
	if !errors.Is(err, dataeng.ErrMessageTooLarge) || len(msgs) != 0 {
		t.Fatalf("MaxMessage: msgs=%d err=%v", len(msgs), err)
	}

	// rdlength 10 exceeds a host limit of 8 on a generic record.
	w := &builder{}
	w.put(header(0, 0x8000, 0, 1, 0, 0)...)
	w.put(0)
	w.u16(99)
	w.u16(1)
	w.u32(10)
	w.u16(10)
	w.put(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
	d2 := dataeng.NewDecoder(dataeng.Options{MaxRdata: 8})
	msgs, err = d2.Push(w.buf)
	if !errors.Is(err, dataeng.ErrRdataTooLarge) || len(msgs) != 0 {
		t.Fatalf("MaxRdata: msgs=%d err=%v", len(msgs), err)
	}
}

func TestReservedLabelPrefix(t *testing.T) {
	mk := func(first byte) []byte {
		w := &builder{}
		w.put(header(0, 0x8000, 1, 0, 0, 0)...)
		w.put(first)
		w.put(0)
		w.u16(1)
		w.u16(1)
		return w.buf
	}
	// Leading bits 01 and 10 are reserved.
	assertHardError(t, mk(0x41), dataeng.ErrMalformed)
	assertHardError(t, mk(0x81), dataeng.ErrMalformed)
}

func TestJumpLimit(t *testing.T) {
	// Build a chain of labels whose offset map each pointer can legally
	// target: qn starts with label "n" then a pointer to q(n-1)'s label start.
	w := &builder{}
	w.put(header(0, 0x8000, 18, 0, 0, 0)...)
	type qOff struct {
		labelStart int
		pointer    int
	}
	offsets := make([]qOff, 18)
	for i := 0; i < 18; i++ {
		offsets[i].labelStart = len(w.buf)
		w.put(1, byte('a'+(i%26)))
		if i == 0 {
			w.put(0) // plain terminated name, a legal target
		} else {
			offsets[i].pointer = len(w.buf)
			w.put(0, 0) // placeholder pointer, fixed below
		}
		w.u16(1)
		w.u16(1)
	}
	for i := 1; i < 18; i++ {
		target := offsets[i-1].labelStart
		w.buf[offsets[i].pointer] = 0xc0 | byte(target>>8)
		w.buf[offsets[i].pointer+1] = byte(target)
	}
	// The last question performs 17 pointer jumps and must be rejected.
	assertHardError(t, w.buf, dataeng.ErrPointer)
}

func TestTwoMessagesOnePush(t *testing.T) {
	first := validMessage()
	raw := make([]byte, 0, 2*len(first))
	raw = append(raw, first...)
	raw = append(raw, validMessage()...)
	d := dataeng.NewDecoder(dataeng.Options{})
	msgs, err := d.Push(raw)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("delivered %d messages, want 2", len(msgs))
	}
	want := expectedValidMessage()
	for i, msg := range msgs {
		if !reflect.DeepEqual(msg, want) {
			t.Fatalf("message %d mismatch", i)
		}
	}
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	// A later failure stops the decoder but the earlier message is delivered.
	bad := validMessage()
	bad[2] &^= 0x80
	combined := make([]byte, 0, len(first)+len(bad))
	combined = append(combined, first...)
	combined = append(combined, bad...)
	d = dataeng.NewDecoder(dataeng.Options{})
	msgs, err = d.Push(combined)
	if !errors.Is(err, dataeng.ErrNotResponse) || len(msgs) != 1 {
		t.Fatalf("failing stream: msgs=%d err=%v", len(msgs), err)
	}
}

func TestNameTooLong(t *testing.T) {
	// Four 63-octet labels need 4*(63+1)+1 = 257 wire octets, over the 255
	// limit, while each individual label keeps a legal 1..63 length.
	w := &builder{}
	w.put(header(0, 0x8000, 1, 0, 0, 0)...)
	for i := 0; i < 4; i++ {
		w.put(63)
		w.put(make([]byte, 63)...)
	}
	w.put(0)
	w.u16(1)
	w.u16(1)
	assertHardError(t, w.buf, dataeng.ErrNameTooLong)
}

func TestFinishEmpty(t *testing.T) {
	d := dataeng.NewDecoder(dataeng.Options{})
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish on empty decoder: %v", err)
	}
	if _, err := d.Push(nil); err != nil {
		t.Fatalf("Push(nil): %v", err)
	}
}

func TestPointerOutOfMessage(t *testing.T) {
	// Pointer target offset lands beyond every byte in this message.
	w := &builder{}
	w.put(header(0, 0x8000, 1, 0, 0, 0)...)
	w.pointer(0x3fff)
	w.u16(1)
	w.u16(1)
	assertHardError(t, w.buf, dataeng.ErrPointer)
}

func TestCrossMessagePointerRejected(t *testing.T) {
	// A second message whose first name points at offset 12 (valid inside its
	// own space but here unregistered, since this message never used it) must
	// fail rather than read the previous message sitting in the shared buffer.
	first := validMessage()
	w := &builder{}
	w.put(header(0, 0x8000, 1, 0, 0, 0)...)
	w.pointer(12)
	w.u16(1)
	w.u16(1)
	combined := make([]byte, 0, len(first)+len(w.buf))
	combined = append(combined, first...)
	combined = append(combined, w.buf...)

	d := dataeng.NewDecoder(dataeng.Options{})
	msgs, err := d.Push(combined)
	if !errors.Is(err, dataeng.ErrPointer) || len(msgs) != 1 {
		t.Fatalf("cross-message pointer: msgs=%d err=%v", len(msgs), err)
	}
}

func TestMXCompressionLoop(t *testing.T) {
	// MX exchange name is a pointer that targets its own rdata start.
	w := &builder{}
	w.put(header(0, 0x8000, 0, 1, 0, 0)...)
	w.put(0)
	w.u16(15)
	w.u16(1)
	w.u32(10)
	w.u16(4)
	w.u16(10)
	exchStart := len(w.buf)
	w.pointer(exchStart)
	assertHardError(t, w.buf, dataeng.ErrPointer)
}

func TestMaxMessageKnownOnAppend(t *testing.T) {
	// Even before a message is parseable, exceeding MaxMessage fails at once
	// instead of growing the retained prefix.
	raw := validMessage()
	d := dataeng.NewDecoder(dataeng.Options{MaxMessage: 4})
	msgs, err := d.Push(raw[:3])
	if err != nil || len(msgs) != 0 {
		t.Fatalf("under limit: msgs=%d err=%v", len(msgs), err)
	}
	msgs, err = d.Push(raw[3:])
	if !errors.Is(err, dataeng.ErrMessageTooLarge) || len(msgs) != 0 {
		t.Fatalf("over limit: msgs=%d err=%v", len(msgs), err)
	}
}

func TestPointerMustEndName(t *testing.T) {
	// After a pointer the parser resumes right after its two octets. If a name
	// placed extra bytes there, every following fixed-width field shifts and the
	// message is rejected rather than silently misaligned.
	w := &builder{}
	w.put(header(0, 0x8000, 2, 0, 0, 0)...)
	w.name("abc") // label start at 12
	w.u16(1)
	w.u16(1)
	// Second name: pointer back to 12, then a stray zero octet.
	w.pointer(12)
	w.put(0)
	w.u16(1)
	w.u16(1)
	assertHardError(t, w.buf, dataeng.ErrMalformed)
}
