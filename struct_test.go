package telemcodec

import (
	"bytes"
	"errors"
	"io"
	"reflect"
	"testing"
)

// frameFields describes a frame exercising length references, length
// multiplication, sign extension, alignment and nesting (with a nested
// field referencing an outer length field).
func frameFields() []Field {
	return []Field{
		{Name: "hdr", Kind: KindUint, Width: 4},
		{Name: "n", Kind: KindUint, Width: 5},
		{Name: "payload", Kind: KindUint, LenRef: "n", LenMul: 3},
		{Name: "pad", Kind: KindAlign},
		{Name: "temp", Kind: KindInt, Width: 9},
		{Name: "sub", Kind: KindStruct, Sub: []Field{
			{Name: "a", Kind: KindUvarint},
			{Name: "b", Kind: KindVarint},
			{Name: "c", Kind: KindUint, LenRef: "n", LenMul: 2},
		}},
		{Name: "tail", Kind: KindUint, Width: 6},
	}
}

func encodeFrame(t *testing.T, order BitOrder) []byte {
	t.Helper()
	wr := NewBitWriter(order)
	steps := []func() error{
		func() error { return wr.WriteBits(0xA, 4) },     // hdr
		func() error { return wr.WriteBits(5, 5) },       // n -> payload 15 bits, c 10 bits
		func() error { return wr.WriteBits(0x4321, 15) }, // payload
		func() error { return nil },                      // align: already aligned at 24
		func() error { return wr.WriteSigned(-100, 9) },  // temp
		func() error { return wr.WriteUvarint(300) },     // sub.a
		func() error { return wr.WriteVarint(-77) },      // sub.b
		func() error { return wr.WriteBits(0x2B5, 10) },  // sub.c
		func() error { return wr.WriteBits(0x2A, 6) },    // tail
	}
	for i, s := range steps {
		if err := s(); err != nil {
			t.Fatalf("order=%d step %d: %v", order, i, err)
		}
	}
	return wr.Bytes()
}

func TestStructDecodeMatchesInterpreter(t *testing.T) {
	for _, order := range orders {
		data := encodeFrame(t, order)
		var sink []Entry
		if err := ReadStruct(NewBitReaderBytes(data, order), frameFields(), &sink); err != nil {
			t.Fatalf("order=%d ReadStruct: %v", order, err)
		}
		ref, err := Interpret(data, order, frameFields())
		if err != nil {
			t.Fatalf("order=%d Interpret: %v", order, err)
		}
		if !reflect.DeepEqual(sink, ref) {
			t.Fatalf("order=%d mismatch\n codec: %+v\n interp: %+v", order, sink, ref)
		}
		// Spot-check values and original bit ranges.
		want := []Entry{
			{Name: "hdr", U: 0xA, S: 0xA, Start: 0, End: 4},
			{Name: "n", U: 5, S: 5, Start: 4, End: 9},
			{Name: "payload", U: 0x4321, S: 0x4321, Start: 9, End: 24},
			{Name: "pad", Start: 24, End: 24},
			{Name: "temp", U: negU(100), S: -100, Start: 24, End: 33},
			{Name: "a", U: 300, S: 300, Start: 33, End: 49},
			{Name: "b", U: negU(77), S: -77, Start: 49, End: 65},
			{Name: "c", U: 0x2B5, S: 0x2B5, Start: 65, End: 75},
			{Name: "tail", U: 0x2A, S: 0x2A, Start: 75, End: 81},
		}
		if !reflect.DeepEqual(sink, want) {
			t.Fatalf("order=%d entries mismatch\n got: %+v\nwant: %+v", order, sink, want)
		}
	}
}

type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

// A failing nested read must roll back the cursor and the output sink while
// retaining bytes already cached from the external source; once more bits
// are available the same reader recovers and completes the frame.
func TestNestedFailureRollbackAndRecovery(t *testing.T) {
	for _, order := range orders {
		data := encodeFrame(t, order)
		fields := frameFields()
		cr := &countingReader{r: bytes.NewReader(data)}
		sess := NewSession(NewBitReader(cr, order))
		r := sess.Reader()
		r.SetBitLimit(40) // sub.a starts at 33 and needs 16 bits: fails

		var sink []Entry
		err := sess.ReadStruct(fields, &sink)
		if !errors.Is(err, ErrTruncated) {
			t.Fatalf("order=%d err=%v", order, err)
		}
		if r.Pos() != 33 {
			t.Fatalf("order=%d cursor=%d, want rollback to 33", order, r.Pos())
		}
		if len(sink) != 5 {
			t.Fatalf("order=%d sink len=%d, want 5 entries kept", order, len(sink))
		}
		if r.CachedBits() <= r.Pos() {
			t.Fatalf("order=%d cached bits=%d pos=%d: cached source bytes were discarded",
				order, r.CachedBits(), r.Pos())
		}
		pulled := cr.n

		// Recover: allow the full stream and continue from the rolled-back
		// cursor. Cached bytes must be reused, not re-fetched.
		r.SetBitLimit(int64(len(data)) * 8)
		if err := sess.ReadStruct(fields[5:], &sink); err != nil {
			t.Fatalf("order=%d recovery: %v", order, err)
		}
		ref, err := Interpret(data, order, fields)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(sink, ref) {
			t.Fatalf("order=%d recovered sink mismatch\n got: %+v\nwant: %+v", order, sink, ref)
		}
		if cr.n-pulled > len(data) {
			t.Fatalf("order=%d source re-fetched from scratch", order)
		}
	}
}

func TestLengthReferenceErrors(t *testing.T) {
	fields := []Field{{Name: "x", Kind: KindUint, LenRef: "missing", LenMul: 8}}
	if err := ReadStruct(NewBitReaderBytes([]byte{0}, MSBFirst), fields, nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("missing ref err=%v", err)
	}
	big := []Field{
		{Name: "n", Kind: KindUint, Width: 4},
		{Name: "y", Kind: KindUint, LenRef: "n", LenMul: 8},
	}
	wr := NewBitWriter(MSBFirst)
	if err := wr.WriteBits(15, 4); err != nil {
		t.Fatal(err)
	}
	// 15*8 = 120 bits > 64: multiplication overflow must be rejected.
	if err := ReadStruct(NewBitReaderBytes(wr.Bytes(), MSBFirst), big, nil); !errors.Is(err, ErrOverflow) {
		t.Fatalf("mul overflow err=%v", err)
	}
}

func negU(v int64) uint64 { return uint64(-v) }
