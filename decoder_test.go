package dataeng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

// responseEqual compares responses while treating nil and empty byte slices
// as equivalent, since both represent an absent extras/key/value region.
func responseEqual(a, b Response) bool {
	return a.Opcode == b.Opcode &&
		a.KeyLength == b.KeyLength &&
		a.ExtrasLen == b.ExtrasLen &&
		a.Status == b.Status &&
		a.BodyLength == b.BodyLength &&
		a.Opaque == b.Opaque &&
		a.CAS == b.CAS &&
		bytes.Equal(a.Extras, b.Extras) &&
		bytes.Equal(a.Key, b.Key) &&
		bytes.Equal(a.Value, b.Value)
}

// packHeader builds a 24-byte response header independently of the decoder.
func packHeader(opcode byte, keyLen uint16, extrasLen byte, dataType byte,
	status uint16, bodyLen uint32, opaque uint32, cas uint64) []byte {
	hdr := make([]byte, headerSize)
	hdr[0] = magicResponse
	hdr[1] = opcode
	binary.BigEndian.PutUint16(hdr[2:4], keyLen)
	hdr[4] = extrasLen
	hdr[5] = dataType
	binary.BigEndian.PutUint16(hdr[6:8], status)
	binary.BigEndian.PutUint32(hdr[8:12], bodyLen)
	binary.BigEndian.PutUint32(hdr[12:16], opaque)
	binary.BigEndian.PutUint64(hdr[16:24], cas)
	return hdr
}

// packFrame assembles one complete response from independently supplied
// regions; the body length is derived from the regions themselves.
func packFrame(opcode byte, status uint16, opaque uint32, cas uint64,
	extras, key, value []byte) []byte {
	body := bytes.Join([][]byte{extras, key, value}, nil)
	hdr := packHeader(opcode, uint16(len(key)), byte(len(extras)), 0,
		status, uint32(len(body)), opaque, cas)
	return append(hdr, body...)
}

func wantResponse(opcode byte, status uint16, opaque uint32, cas uint64,
	extras, key, value []byte) Response {
	return Response{
		Opcode:     opcode,
		KeyLength:  uint16(len(key)),
		ExtrasLen:  byte(len(extras)),
		Status:     status,
		BodyLength: uint32(len(extras) + len(key) + len(value)),
		Opaque:     opaque,
		CAS:        cas,
		Extras:     extras,
		Key:        key,
		Value:      value,
	}
}

func feedOneByteAtATime(t *testing.T, d *Decoder, frame []byte) []Response {
	t.Helper()
	var got []Response
	for i := range frame {
		rs, err := d.Push(frame[i : i+1])
		if err != nil {
			t.Fatalf("Push byte %d unexpected error: %v", i, err)
		}
		got = append(got, rs...)
	}
	return got
}

// A GetKQ success response carries extras plus a key: the decoder must keep
// the key whole instead of counting its first bytes into the value.
func TestExtrasNonEmptySplitsKeyAndValue(t *testing.T) {
	extras := []byte{0xde, 0xad, 0xbe, 0xef}
	key := []byte("cache-key-42")
	value := []byte("payload")
	frame := packFrame(opcodeGetKQ, 0, 0x01020304, 99, extras, key, value)

	d := NewDecoder(1 << 20)
	got := feedOneByteAtATime(t, d, frame)
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d responses, want 1", len(got))
	}
	want := wantResponse(opcodeGetKQ, 0, 0x01020304, 99, extras, key, value)
	if !responseEqual(got[0], want) {
		t.Fatalf("response mismatch\ngot:  %+v\nwant: %+v", got[0], want)
	}
}

func TestKeyLengthEqualsBodyLength(t *testing.T) {
	key := []byte("only-a-key")
	frame := packFrame(opcodeSet, 0, 7, 0, nil, key, nil)

	d := NewDecoder(1 << 20)
	got, err := d.Push(frame)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	want := wantResponse(opcodeSet, 0, 7, 0, nil, key, []byte{})
	if len(got) != 1 || !responseEqual(got[0], want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if len(got[0].Value) != 0 || len(got[0].Extras) != 0 {
		t.Fatalf("expected empty extras and value, got extras=%q value=%q",
			got[0].Extras, got[0].Value)
	}
}

func TestNonZeroStatusIsNotFrameError(t *testing.T) {
	msg := []byte("not found")
	frame := packFrame(opcodeGet, 0x0001, 0xAABBCCDD, 1234, nil, nil, msg)

	d := NewDecoder(1 << 20)
	got, err := d.Push(frame)
	if err != nil {
		t.Fatalf("non-zero status must not be a frame error, got %v", err)
	}
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	want := wantResponse(opcodeGet, 0x0001, 0xAABBCCDD, 1234, nil, []byte{}, msg)
	if len(got) != 1 || !responseEqual(got[0], want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestNonZeroStatusGetKQRequiresZeroExtrasAndKey(t *testing.T) {
	frame := packHeader(opcodeGetKQ, 3, 0, 0, 0x0086, 3, 1, 0)

	d := NewDecoder(1 << 20)
	if _, err := d.Push(frame); !errors.Is(err, ErrBadKeyLength) {
		t.Fatalf("got %v, want ErrBadKeyLength", err)
	}
}

func TestBadMagic0x80(t *testing.T) {
	frame := packHeader(opcodeGet, 0, 4, 0, 0, 4, 0, 0)
	frame[0] = 0x80

	d := NewDecoder(1 << 20)
	if _, err := d.Push(frame); !errors.Is(err, ErrBadMagic) {
		t.Fatalf("got %v, want ErrBadMagic", err)
	}
	if err := d.Finish(); !errors.Is(err, ErrBadMagic) {
		t.Fatalf("Finish after failure: got %v, want ErrBadMagic", err)
	}
}

func TestHeaderSplitAcrossPushes(t *testing.T) {
	extras := []byte{1, 2, 3, 4}
	value := []byte("v")
	frame := packFrame(opcodeGet, 0, 55, 0, extras, nil, value)

	for _, cut := range []int{1, 4, 8, 11, 12, 13, 23, 24} {
		d := NewDecoder(1 << 20)
		var got []Response

		rs, err := d.Push(frame[:cut])
		if err != nil {
			t.Fatalf("cut=%d first Push: %v", cut, err)
		}
		got = append(got, rs...)
		rs, err = d.Push(frame[cut:])
		if err != nil {
			t.Fatalf("cut=%d second Push: %v", cut, err)
		}
		got = append(got, rs...)

		if err := d.Finish(); err != nil {
			t.Fatalf("cut=%d Finish: %v", cut, err)
		}
		want := wantResponse(opcodeGet, 0, 55, 0, extras, []byte{}, value)
		if len(got) != 1 || !responseEqual(got[0], want) {
			t.Fatalf("cut=%d got %+v, want %+v", cut, got, want)
		}
	}
}

func TestPushStopsInMiddleOfBody(t *testing.T) {
	extras := []byte{1, 2, 3, 4}
	value := bytes.Repeat([]byte{'z'}, 20)
	frame := packFrame(opcodeGet, 0, 0, 0, extras, nil, value)

	d := NewDecoder(1 << 20)
	if got, err := d.Push(frame[:headerSize+3]); err != nil || len(got) != 0 {
		t.Fatalf("partial body: got=%d err=%v", len(got), err)
	}
	if err := d.Finish(); !errors.Is(err, ErrTruncated) {
		t.Fatalf("Finish mid-body: got %v, want ErrTruncated", err)
	}

	d = NewDecoder(1 << 20)
	if got, err := d.Push(frame[:headerSize+3]); err != nil || len(got) != 0 {
		t.Fatalf("partial body: got=%d err=%v", len(got), err)
	}
	rest, err := d.Push(frame[headerSize+3:])
	if err != nil {
		t.Fatalf("completing body: %v", err)
	}
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	want := wantResponse(opcodeGet, 0, 0, 0, extras, []byte{}, value)
	if len(rest) != 1 || !responseEqual(rest[0], want) {
		t.Fatalf("got %+v, want %+v", rest, want)
	}
}

func TestBodyLengthExceedingMaxBodyRejectedEarly(t *testing.T) {
	hdr := packHeader(opcodeGet, 0, 4, 0, 0, 5000, 0, 0)

	d := NewDecoder(1000)
	// Only the first twelve bytes are supplied, yet the declared length is
	// already readable, so the rejection happens before buffering the body.
	if _, err := d.Push(hdr[:12]); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("got %v, want ErrBodyTooLarge", err)
	}
	if _, err := d.Push(hdr); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("stopped decoder: got %v, want ErrBodyTooLarge", err)
	}

	// A body of exactly maxBody is still accepted.
	frame := packFrame(opcodeGet, 0, 0, 0, []byte{1, 2, 3, 4}, nil, nil)
	d = NewDecoder(4)
	got, err := d.Push(frame)
	if err != nil {
		t.Fatalf("body equal to maxBody: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d responses, want 1", len(got))
	}
}

func TestFailureStopsDecoderAndKeepsDeliveredResponses(t *testing.T) {
	good := packFrame(opcodeDelete, 0, 1, 0, nil, nil, nil)
	bad := packHeader(0x77, 0, 0, 0, 0, 0, 0, 0)

	d := NewDecoder(1 << 20)
	got, err := d.Push(good)
	if err != nil || len(got) != 1 {
		t.Fatalf("good frame: got=%d err=%v", len(got), err)
	}
	want := wantResponse(opcodeDelete, 0, 1, 0, nil, []byte{}, []byte{})
	if !responseEqual(got[0], want) {
		t.Fatalf("delivered response mismatch: %+v", got[0])
	}

	if got, err := d.Push(bad); !errors.Is(err, ErrBadOpcode) || len(got) != 0 {
		t.Fatalf("bad frame: got=%d err=%v", len(got), err)
	}
	// The stopped decoder never recovers, even on good input.
	if _, err := d.Push(good); !errors.Is(err, ErrBadOpcode) {
		t.Fatalf("Push after stop: got %v, want ErrBadOpcode", err)
	}
	if !errors.Is(d.Stopped(), ErrStopped) ||
		!errors.Is(d.Stopped(), ErrBadOpcode) {
		t.Fatalf("Stopped: got %v, want ErrStopped wrapping ErrBadOpcode", d.Stopped())
	}
	var se stoppedError
	if !errors.As(d.Stopped(), &se) {
		t.Fatalf("stopped error is not a stoppedError: %v", d.Stopped())
	}
	if se.Error() == "" || se.Unwrap() == nil {
		t.Fatalf("stoppedError must expose its message and cause")
	}
	if !se.Is(ErrBadOpcode) || !se.Is(ErrStopped) || se.Is(ErrBadMagic) {
		t.Fatalf("stoppedError.Is matches the wrong targets")
	}
	if err := d.Finish(); !errors.Is(err, ErrBadOpcode) {
		t.Fatalf("Finish after stop: got %v, want ErrBadOpcode", err)
	}
	if !errors.Is(d.Finish(), ErrStopped) {
		t.Fatalf("Finish after stop must also match ErrStopped")
	}
}

func TestStoppedIsNilBeforeFailure(t *testing.T) {
	d := NewDecoder(1 << 20)
	if d.Stopped() != nil {
		t.Fatalf("fresh decoder Stopped: got %v, want nil", d.Stopped())
	}
}

func TestMultipleResponsesInOnePush(t *testing.T) {
	f1 := packFrame(opcodeGet, 0, 0, 1, []byte{0, 0, 0, 0}, nil, []byte("a"))
	f2 := packFrame(opcodeSet, 0, 0, 2, nil, []byte("k"), []byte("b"))
	f3 := packFrame(opcodeDelete, 0, 0, 3, nil, nil, nil)

	d := NewDecoder(1 << 20)
	stream := append(append(f1, f2...), f3...)
	got, err := d.Push(stream)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d responses, want 3", len(got))
	}
	if got[0].CAS != 1 || got[1].CAS != 2 || got[2].CAS != 3 {
		t.Fatalf("unexpected responses: %+v", got)
	}
	if string(got[0].Value) != "a" || string(got[1].Key) != "k" ||
		string(got[1].Value) != "b" {
		t.Fatalf("region split wrong: %+v", got)
	}
}

func TestOpaqueAndCASReturnedVerbatim(t *testing.T) {
	frame := packFrame(opcodeGetKQ, 0, 0xDEADBEEF, 0x0102030405060708,
		[]byte{9, 9, 9, 9}, []byte("k"), nil)
	d := NewDecoder(1 << 20)
	got, err := d.Push(frame)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if got[0].Opaque != 0xDEADBEEF || got[0].CAS != 0x0102030405060708 {
		t.Fatalf("fields not verbatim: %+v", got[0])
	}
}

func TestEmptyFinish(t *testing.T) {
	d := NewDecoder(1 << 20)
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish with no input: %v", err)
	}
	if _, err := d.Push(nil); err != nil {
		t.Fatalf("Push(nil): %v", err)
	}
}

func TestHeaderValidationRules(t *testing.T) {
	cases := []struct {
		name string
		hdr  []byte
		want error
	}{
		{"get success extras must be 4",
			packHeader(opcodeGet, 0, 3, 0, 0, 3, 0, 0), ErrBadExtrasLength},
		{"get key length must be zero",
			packHeader(opcodeGet, 1, 4, 0, 0, 5, 0, 0), ErrBadKeyLength},
		{"get error extras must be zero",
			packHeader(opcodeGet, 0, 1, 0, 0x0005, 1, 0, 0), ErrBadExtrasLength},
		{"getkq success extras must be 4",
			packHeader(opcodeGetKQ, 0, 0, 0, 0, 0, 0, 0), ErrBadExtrasLength},
		{"getkq error extras must be zero",
			packHeader(opcodeGetKQ, 0, 2, 0, 0x0086, 2, 0, 0), ErrBadExtrasLength},
		{"getkq error key must be zero",
			packHeader(opcodeGetKQ, 2, 0, 0, 0x0086, 2, 0, 0), ErrBadKeyLength},
		{"set extras must be zero",
			packHeader(opcodeSet, 0, 1, 0, 0, 1, 0, 0), ErrBadExtrasLength},
		{"delete extras must be zero",
			packHeader(opcodeDelete, 0, 1, 0, 0, 1, 0, 0), ErrBadExtrasLength},
		{"data type must be zero",
			packHeader(opcodeGet, 0, 4, 1, 0, 4, 0, 0), ErrBadDataType},
		{"unsupported opcode",
			packHeader(0x02, 0, 0, 0, 0, 0, 0, 0), ErrBadOpcode},
		{"key length exceeds body length",
			packHeader(opcodeSet, 5, 0, 0, 0, 2, 0, 0), ErrBadKeyLength},
		{"extras length exceeds body length",
			packHeader(opcodeGet, 0, 4, 0, 0, 2, 0, 0), ErrBadExtrasLength},
		{"extras plus key exceed body length",
			packHeader(opcodeGetKQ, 4, 4, 0, 0, 5, 0, 0), ErrBadExtrasLength},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := NewDecoder(1 << 20)
			if _, err := d.Push(tc.hdr); !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

func TestIncompleteHeaderAtFinish(t *testing.T) {
	frame := packFrame(opcodeGet, 0, 0, 0, []byte{1, 2, 3, 4}, nil, nil)

	d := NewDecoder(1 << 20)
	if got, err := d.Push(frame[:10]); err != nil || len(got) != 0 {
		t.Fatalf("partial header: got=%d err=%v", len(got), err)
	}
	if err := d.Finish(); !errors.Is(err, ErrTruncated) {
		t.Fatalf("got %v, want ErrTruncated", err)
	}
}

func TestExtrasKeyValueBoundaries(t *testing.T) {
	extras := []byte{0xAA, 0xBB, 0xCC, 0xDD}
	key := []byte("k")
	value := []byte("value")
	frame := packFrame(opcodeGetKQ, 0, 0, 0, extras, key, value)

	d := NewDecoder(1 << 20)
	got, err := d.Push(frame)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	r := got[0]
	if !bytes.Equal(r.Extras, extras) || !bytes.Equal(r.Key, key) ||
		!bytes.Equal(r.Value, value) {
		t.Fatalf("boundary split wrong: extras=%q key=%q value=%q",
			r.Extras, r.Key, r.Value)
	}
	if int(r.ExtrasLen)+int(r.KeyLength)+len(r.Value) != int(r.BodyLength) {
		t.Fatalf("region sizes do not sum to body length: %+v", r)
	}
}
