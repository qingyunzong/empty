package telemcodec

import (
	"bytes"
	"reflect"
	"testing"
)

func encodeMixed(t *testing.T, order BitOrder) ([]byte, int64) {
	t.Helper()
	wr := NewBitWriter(order)
	steps := []func() error{
		func() error { return wr.WriteBits(0x15, 5) },
		func() error { return wr.WriteUvarint(300) },
		func() error { return wr.WriteSigned(-100, 9) },
		func() error { return wr.WriteVarint(-77) },
		func() error { wr.Align(); return nil },
		func() error { return wr.WriteBits(0x2A, 6) },
	}
	for i, s := range steps {
		if err := s(); err != nil {
			t.Fatalf("order=%d step %d: %v", order, i, err)
		}
	}
	return wr.Bytes(), wr.BitLen()
}

// Pause at every single bit position of a mixed stream, serialize the
// snapshot, restore it in a fresh reader, and verify the resumed bit
// sequence re-encodes to the exact original stream.
func TestPauseResumeAtAnyBit(t *testing.T) {
	for _, order := range orders {
		data, total := encodeMixed(t, order)
		for p := int64(0); p <= total; p++ {
			r := NewBitReaderBytes(data, order)
			out := NewBitWriter(order)
			read := func(n int) {
				v, err := r.ReadBits(n)
				if err != nil {
					t.Fatalf("order=%d p=%d read %d: %v", order, p, n, err)
				}
				if err := out.WriteBits(v, n); err != nil {
					t.Fatalf("order=%d p=%d write %d: %v", order, p, n, err)
				}
			}
			remaining := total
			left := p
			for left > 0 { // consume the pause prefix in 13-bit chunks
				c := 13
				if left < 13 {
					c = int(left)
				}
				read(c)
				left -= int64(c)
				remaining -= int64(c)
			}
			blob := r.Snapshot().Marshal()
			state, err := UnmarshalReaderState(blob)
			if err != nil {
				t.Fatalf("order=%d p=%d unmarshal: %v", order, p, err)
			}
			r = Resume(state, nil) // no source: cache alone must suffice
			for remaining > 0 {
				c := 13
				if remaining < 13 {
					c = int(remaining)
				}
				read(c)
				remaining -= int64(c)
			}
			if out.BitLen() != total || !bytes.Equal(out.Bytes(), data) {
				t.Fatalf("order=%d p=%d resumed stream mismatch", order, p)
			}
		}
	}
}

// Pause at a field boundary mid-structure, serialize, and resume decoding
// the remaining fields; entries must match an uninterrupted decode.
func TestStructPauseResume(t *testing.T) {
	for _, order := range orders {
		data := encodeFrame(t, order)
		fields := frameFields()
		ref, err := Interpret(data, order, fields)
		if err != nil {
			t.Fatal(err)
		}
		// Pause after every field boundary; the session snapshot carries
		// decoded values so length references stay resolvable.
		for cut := 0; cut <= len(fields); cut++ {
			sess := NewSession(NewBitReaderBytes(data, order))
			var sink []Entry
			if err := sess.ReadStruct(fields[:cut], &sink); err != nil {
				t.Fatalf("order=%d cut=%d: %v", order, cut, err)
			}
			state, err := UnmarshalSessionState(sess.Snapshot().Marshal())
			if err != nil {
				t.Fatal(err)
			}
			sess2 := ResumeSession(state, nil)
			if err := sess2.ReadStruct(fields[cut:], &sink); err != nil {
				t.Fatalf("order=%d cut=%d resume: %v", order, cut, err)
			}
			if !reflect.DeepEqual(sink, ref) {
				t.Fatalf("order=%d cut=%d mismatch\n got: %+v\nwant: %+v", order, cut, sink, ref)
			}
		}
	}
}

// A snapshot taken while reading from a live source can be resumed with
// that source to keep pulling bytes beyond the cached prefix.
func TestResumeWithLiveSource(t *testing.T) {
	for _, order := range orders {
		data, total := encodeMixed(t, order)
		src := bytes.NewReader(data)
		r := NewBitReader(src, order)
		if _, err := r.ReadBits(5); err != nil {
			t.Fatal(err)
		}
		state, err := UnmarshalReaderState(r.Snapshot().Marshal())
		if err != nil {
			t.Fatal(err)
		}
		r2 := Resume(state, src)
		got := NewBitWriter(order)
		if err := got.WriteBits(0x15, 5); err != nil {
			t.Fatal(err)
		}
		for got.BitLen() < total {
			n := int(total - got.BitLen())
			if n > 9 {
				n = 9
			}
			v, err := r2.ReadBits(n)
			if err != nil {
				t.Fatalf("order=%d: %v", order, err)
			}
			if err := got.WriteBits(v, n); err != nil {
				t.Fatal(err)
			}
		}
		if !bytes.Equal(got.Bytes(), data) {
			t.Fatalf("order=%d live-source resume mismatch", order)
		}
	}
}

func TestStateCorruptionRejected(t *testing.T) {
	data, _ := encodeMixed(t, MSBFirst)
	r := NewBitReaderBytes(data, MSBFirst)
	blob := r.Snapshot().Marshal()
	if _, err := UnmarshalReaderState(blob[:len(blob)-1]); err == nil {
		t.Fatal("truncated state accepted")
	}
	bad := append([]byte(nil), blob...)
	bad[0] = 'X'
	if _, err := UnmarshalReaderState(bad); err == nil {
		t.Fatal("bad magic accepted")
	}
	bad = append([]byte(nil), blob...)
	bad[4] = 9
	if _, err := UnmarshalReaderState(bad); err == nil {
		t.Fatal("bad order accepted")
	}
}
