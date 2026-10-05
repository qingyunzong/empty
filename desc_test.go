package telemetry

import (
	"errors"
	"io"
	"reflect"
	"testing"
)

// growableSource feeds bytes from a shared slice that the test extends
// later, simulating a stream that stalls mid-structure.
type growableSource struct {
	buf *[]byte
	off int
}

func (g *growableSource) Read(p []byte) (int, error) {
	if g.off >= len(*g.buf) {
		return 0, io.EOF
	}
	n := copy(p, (*g.buf)[g.off:])
	g.off += n
	return n, nil
}

func nestedDescriptor() []Field {
	return []Field{
		{Name: "len", Kind: KindUInt, Width: 8},
		{Name: "payload", Kind: KindBytes, LenRef: "len"},
		{Name: "nested", Kind: KindStruct, Fields: []Field{
			{Name: "a", Kind: KindUInt, Width: 3},
			{Name: "b", Kind: KindUInt, Width: 20},
		}},
	}
}

func encodeNested(t *testing.T, order BitOrder, payload []byte, a, b uint64) []byte {
	t.Helper()
	w := NewWriter(order)
	if err := w.WriteBits(uint64(len(payload)), 8); err != nil {
		t.Fatal(err)
	}
	for _, by := range payload {
		if err := w.WriteBits(uint64(by), 8); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.WriteBits(a, 3); err != nil {
		t.Fatal(err)
	}
	if err := w.WriteBits(b, 20); err != nil {
		t.Fatal(err)
	}
	return w.Bytes()
}

// TestNestedFailureRollbackKeepsCache truncates the stream inside the
// nested struct, checks the cursor and output roll back while externally
// cached bytes survive, then extends the stream and retries successfully.
func TestNestedFailureRollbackKeepsCache(t *testing.T) {
	for _, o := range orders {
		payload := []byte{0xde, 0xad, 0xbe}
		full := encodeNested(t, o.order, payload, 5, 0xABCDE)
		// Cut the stream 10 bits into nested.b (8 + 24 + 3 + 10 = 45 bits).
		cut := 45 / 8
		shared := append([]byte(nil), full[:cut]...)
		src := &growableSource{buf: &shared}
		r := NewStreamReader(src, o.order)

		v, err := Decode(r, nestedDescriptor())
		if !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("%s: want EOF, got %v", o.name, err)
		}
		if v != nil {
			t.Fatalf("%s: partial output leaked on failure", o.name)
		}
		if r.Pos() != 0 {
			t.Fatalf("%s: cursor not rolled back, pos=%d", o.name, r.Pos())
		}
		cached := r.CachedBits()
		if cached != cut*8 {
			t.Fatalf("%s: cached bits = %d, want %d", o.name, cached, cut*8)
		}

		// Extend the stream; retry must succeed without re-reading old
		// bytes (growableSource never rewinds).
		shared = append(shared, full[cut:]...)
		v, err = Decode(r, nestedDescriptor())
		if err != nil {
			t.Fatalf("%s: retry: %v", o.name, err)
		}
		if r.CachedBits() < cached {
			t.Fatalf("%s: cache shrank from %d to %d", o.name, cached, r.CachedBits())
		}
		if got := v.Kids[0].U; got != 3 {
			t.Fatalf("%s: len = %d, want 3", o.name, got)
		}
		if !reflect.DeepEqual(v.Kids[1].B, payload) {
			t.Fatalf("%s: payload = %x", o.name, v.Kids[1].B)
		}
		nested := v.Kids[2]
		if nested.Kids[0].U != 5 || nested.Kids[1].U != 0xABCDE {
			t.Fatalf("%s: nested = (%d, %#x)", o.name, nested.Kids[0].U, nested.Kids[1].U)
		}
	}
}

// TestNestedVarintFailureRollback makes the nested struct fail on an
// overlong varint and checks the outer cursor rolls back to the start.
func TestNestedVarintFailureRollback(t *testing.T) {
	for _, o := range orders {
		w := NewWriter(o.order)
		w.WriteBits(1, 8)                                         // len = 1
		w.WriteBits(0x77, 8)                                      // payload
		writeRawVarintGroups(w, [2]uint64{5, 1}, [2]uint64{0, 0}) // overlong
		fields := []Field{
			{Name: "len", Kind: KindUInt, Width: 8},
			{Name: "payload", Kind: KindBytes, LenRef: "len"},
			{Name: "nested", Kind: KindStruct, Fields: []Field{
				{Name: "tag", Kind: KindVarint},
			}},
		}
		r := NewReaderBits(w.Bytes(), w.Pos(), o.order)
		v, err := Decode(r, fields)
		if !errors.Is(err, ErrOverlong) {
			t.Fatalf("%s: want ErrOverlong, got %v", o.name, err)
		}
		if v != nil || r.Pos() != 0 {
			t.Fatalf("%s: v=%v pos=%d", o.name, v, r.Pos())
		}
	}
}

// richDescriptor exercises length references with multiplication, sign
// extension, byte alignment, varints, and nesting.
func richDescriptor() []Field {
	return []Field{
		{Name: "magic", Kind: KindUInt, Width: 8},
		{Name: "version", Kind: KindSInt, Width: 5},
		{Name: "count", Kind: KindUInt, Width: 4},
		{Name: "data", Kind: KindBytes, LenRef: "count", LenMul: 2},
		{Name: "pad", Kind: KindAlign, Width: 8},
		{Name: "tag", Kind: KindVarint},
		{Name: "sub", Kind: KindStruct, Fields: []Field{
			{Name: "x", Kind: KindUInt, Width: 7},
			{Name: "y", Kind: KindSInt, Width: 9},
			{Name: "inner", Kind: KindStruct, Fields: []Field{
				{Name: "z", Kind: KindUInt, Width: 2},
			}},
		}},
		{Name: "tail", Kind: KindSVarint},
	}
}

func encodeRich(t *testing.T, order BitOrder) (*Writer, []byte) {
	t.Helper()
	w := NewWriter(order)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(w.WriteBits(0xA5, 8)) // magic
	must(w.WriteSigned(-3, 5)) // version
	must(w.WriteBits(3, 4))    // count
	data := []byte{1, 2, 3, 4, 5, 6}
	for _, b := range data { // 3 * 2 bytes
		must(w.WriteBits(uint64(b), 8))
	}
	if _, err := w.Align(8); err != nil {
		t.Fatal(err)
	}
	must(w.WriteVarint(300))          // tag
	must(w.WriteBits(0x55, 7))        // x
	must(w.WriteSigned(-100, 9))      // y
	must(w.WriteBits(2, 2))           // z
	must(w.WriteVarintSigned(-12345)) // tail
	return w, data
}

// TestDecodeRich checks values, sign extension, length multiplication,
// and in-place bit ranges on the primary decoder.
func TestDecodeRich(t *testing.T) {
	for _, o := range orders {
		w, data := encodeRich(t, o.order)
		r := NewReaderBits(w.Bytes(), w.Pos(), o.order)
		v, err := Decode(r, richDescriptor())
		if err != nil {
			t.Fatalf("%s: %v", o.name, err)
		}
		k := v.Kids
		if k[0].U != 0xA5 {
			t.Fatalf("%s: magic=%#x", o.name, k[0].U)
		}
		if k[1].S != -3 {
			t.Fatalf("%s: version=%d, want -3 (sign extension)", o.name, k[1].S)
		}
		if k[2].U != 3 {
			t.Fatalf("%s: count=%d", o.name, k[2].U)
		}
		if !reflect.DeepEqual(k[3].B, data) {
			t.Fatalf("%s: data=%v (length multiplication 3x2)", o.name, k[3].B)
		}
		if k[5].U != 300 {
			t.Fatalf("%s: tag=%d", o.name, k[5].U)
		}
		sub := k[6]
		if sub.Kids[0].U != 0x55 || sub.Kids[1].S != -100 || sub.Kids[2].Kids[0].U != 2 {
			t.Fatalf("%s: sub=(%#x, %d, %d)", o.name, sub.Kids[0].U, sub.Kids[1].S, sub.Kids[2].Kids[0].U)
		}
		if k[7].S != -12345 {
			t.Fatalf("%s: tail=%d", o.name, k[7].S)
		}
		// In-place ranges: every field's [Start, End) must tile the
		// parent's range with no gaps or overlaps.
		var check func(n *Value)
		check = func(n *Value) {
			cur := n.Start
			for _, kid := range n.Kids {
				if kid.Start != cur {
					t.Fatalf("%s: %q starts at %d, previous ended at %d", o.name, kid.Name, kid.Start, cur)
				}
				if kid.End <= kid.Start && kid.Kind != KindAlign {
					t.Fatalf("%s: %q has empty range [%d,%d)", o.name, kid.Name, kid.Start, kid.End)
				}
				check(kid)
				cur = kid.End
			}
			if len(n.Kids) > 0 && n.End != cur {
				t.Fatalf("%s: %q ends at %d, last kid at %d", o.name, n.Name, n.End, cur)
			}
		}
		check(v)
		if v.Start != 0 || v.End != w.Pos() {
			t.Fatalf("%s: root range [%d,%d), stream is %d bits", o.name, v.Start, v.End, w.Pos())
		}
	}
}

// flattenSpans walks a decoded Value tree pre-order, matching the order
// produced by the independent interpreter.
func flattenSpans(v *Value) []Span {
	out := []Span{{Name: v.Name, Start: v.Start, End: v.End}}
	for _, k := range v.Kids {
		out = append(out, flattenSpans(k)...)
	}
	return out
}

// TestCrossCheckRanges decodes the same stream with the primary decoder
// and the independent descriptor interpreter, and requires identical
// in-place bit ranges for every field — including length-multiplied byte
// strings, sign-extended integers, and alignment padding.
func TestCrossCheckRanges(t *testing.T) {
	for _, o := range orders {
		w, _ := encodeRich(t, o.order)
		bits := w.Bytes()
		total := w.Pos()

		r := NewReaderBits(bits, total, o.order)
		v, err := Decode(r, richDescriptor())
		if err != nil {
			t.Fatalf("%s: decode: %v", o.name, err)
		}
		got := flattenSpans(v)

		want, err := InterpretSpans(bits, total, o.order, richDescriptor())
		if err != nil {
			t.Fatalf("%s: interpret: %v", o.name, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: range mismatch\n primary: %+v\nindependent: %+v", o.name, got, want)
		}

		// Spot-check absolute ranges (same for both bit orders).
		expect := map[string][2]int{
			"magic":   {0, 8},
			"version": {8, 13},
			"count":   {13, 17},
			"data":    {17, 65}, // 3 * 2 bytes, length multiplication
			"pad":     {65, 72}, // byte alignment padding
			"tag":     {72, 88},
			"x":       {88, 95},
			"y":       {95, 104}, // sign-extended field
			"z":       {104, 106},
			"tail":    {106, 130},
		}
		for _, s := range got {
			if e, ok := expect[s.Name]; ok {
				if s.Start != e[0] || s.End != e[1] {
					t.Fatalf("%s: %q range [%d,%d), want [%d,%d)", o.name, s.Name, s.Start, s.End, e[0], e[1])
				}
			}
		}
	}
}

// TestLengthRefUnknown checks a dangling length reference is an error
// that leaves the cursor unmoved.
func TestLengthRefUnknown(t *testing.T) {
	fields := []Field{{Name: "data", Kind: KindBytes, LenRef: "nope"}}
	r := NewReaderBits([]byte{0xff}, 8, MSBFirst)
	if _, err := Decode(r, fields); err == nil {
		t.Fatal("expected error for unknown length ref")
	}
	if r.Pos() != 0 {
		t.Fatalf("cursor moved to %d", r.Pos())
	}
}
