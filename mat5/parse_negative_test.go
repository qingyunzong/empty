package mat5_test

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"testing"

	"example.org/dataeng/q0300/mat5"
	"example.org/dataeng/q0300/mat5/mat5enc"
)

func TestConcatenatedZlibRejected(t *testing.T) {
	good := &mat5enc.Matrix{
		Name: "g", Class: 12, Dims: []int32{1, 1}, Int32: []int32{1},
	}
	eb := mat5enc.NewBuilder(mat5enc.LittleEndian)
	rawMatrix, err := eb.MatrixElement(good)
	if err != nil {
		t.Fatal(err)
	}
	var firstStream bytes.Buffer
	zw := zlib.NewWriter(&firstStream)
	_, _ = zw.Write(rawMatrix)
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	compressedBytes := firstStream.Bytes()

	var out bytes.Buffer
	order := binary.LittleEndian
	hdr := make([]byte, 8)
	order.PutUint32(hdr[0:], 15)
	extra := []byte{0xDE, 0xAD, 0xBE, 0xEF}
	order.PutUint32(hdr[4:], uint32(len(compressedBytes)+len(extra)))
	out.Write(hdr)
	out.Write(compressedBytes)
	out.Write(extra)

	// The zlib stream ends cleanly after one matrix, but declared compressed
	// bytes remain unconsumed: this must fail rather than be silently accepted.
	expectErrIs(t, out.Bytes(), mat5.LittleEndian, mat5.ErrInflate)
}

func TestNestedCompressionRejected(t *testing.T) {
	eb := mat5enc.NewBuilder(mat5enc.LittleEndian)
	leaf := &mat5enc.Matrix{Class: 12, Dims: []int32{1, 1}, Int32: []int32{1}}
	innerMatrix, err := eb.MatrixElement(&mat5enc.Matrix{
		Class: 1, Dims: []int32{1, 1}, Children: []*mat5enc.Matrix{leaf},
	})
	if err != nil {
		t.Fatal(err)
	}
	order := binary.LittleEndian
	// Compress the child matrix so its bytes are a complete type-15 element.
	var childZlib bytes.Buffer
	cw := zlib.NewWriter(&childZlib)
	_, _ = cw.Write(innerMatrix)
	if err := cw.Close(); err != nil {
		t.Fatal(err)
	}
	compressedChild := childZlib.Bytes()
	pad := (8 - (len(compressedChild) % 8)) % 8
	compressedChild = append(compressedChild, make([]byte, pad)...)
	zlibElem := bytes.Buffer{}
	eh := make([]byte, 8)
	order.PutUint32(eh[0:], 15)
	order.PutUint32(eh[4:], uint32(len(compressedChild)))
	zlibElem.Write(eh)
	zlibElem.Write(compressedChild)

	var out bytes.Buffer
	var zb bytes.Buffer
	zw := zlib.NewWriter(&zb)
	// The inflated stream must be one matrix element; place a nested zlib
	// element where the single matrix header is required.
	_, _ = zw.Write(zlibElem.Bytes())
	_ = zw.Close()
	hdr := make([]byte, 8)
	order.PutUint32(hdr[0:], 15)
	order.PutUint32(hdr[4:], uint32(zb.Len()))
	out.Write(hdr)
	out.Write(zb.Bytes())
	// The inflated stream begins with a type-15 element instead of the single
	// required matrix element; nested compression is rejected outright.
	_, err = mat5.Parse(out.Bytes(), mat5.LittleEndian, testLimits())
	if !errors.Is(err, mat5.ErrBadType) && !errors.Is(err, mat5.ErrBadElement) {
		t.Fatalf("nested compression: want ErrBadType/ErrBadElement, got %v", err)
	}
}

func TestExtraAndMismatchedSubelements(t *testing.T) {
	// Class int32 but its data element carries a type-9 float tag.
	var body bytes.Buffer
	order := binary.LittleEndian
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
	order.PutUint32(flags[0:], 12) // int32 class
	writeElem(6, flags)
	dims := make([]byte, 8)
	order.PutUint32(dims[0:], 1)
	order.PutUint32(dims[4:], 1)
	writeElem(5, dims)
	writeElem(1, []byte{'m'})     // compact name would be small; use normal here
	writeElem(9, make([]byte, 4)) // wrong data type for int32 class

	var raw bytes.Buffer
	var hdr [4]byte
	order.PutUint32(hdr[:], 14)
	raw.Write(hdr[:])
	order.PutUint32(hdr[:], uint32(body.Len()))
	raw.Write(hdr[:])
	raw.Write(body.Bytes())
	expectErrIs(t, raw.Bytes(), mat5.LittleEndian, mat5.ErrClass)

	// Append an extra stray element after a complete matrix body by growing
	// the matrix payload length without adding valid content.
	b2 := mat5enc.NewBuilder(mat5enc.LittleEndian)
	_ = b2.AddMatrix(&mat5enc.Matrix{
		Name: "m2", Class: 12, Dims: []int32{1, 1}, Int32: []int32{1},
	})
	raw2 := b2.Bytes()
	raw2[4] += 8 // claim eight more payload bytes than actually encoded
	expectErrIs(t, raw2, mat5.LittleEndian, mat5.ErrTruncated)
}

func TestBudgetLimits(t *testing.T) {
	b := mat5enc.NewBuilder(mat5enc.LittleEndian)
	_ = b.AddMatrix(&mat5enc.Matrix{
		Name: "big", Class: 12, Dims: []int32{4, 1}, Int32: []int32{1, 2, 3, 4},
	})

	lim := mat5.Limits{
		MaxInflatedBytes: 1024,
		MaxMatrixNodes:   1,
		MaxNumericCells:  3, // matrix needs four numeric cells
		MaxDepth:         4,
	}
	if _, err := mat5.Parse(b.Bytes(), mat5.LittleEndian, lim); !errors.Is(err, mat5.ErrLimits) {
		t.Fatalf("numeric budget: want ErrLimits, got %v", err)
	}

	// Inflate budget: compressed variable above a tiny inflated-byte cap.
	cb := mat5enc.NewBuilder(mat5enc.LittleEndian)
	_ = cb.AddCompressed(&mat5enc.Matrix{
		Name: "cz", Class: 12, Dims: []int32{2, 1}, Int32: []int32{1, 2},
	})
	limInflate := mat5.Limits{
		MaxInflatedBytes: 4,
		MaxMatrixNodes:   8,
		MaxNumericCells:  8,
		MaxDepth:         4,
	}
	if _, err := mat5.Parse(cb.Bytes(), mat5.LittleEndian, limInflate); !errors.Is(err, mat5.ErrLimits) {
		t.Fatalf("inflate budget: want ErrLimits, got %v", err)
	}
}

func TestDepthLimitAndNames(t *testing.T) {
	leaf := &mat5enc.Matrix{Class: 12, Dims: []int32{1, 1}, Int32: []int32{1}}
	level2 := &mat5enc.Matrix{Class: 1, Dims: []int32{1, 1}, Children: []*mat5enc.Matrix{leaf}}
	level1 := &mat5enc.Matrix{Class: 1, Dims: []int32{1, 1}, Children: []*mat5enc.Matrix{level2}}
	top := &mat5enc.Matrix{Name: "deep", Class: 1, Dims: []int32{1, 1}, Children: []*mat5enc.Matrix{level1}}
	b := mat5enc.NewBuilder(mat5enc.LittleEndian)
	if err := b.AddMatrix(top); err != nil {
		t.Fatal(err)
	}
	lim := mat5.Limits{
		MaxInflatedBytes: 1 << 20,
		MaxMatrixNodes:   256,
		MaxNumericCells:  256,
		MaxDepth:         3, // top=1, level1=2, level2=3, leaf=4 -> reject
	}
	if _, err := mat5.Parse(b.Bytes(), mat5.LittleEndian, lim); !errors.Is(err, mat5.ErrLimits) {
		t.Fatalf("depth: want ErrLimits, got %v", err)
	}

	for _, bad := range []string{"", "1abc", "a-b", "na me", "café"} {
		eb := mat5enc.NewBuilder(mat5enc.LittleEndian)
		// Use raw bytes for the empty-name case; others encode normally.
		m := &mat5enc.Matrix{
			Name: bad, Class: 12, Dims: []int32{1, 1}, Int32: []int32{1},
		}
		if err := eb.AddMatrix(m); err == nil {
			expectErrIs(t, eb.Bytes(), mat5.LittleEndian, mat5.ErrName)
		}
	}

	// Duplicate top-level names must fail and publish nothing.
	db := mat5enc.NewBuilder(mat5enc.LittleEndian)
	for range 2 {
		if err := db.AddMatrix(&mat5enc.Matrix{
			Name: "dup", Class: 12, Dims: []int32{1, 1}, Int32: []int32{1},
		}); err != nil {
			t.Fatal(err)
		}
	}
	tbl, err := mat5.Parse(db.Bytes(), mat5.LittleEndian, testLimits())
	if !errors.Is(err, mat5.ErrName) || tbl != nil {
		t.Fatalf("duplicate names: want ErrName and nil table, got tbl=%v err=%v", tbl, err)
	}
}

func TestPaddingIgnoredAndSmallElementJump(t *testing.T) {
	// Manually craft a matrix whose int8 name is three bytes (compact) followed
	// by garbage padding, then a long normal name element with nonzero padding.
	var out bytes.Buffer
	order := binary.LittleEndian
	putU32 := func(v uint32) {
		var tmp [4]byte
		order.PutUint32(tmp[:], v)
		out.Write(tmp[:])
	}

	var body bytes.Buffer
	writeTo := func(dst *bytes.Buffer, typ uint32, payload []byte) {
		var tmp [4]byte
		order.PutUint32(tmp[:], typ)
		dst.Write(tmp[:])
		order.PutUint32(tmp[:], uint32(len(payload)))
		dst.Write(tmp[:])
		dst.Write(payload)
		if pad := (8 - (len(payload) % 8)) % 8; pad > 0 {
			dst.Write(bytes.Repeat([]byte{0xAB}, pad)) // nonzero padding
		}
	}
	// flags
	flags := make([]byte, 8)
	order.PutUint32(flags[0:], 12)
	writeTo(&body, 6, flags)
	// dims 1x1
	dims := make([]byte, 8)
	order.PutUint32(dims[0:], 1)
	order.PutUint32(dims[4:], 1)
	writeTo(&body, 5, dims)
	// compact small name "abc": tag = type1 | n3<<16, data then junk padding
	putU32To := func(dst *bytes.Buffer, v uint32) {
		var tmp [4]byte
		order.PutUint32(tmp[:], v)
		dst.Write(tmp[:])
	}
	putU32To(&body, 1|uint32(3)<<16)
	body.Write([]byte{'a', 'b', 'c', 0xCD}) // fourth byte ignored padding
	// int32 data 1 element
	data := make([]byte, 4)
	order.PutUint32(data, 99)
	writeTo(&body, 5, data)

	putU32(14)
	putU32(uint32(body.Len()))
	out.Write(body.Bytes())

	tbl := parseBytes(t, out.Bytes(), mat5.LittleEndian)
	s, _, err := tbl.Get("abc", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if s.Int32() != 99 {
		t.Fatalf("padding/small element parse wrong: %d", s.Int32())
	}
}

func TestBadSmallTagsAndTopLevelRejection(t *testing.T) {
	// Small tag with n=5: invalid compact size.
	var bad bytes.Buffer
	order := binary.LittleEndian
	var tmp [4]byte
	order.PutUint32(tmp[:], 1|uint32(5)<<16)
	bad.Write(tmp[:])
	bad.Write(make([]byte, 4))
	expectErrIs(t, bad.Bytes(), mat5.LittleEndian, mat5.ErrBadElement)

	// Small tag with type 14: compact matrix is illegal.
	bad.Reset()
	order.PutUint32(tmp[:], 14|uint32(2)<<16)
	bad.Write(tmp[:])
	bad.Write(make([]byte, 4))
	expectErrIs(t, bad.Bytes(), mat5.LittleEndian, mat5.ErrBadType)

	// Unknown normal-looking type 99.
	bad.Reset()
	order.PutUint32(tmp[:], 99)
	bad.Write(tmp[:])
	order.PutUint32(tmp[:], 0)
	bad.Write(tmp[:])
	// Type 99 is not a normal type, so it is decoded as a compact tag whose
	// size word is zero; the size check fails first.
	expectErrIs(t, bad.Bytes(), mat5.LittleEndian, mat5.ErrBadElement)
}

func TestInflatedProvenanceLogicalOffsets(t *testing.T) {
	b := mat5enc.NewBuilder(mat5enc.LittleEndian)
	leaf1 := &mat5enc.Matrix{Class: 12, Dims: []int32{1, 1}, Int32: []int32{1}}
	leaf2 := &mat5enc.Matrix{Class: 12, Dims: []int32{1, 1}, Int32: []int32{2}}
	cell := &mat5enc.Matrix{
		Name: "cc", Class: 1, Dims: []int32{2, 1},
		Children: []*mat5enc.Matrix{leaf1, leaf2},
	}
	if err := b.AddCompressed(cell); err != nil {
		t.Fatal(err)
	}
	tbl := parseBytes(t, b.Bytes(), mat5.LittleEndian)
	v, _ := tbl.Lookup("cc")
	top := v.(*mat5.CellMatrix)
	if !top.Source().Inflated {
		t.Fatal("top cell must be marked inflated")
	}
	child, err := top.At(1)
	if err != nil {
		t.Fatal(err)
	}
	cs := child.Source()
	if !cs.Inflated || cs.Physical != top.Source().Physical {
		t.Fatalf("child physical range must point at compressed element: %+v", cs)
	}
	if cs.Logical.Start <= top.Source().Logical.Start {
		t.Fatalf("child logical offset should advance inside inflated stream: %+v", cs.Logical)
	}
}
