package mat5_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"testing"

	"example.org/dataeng/q0300/mat5"
	"example.org/dataeng/q0300/mat5/mat5enc"
)

func testLimits() mat5.Limits {
	return mat5.Limits{
		MaxInflatedBytes: 1 << 20,
		MaxMatrixNodes:   256,
		MaxNumericCells:  1 << 16,
		MaxDepth:         8,
	}
}

func encEndian(bo mat5.Endian) mat5enc.Endian {
	if bo == mat5.BigEndian {
		return mat5enc.BigEndian
	}
	return mat5enc.LittleEndian
}

func parseBytes(t *testing.T, data []byte, bo mat5.Endian) *mat5.Table {
	t.Helper()
	tbl, err := mat5.Parse(data, bo, testLimits())
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	return tbl
}

func expectErrIs(t *testing.T, data []byte, bo mat5.Endian, target error) {
	t.Helper()
	_, err := mat5.Parse(data, bo, testLimits())
	if !errors.Is(err, target) {
		t.Fatalf("expected error wrapping %v, got %v", target, err)
	}
}

func TestBothEndiansRoundTrip(t *testing.T) {
	for _, bo := range []mat5.Endian{mat5.LittleEndian, mat5.BigEndian} {
		b := mat5enc.NewBuilder(encEndian(bo))
		m := &mat5enc.Matrix{
			Name:  "ab", // compact small-element name
			Class: 12,
			Dims:  []int32{2, 3},
			Int32: []int32{-7, 0, 2, 4, -9, 100},
		}
		if err := b.AddMatrix(m); err != nil {
			t.Fatal(err)
		}
		tbl := parseBytes(t, b.Bytes(), bo)
		v, ok := tbl.Lookup("ab")
		if !ok {
			t.Fatalf("variable ab missing")
		}
		im, ok := v.(*mat5.Int32Matrix)
		if !ok {
			t.Fatalf("want *Int32Matrix, got %T", v)
		}
		got, err := im.At(1, 2) // column-major offset 2*2+1 = 5
		if err != nil {
			t.Fatal(err)
		}
		if got != 100 {
			t.Fatalf("endian %d: got %d, want 100", bo, got)
		}
		if got0, _ := im.At(0, 0); got0 != -7 {
			t.Fatalf("endian %d: got %d, want -7", bo, got0)
		}
	}
}

func TestCompactNameIsEightBytes(t *testing.T) {
	b := mat5enc.NewBuilder(mat5enc.LittleEndian)
	if err := b.AddMatrix(&mat5enc.Matrix{
		Name:  "x",
		Class: 12,
		Dims:  []int32{1, 1},
		Int32: []int32{42},
	}); err != nil {
		t.Fatal(err)
	}
	raw := b.Bytes()
	// matrix header(8) + flags(16) + dims(16) + compact name(8) ...
	if raw[40] != 1 || raw[41] != 0 || raw[42] != 1 || raw[43] != 0 {
		t.Fatalf("compact name tag bytes wrong: % x", raw[40:48])
	}
	if raw[44] != 'x' {
		t.Fatalf("compact name data wrong: % x", raw[44:48])
	}
	tbl := parseBytes(t, raw, mat5.LittleEndian)
	if _, ok := tbl.Lookup("x"); !ok {
		t.Fatal("compact name variable not published")
	}
}

func TestCompactInt32DataElement(t *testing.T) {
	// Hand-build a 1x1 int32 matrix whose data element uses the compact
	// four-byte form, immediately followed by the matrix end.
	var out bytes.Buffer
	order := binary.LittleEndian
	putU32 := func(v uint32) {
		var tmp [4]byte
		order.PutUint32(tmp[:], v)
		out.Write(tmp[:])
	}
	var body bytes.Buffer
	writeElem := func(typ uint32, payload []byte) {
		var tmp [4]byte
		order.PutUint32(tmp[:], typ)
		body.Write(tmp[:])
		order.PutUint32(tmp[:], uint32(len(payload)))
		body.Write(tmp[:])
		body.Write(payload)
		body.Write(make([]byte, (8-(len(payload)%8))%8))
	}
	flags := make([]byte, 8)
	order.PutUint32(flags[0:], 12)
	writeElem(6, flags)
	dims := make([]byte, 8)
	order.PutUint32(dims[0:], 1)
	order.PutUint32(dims[4:], 1)
	writeElem(5, dims)
	writeElem(1, []byte("q"))
	// Compact int32 data: type 5, n=4, then the four data bytes.
	var tmp [4]byte
	order.PutUint32(tmp[:], 5|uint32(4)<<16)
	body.Write(tmp[:])
	order.PutUint32(tmp[:], 0x7FFFFFFF)
	body.Write(tmp[:])

	putU32(14)
	putU32(uint32(body.Len()))
	out.Write(body.Bytes())

	tbl := parseBytes(t, out.Bytes(), mat5.LittleEndian)
	s, _, err := tbl.Get("q", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if s.Int32() != 0x7fffffff {
		t.Fatalf("compact int32 = %d, want %d", s.Int32(), 0x7fffffff)
	}
}

func TestCompressedNotAlignedThenNewVariable(t *testing.T) {
	first := &mat5enc.Matrix{
		Name:  "z1",
		Class: 6,
		Dims:  []int32{1, 1},
		Real:  []uint64{math.Float64bits(3.5)},
	}
	cb := mat5enc.NewBuilder(mat5enc.LittleEndian)
	if err := cb.AddCompressed(first); err != nil {
		t.Fatal(err)
	}
	compressedBytes := append([]byte(nil), cb.Bytes()...)
	compressedEnd := len(compressedBytes)
	if compressedEnd%8 == 0 {
		t.Fatalf("test setup invalid: compressed element happens to be 8-aligned at %d", compressedEnd)
	}
	nb := mat5enc.NewBuilder(mat5enc.LittleEndian)
	if err := nb.AddMatrix(&mat5enc.Matrix{
		Name:  "after",
		Class: 12,
		Dims:  []int32{1, 1},
		Int32: []int32{7},
	}); err != nil {
		t.Fatal(err)
	}
	stream := append(compressedBytes, nb.Bytes()...)
	tbl := parseBytes(t, stream, mat5.LittleEndian)
	s, _, err := tbl.Get("z1", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if math.Float64frombits(s.Real) != 3.5 {
		t.Fatalf("inflated value bits wrong: %#x", s.Real)
	}
	s2, _, err := tbl.Get("after", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if s2.Int32() != 7 {
		t.Fatalf("variable after compressed element wrong: %d", s2.Int32())
	}

	v, _ := tbl.Lookup("z1")
	src := v.Source()
	if !src.Inflated || src.Physical.End != uint64(compressedEnd) {
		t.Fatalf("inflated source wrong: %+v (end want %d)", src, compressedEnd)
	}
	if src.Logical.Start != 0 {
		t.Fatalf("logical offset must be reported, got %+v", src)
	}
}

func TestMultiLayerCells(t *testing.T) {
	leafA := &mat5enc.Matrix{Class: 12, Dims: []int32{1, 1}, Int32: []int32{11}}
	leafB := &mat5enc.Matrix{Class: 12, Dims: []int32{1, 1}, Int32: []int32{22}}
	inner := &mat5enc.Matrix{
		Class:    1,
		Dims:     []int32{2, 1},
		Children: []*mat5enc.Matrix{leafA, leafB},
	}
	leafC := &mat5enc.Matrix{
		Class: 6,
		Dims:  []int32{2, 2},
		Real: []uint64{
			math.Float64bits(1), math.Float64bits(2),
			math.Float64bits(3), math.Float64bits(4),
		},
	}
	outer := &mat5enc.Matrix{
		Name:     "c",
		Class:    1,
		Dims:     []int32{1, 2},
		Children: []*mat5enc.Matrix{inner, leafC},
	}
	b := mat5enc.NewBuilder(mat5enc.LittleEndian)
	if err := b.AddMatrix(outer); err != nil {
		t.Fatal(err)
	}
	tbl := parseBytes(t, b.Bytes(), mat5.LittleEndian)

	// Chain: outer cell slot 0 -> inner cell slot 1 -> int32 coordinate [0,0].
	s, _, err := tbl.Get("c", 0, 1, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if s.Int32() != 22 {
		t.Fatalf("cell chain int32 = %d, want 22", s.Int32())
	}
	// Chain: outer slot 1 -> 2x2 double, coordinate [1,0] -> linear index 1.
	s, _, err = tbl.Get("c", 1, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	if math.Float64frombits(s.Real) != 2 {
		t.Fatalf("cell chain double = %v, want 2", math.Float64frombits(s.Real))
	}

	// The leaf's own 2x2 dims must not be treated as the outer cell's dims.
	v, _ := tbl.Lookup("c")
	cell := v.(*mat5.CellMatrix)
	if len(cell.Dims()) != 2 || cell.Dims()[0] != 1 || cell.Dims()[1] != 2 {
		t.Fatalf("outer cell dims leaked from child: %v", cell.Dims())
	}
}

func TestEmptyDimensions(t *testing.T) {
	for _, dims := range [][]int32{{0, 3}, {3, 0}, {0, 0}, {2, 0, 4}} {
		b := mat5enc.NewBuilder(mat5enc.LittleEndian)
		if err := b.AddMatrix(&mat5enc.Matrix{
			Name: "e", Class: 6, Dims: dims, Real: []uint64{},
		}); err != nil {
			t.Fatal(err)
		}
		tbl := parseBytes(t, b.Bytes(), mat5.LittleEndian)
		v, ok := tbl.Lookup("e")
		if !ok {
			t.Fatalf("empty matrix %v missing", dims)
		}
		if v.NumElements() != 0 {
			t.Fatalf("dims %v: want zero elements, got %d", dims, v.NumElements())
		}
	}

	// Empty cell: zero elements means no child matrices.
	b := mat5enc.NewBuilder(mat5enc.LittleEndian)
	if err := b.AddMatrix(&mat5enc.Matrix{
		Name: "ec", Class: 1, Dims: []int32{0, 5},
	}); err != nil {
		t.Fatal(err)
	}
	tbl := parseBytes(t, b.Bytes(), mat5.LittleEndian)
	v, _ := tbl.Lookup("ec")
	if v.NumElements() != 0 {
		t.Fatalf("empty cell elements = %d", v.NumElements())
	}
}

func TestComplexAndNaNBitPatterns(t *testing.T) {
	nanWithPayload := math.Float64bits(math.NaN()) | 0x1234
	negZero := math.Float64bits(math.Copysign(0, -1))
	b := mat5enc.NewBuilder(mat5enc.LittleEndian)
	m := &mat5enc.Matrix{
		Name:    "cx",
		Class:   6,
		Complex: true,
		Dims:    []int32{2, 1},
		Real:    []uint64{nanWithPayload, negZero},
		Imag:    []uint64{negZero, nanWithPayload},
	}
	if err := b.AddMatrix(m); err != nil {
		t.Fatal(err)
	}
	tbl := parseBytes(t, b.Bytes(), mat5.LittleEndian)
	v, _ := tbl.Lookup("cx")
	dm := v.(*mat5.DoubleMatrix)
	if !dm.Complex() {
		t.Fatal("complex flag lost")
	}
	if dm.RealBits()[0] != nanWithPayload {
		t.Fatalf("NaN payload not preserved: %#x want %#x", dm.RealBits()[0], nanWithPayload)
	}
	if dm.RealBits()[1] != negZero || dm.ImagBits()[0] != negZero {
		t.Fatalf("negative zero bit pattern not preserved: real %#x imag %#x",
			dm.RealBits()[1], dm.ImagBits()[0])
	}
	s, _, err := tbl.Get("cx", 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	if s.Imag != nanWithPayload || !s.Complex {
		t.Fatalf("scalar complex bits wrong: %+v", s)
	}
}

func TestTruncatedZlibRejected(t *testing.T) {
	b := mat5enc.NewBuilder(mat5enc.LittleEndian)
	if err := b.AddCompressed(&mat5enc.Matrix{
		Name: "z", Class: 6, Dims: []int32{1, 1},
		Real: []uint64{math.Float64bits(1)},
	}); err != nil {
		t.Fatal(err)
	}
	full := b.Bytes()

	// Cut bytes inside the compressed payload and fix the declared length so
	// parsing reaches zlib and fails on the missing checksum/end marker.
	cutCompressed := len(full) - 8 - 4
	var truncated bytes.Buffer
	order := binary.LittleEndian
	hdr := make([]byte, 8)
	order.PutUint32(hdr[0:], 15)
	order.PutUint32(hdr[4:], uint32(cutCompressed))
	truncated.Write(hdr)
	truncated.Write(full[8 : 8+cutCompressed])
	expectErrIs(t, truncated.Bytes(), mat5.LittleEndian, mat5.ErrInflate)

	// Declare a payload longer than the bytes actually present.
	var tampered bytes.Buffer
	hdr2 := make([]byte, 8)
	order.PutUint32(hdr2[0:], 15)
	order.PutUint32(hdr2[4:], uint32(len(full)-8+10))
	tampered.Write(hdr2)
	tampered.Write(full[8:])
	expectErrIs(t, tampered.Bytes(), mat5.LittleEndian, mat5.ErrTruncated)
}

func TestDeclaredProductOverflow(t *testing.T) {
	b := mat5enc.NewBuilder(mat5enc.LittleEndian)
	// Build a valid matrix manually, then overwrite its dims with values whose
	// product overflows uint64 while the data element stays short.
	if err := b.AddMatrix(&mat5enc.Matrix{
		Name: "ov", Class: 12, Dims: []int32{1, 1}, Int32: []int32{1},
	}); err != nil {
		t.Fatal(err)
	}
	raw := b.Bytes()
	// dims element begins at offset 24 (matrix hdr 8 + flags 16); dims payload
	// starts at +8 inside that element -> offset 32.
	order := binary.LittleEndian
	order.PutUint32(raw[32:36], 0x7fffffff)
	order.PutUint32(raw[36:40], 0x7fffffff)
	// The dims are still non-negative, but their product overflows.
	expectErrIs(t, raw, mat5.LittleEndian, mat5.ErrLimits)
}
