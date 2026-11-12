package dataeng_test

import (
	"bytes"
	"reflect"
	"testing"

	"example.org/dataeng/q0330"
)

// builder assembles raw DNS wire bytes. It deliberately lives in the test
// package so test messages never come from the package under test.
type builder struct {
	buf []byte
}

func (w *builder) put(v ...byte) {
	w.buf = append(w.buf, v...)
}

func (w *builder) u16(v uint16) {
	w.buf = append(w.buf, byte(v>>8), byte(v))
}

func (w *builder) u32(v uint32) {
	w.buf = append(w.buf, byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
}

func (w *builder) name(labels ...string) {
	for _, label := range labels {
		w.put(byte(len(label)))
		w.put([]byte(label)...)
	}
	w.put(0)
}

func (w *builder) pointer(off int) {
	if off > 0x3fff {
		panic("pointer offset too large")
	}
	w.put(0xc0|byte(off>>8), byte(off))
}

func header(id, flags, qd, an, ns, ar uint16) []byte {
	w := &builder{}
	w.u16(id)
	w.u16(flags)
	w.u16(qd)
	w.u16(an)
	w.u16(ns)
	w.u16(ar)
	return w.buf
}

func mustPush(t *testing.T, d *dataeng.Decoder, chunk []byte, want int) []dataeng.Message {
	t.Helper()
	msgs, err := d.Push(chunk)
	if err != nil {
		t.Fatalf("Push returned error: %v", err)
	}
	if len(msgs) != want {
		t.Fatalf("Push delivered %d messages, want %d", len(msgs), want)
	}
	return msgs
}

// validMessage builds a multi-section response used by several tests:
// question example.com/A/IN; A, AAAA and CNAME answers; NS authority with a
// compressed raw rdata; OPT additional record carrying the root name.
func validMessage() []byte {
	w := &builder{}
	w.put(header(0x1234, 0x8180, 1, 3, 1, 1)...)
	w.name("example", "com") // question name, label start at offset 12
	w.u16(1)                 // type A
	w.u16(1)                 // class IN

	// Answer 1: A record via compressed name.
	w.pointer(12)
	w.u16(1)
	w.u16(1)
	w.u32(300)
	w.u16(4)
	w.put(1, 2, 3, 4)

	// Answer 2: AAAA record via compressed name.
	w.pointer(12)
	w.u16(28)
	w.u16(1)
	w.u32(60)
	w.u16(16)
	w.put(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)

	// Answer 3: CNAME whose rdata stays untouched raw bytes.
	w.pointer(12)
	w.u16(5)
	w.u16(1)
	w.u32(600)
	cname := &builder{}
	cname.name("www", "example", "com")
	w.u16(uint16(len(cname.buf)))
	w.put(cname.buf...)

	// Authority: NS record whose rdata is itself a compression pointer.
	w.pointer(12)
	w.u16(2)
	w.u16(1)
	w.u32(3600)
	w.u16(2)
	w.pointer(12)

	// Additional: OPT record with root name.
	w.put(0)
	w.u16(41)
	w.u16(4096)
	w.u32(0)
	w.u16(0)
	return w.buf
}

func expectedValidMessage() dataeng.Message {
	return dataeng.Message{
		Header: dataeng.Header{
			ID: 0x1234, Flags: 0x8180,
			QDCount: 1, ANCount: 3, NSCount: 1, ARCount: 1,
		},
		Questions: []dataeng.Question{
			{Name: "example.com", Type: 1, Class: 1},
		},
		Answers: []dataeng.Record{
			{
				Name: "example.com", Type: 1, Class: 1, TTL: 300,
				Rdata: []byte{1, 2, 3, 4},
			},
			{
				Name: "example.com", Type: 28, Class: 1, TTL: 60,
				Rdata: []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
			},
			{
				Name: "example.com", Type: 5, Class: 1, TTL: 600,
				Rdata: []byte{
					3, 'w', 'w', 'w',
					7, 'e', 'x', 'a', 'm', 'p', 'l', 'e',
					3, 'c', 'o', 'm',
					0,
				},
			},
		},
		Authority: []dataeng.Record{
			{
				Name: "example.com", Type: 2, Class: 1, TTL: 3600,
				Rdata: []byte{0xc0, 0x0c},
			},
		},
		Additional: []dataeng.Record{
			{Name: "", Type: 41, Class: 4096, TTL: 0},
		},
	}
}

func TestFullMessage(t *testing.T) {
	d := dataeng.NewDecoder(dataeng.Options{})
	msgs := mustPush(t, d, validMessage(), 1)
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish after complete message: %v", err)
	}
	if !reflect.DeepEqual(msgs[0], expectedValidMessage()) {
		t.Fatalf("parsed message mismatch\n got: %+v\nwant: %+v", msgs[0], expectedValidMessage())
	}
}

func TestMXExchange(t *testing.T) {
	w := &builder{}
	w.put(header(0x0001, 0x8000, 1, 1, 0, 0)...)
	w.name("example", "com") // label start at offset 12
	w.u16(15)
	w.u16(1)

	// MX record with a root owner name and a compressed exchange name.
	w.put(0)
	w.u16(15)
	w.u16(1)
	w.u32(100)
	exch := &builder{}
	exch.put(4)
	exch.put([]byte("mail")...)
	exch.pointer(12)
	w.u16(uint16(2 + len(exch.buf)))
	w.u16(10)
	w.put(exch.buf...)

	d := dataeng.NewDecoder(dataeng.Options{})
	msgs := mustPush(t, d, w.buf, 1)
	rec := msgs[0].Answers[0]
	if rec.Name != "" {
		t.Fatalf("owner name = %q, want root empty string", rec.Name)
	}
	if rec.Preference != 10 {
		t.Fatalf("preference = %d, want 10", rec.Preference)
	}
	if rec.Exchange != "mail.example.com" {
		t.Fatalf("exchange = %q, want mail.example.com", rec.Exchange)
	}
	wantRdata := append([]byte{0, 10}, exch.buf...)
	if !bytes.Equal(rec.Rdata, wantRdata) {
		t.Fatalf("mx rdata not preserved: %v", rec.Rdata)
	}
}

func TestMXMalformed(t *testing.T) {
	// rdlen too short to hold preference plus a name.
	w := &builder{}
	w.put(header(0, 0x8000, 0, 1, 0, 0)...)
	w.put(0)
	w.u16(15)
	w.u16(1)
	w.u32(10)
	w.u16(2)
	w.u16(10)
	assertHardError(t, w.buf, dataeng.ErrRdataLength)

	// Trailing octets inside rdata after the exchange name.
	w = &builder{}
	w.put(header(0, 0x8000, 0, 1, 0, 0)...)
	w.put(0)
	w.u16(15)
	w.u16(1)
	w.u32(10)
	w.u16(5)
	w.u16(10)
	w.put(1, 'a', 0, 0xff)
	assertHardError(t, w.buf, dataeng.ErrMalformed)
}

func TestPointerLoop(t *testing.T) {
	// Name: one label followed by a pointer that targets its own start.
	w := &builder{}
	w.put(header(0, 0x8000, 1, 0, 0, 0)...)
	w.put(1, 'a')
	// Pointer starts at offset 14 and points back to offset 14.
	w.pointer(14)
	w.u16(1)
	w.u16(1)
	assertHardError(t, w.buf, dataeng.ErrPointer)
}

func TestPointerForward(t *testing.T) {
	// First name octet is a pointer to offset 16, which lies beyond it (12).
	w := &builder{}
	w.put(header(0, 0x8000, 1, 0, 0, 0)...)
	w.pointer(16)
	w.u16(1)
	w.u16(1)
	assertHardError(t, w.buf, dataeng.ErrPointer)
}

func TestPointerIntoLabelContent(t *testing.T) {
	w := &builder{}
	w.put(header(0, 0x8000, 2, 0, 0, 0)...)
	// First question: abc.com, label content occupies offsets 13..15 and 17..19.
	w.name("abc", "com")
	w.u16(1)
	w.u16(1)
	// Second question points at offset 13, the middle of a label.
	w.pointer(13)
	w.u16(1)
	w.u16(1)
	assertHardError(t, w.buf, dataeng.ErrPointer)
}

func TestAddressLengthMismatch(t *testing.T) {
	mk := func(typ uint16, rdlen uint16, payload []byte) []byte {
		w := &builder{}
		w.put(header(0, 0x8000, 0, 1, 0, 0)...)
		w.put(0)
		w.u16(typ)
		w.u16(1)
		w.u32(10)
		w.u16(rdlen)
		w.put(payload...)
		return w.buf
	}
	assertHardError(t, mk(1, 3, []byte{1, 2, 3}), dataeng.ErrRdataLength)
	assertHardError(t, mk(28, 15, make([]byte, 15)), dataeng.ErrRdataLength)
}

func TestRootName(t *testing.T) {
	w := &builder{}
	w.put(header(0, 0x8000, 1, 0, 0, 0)...)
	w.put(0)
	w.u16(2)
	w.u16(3)
	d := dataeng.NewDecoder(dataeng.Options{})
	msgs := mustPush(t, d, w.buf, 1)
	if msgs[0].Questions[0].Name != "" {
		t.Fatalf("root name = %q, want empty string", msgs[0].Questions[0].Name)
	}
}

func TestPointerToNameTerminator(t *testing.T) {
	// First question is a root name: its zero octet (offset 12) is a legal
	// pointer target. A later pointer there must reconstruct the root name "".
	w := &builder{}
	w.put(header(0, 0x8000, 2, 0, 0, 0)...)
	w.put(0) // terminator at offset 12
	w.u16(2)
	w.u16(3)
	w.pointer(12)
	w.u16(1)
	w.u16(1)
	d := dataeng.NewDecoder(dataeng.Options{})
	msgs := mustPush(t, d, w.buf, 1)
	if got := msgs[0].Questions[1].Name; got != "" {
		t.Fatalf("pointer to terminator produced %q, want root empty string", got)
	}
}
