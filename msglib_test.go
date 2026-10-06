package msglib

import (
	"bytes"
	"errors"
	"fmt"
	"testing"
)

var testSchema = NewSchema(
	FieldSpec{Tag: 1, Kind: Scalar},
	FieldSpec{Tag: 2, Kind: List},
	FieldSpec{Tag: 5, Kind: Scalar},
)

func build(fields ...struct {
	tag     uint64
	payload string
}) []byte {
	var out []byte
	for _, f := range fields {
		out = AppendField(out, f.tag, []byte(f.payload))
	}
	return out
}

func f(tag uint64, payload string) struct {
	tag     uint64
	payload string
} {
	return struct {
		tag     uint64
		payload string
	}{tag, payload}
}

func TestRepeatedScalarLastWins(t *testing.T) {
	data := build(f(1, "first"), f(1, "second"), f(1, "last"))
	m, err := Parse(data, testSchema)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	got, ok := m.Scalar(1)
	if !ok || string(got) != "last" {
		t.Fatalf("Scalar(1) = %q, %v; want %q, true", got, ok, "last")
	}
}

func TestRepeatedListConcatenates(t *testing.T) {
	data := build(f(2, "a"), f(1, "x"), f(2, "b"), f(2, "c"))
	m, err := Parse(data, testSchema)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	var got []string
	for _, item := range m.List(2) {
		got = append(got, string(item))
	}
	want := []string{"a", "b", "c"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("List(2) = %v; want %v", got, want)
	}
}

func TestUnknownTagsPreservedInRelativeOrder(t *testing.T) {
	data := build(f(1, "s"), f(7, "u1"), f(2, "l"), f(9, "u2"), f(7, "u3"))
	m, err := Parse(data, testSchema)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	unk := m.UnknownFields()
	if len(unk) != 3 {
		t.Fatalf("got %d unknown fields; want 3", len(unk))
	}
	want := build(f(7, "u1"), f(9, "u2"), f(7, "u3"))
	if !bytes.Equal(bytes.Join(unk, nil), want) {
		t.Fatalf("unknown fields = %x; want %x", bytes.Join(unk, nil), want)
	}
}

func TestCanonicalEncodeOrdersKnownTagsAndKeepsUnknown(t *testing.T) {
	// Known tags arrive out of order, interleaved with unknown tags.
	data := build(f(5, "five"), f(9, "u1"), f(2, "b"), f(1, "one"), f(2, "a"), f(7, "u2"))
	m, err := Parse(data, testSchema)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	want := build(f(1, "one"), f(2, "b"), f(2, "a"), f(5, "five"), f(9, "u1"), f(7, "u2"))
	if got := m.Encode(); !bytes.Equal(got, want) {
		t.Fatalf("Encode = %x; want %x", got, want)
	}
}

func TestCanonicalEncodeIsIdempotent(t *testing.T) {
	data := build(f(9, "u"), f(2, "x"), f(1, "s"), f(2, "y"))
	m1, err := Parse(data, testSchema)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	m2, err := Parse(m1.Encode(), testSchema)
	if err != nil {
		t.Fatalf("re-Parse: %v", err)
	}
	if !bytes.Equal(m1.Encode(), m2.Encode()) {
		t.Fatalf("not idempotent: %x != %x", m1.Encode(), m2.Encode())
	}
}

func TestLengthOutOfBoundsRejectsWholePacket(t *testing.T) {
	good := build(f(1, "ok"))
	// Append a field claiming 100 payload bytes with only 2 present.
	bad := append(append([]byte{}, good...), AppendField(nil, 5, []byte("ab"))...)
	bad[len(good)+1] = 100 // patch length varint
	if _, err := Parse(bad, testSchema); !errors.Is(err, ErrTruncated) {
		t.Fatalf("Parse err = %v; want ErrTruncated", err)
	}
	// Truncated mid-payload and mid-varint are also rejected.
	if _, err := Parse(good[:len(good)-1], testSchema); !errors.Is(err, ErrTruncated) {
		t.Fatalf("truncated payload err = %v; want ErrTruncated", err)
	}
	if _, err := Parse([]byte{0x80}, testSchema); !errors.Is(err, ErrTruncated) {
		t.Fatalf("truncated varint err = %v; want ErrTruncated", err)
	}
}

func TestUnknownFieldRoundTrip(t *testing.T) {
	schema := NewSchema() // every tag is unknown
	data := build(f(3, "x"), f(100, "yy"), f(3, "z"))
	m, err := Parse(data, schema)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got := m.Encode(); !bytes.Equal(got, data) {
		t.Fatalf("round trip = %x; want %x", got, data)
	}
}

func TestDecoderChunkedFeed(t *testing.T) {
	mk := func() *Message {
		m := newMessage(testSchema)
		m.SetScalar(1, []byte("hello"))
		m.Append(2, []byte("a"))
		m.Append(2, []byte("b"))
		return m
	}
	p1 := EncodePacket(mk())
	// Second packet carries an unknown field.
	raw := newMessage(testSchema)
	raw.SetScalar(5, []byte("v"))
	raw.unknown = append(raw.unknown, AppendField(nil, 42, []byte("u")))
	p2 := EncodePacket(raw)
	stream := append(append([]byte{}, p1...), p2...)

	// Feed the stream in every chunk size from 1 up to the full length.
	for size := 1; size <= len(stream); size++ {
		d := NewDecoder(testSchema)
		var got []*Message
		for i := 0; i < len(stream); i += size {
			end := i + size
			if end > len(stream) {
				end = len(stream)
			}
			msgs, err := d.Feed(stream[i:end])
			if err != nil {
				t.Fatalf("chunk size %d: Feed: %v", size, err)
			}
			got = append(got, msgs...)
		}
		if len(got) != 2 {
			t.Fatalf("chunk size %d: got %d messages; want 2", size, len(got))
		}
		if !bytes.Equal(got[0].Encode(), mk().Encode()) {
			t.Fatalf("chunk size %d: packet 1 = %x", size, got[0].Encode())
		}
		if !bytes.Equal(got[1].Encode(), raw.Encode()) {
			t.Fatalf("chunk size %d: packet 2 = %x", size, got[1].Encode())
		}
	}
}

func TestDecoderRejectsBadPacketWhole(t *testing.T) {
	body := build(f(1, "ok"))
	body[1] = 10 // declared length 10 overruns the 2 payload bytes
	pkt := append([]byte{byte(len(body))}, body...)
	d := NewDecoder(testSchema)
	if _, err := d.Feed(pkt); !errors.Is(err, ErrTruncated) {
		t.Fatalf("Feed err = %v; want ErrTruncated", err)
	}
}

func TestDecoderIncompletePacketWaits(t *testing.T) {
	pkt := EncodePacket(func() *Message {
		m := newMessage(testSchema)
		m.SetScalar(1, []byte("data"))
		return m
	}())
	d := NewDecoder(testSchema)
	msgs, err := d.Feed(pkt[:len(pkt)-1])
	if err != nil || len(msgs) != 0 {
		t.Fatalf("partial feed = %v msgs, %v; want 0, nil", len(msgs), err)
	}
	msgs, err = d.Feed(pkt[len(pkt)-1:])
	if err != nil || len(msgs) != 1 {
		t.Fatalf("final feed = %v msgs, %v; want 1, nil", len(msgs), err)
	}
}
