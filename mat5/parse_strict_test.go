package mat5_test

import (
	"bytes"
	"encoding/binary"
	"testing"

	"example.org/dataeng/q0300/mat5"
	"example.org/dataeng/q0300/mat5/mat5enc"
)

func TestEmptyStreamPublishesEmptyTable(t *testing.T) {
	tbl, err := mat5.Parse(nil, mat5.LittleEndian, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(tbl.Variables()) != 0 {
		t.Fatalf("empty input must publish an empty table, got %d vars", len(tbl.Variables()))
	}
}

func TestStrictFlagAndClassRules(t *testing.T) {
	order := binary.LittleEndian
	build := func(classWord uint32, dims []int32) []byte {
		var body bytes.Buffer
		putElem := func(typ uint32, payload []byte) {
			var tmp [4]byte
			order.PutUint32(tmp[:], typ)
			body.Write(tmp[:])
			order.PutUint32(tmp[:], uint32(len(payload)))
			body.Write(tmp[:])
			body.Write(payload)
			body.Write(make([]byte, (8-(len(payload)%8))%8))
		}
		flags := make([]byte, 8)
		order.PutUint32(flags[0:], classWord)
		putElem(6, flags)
		dimBytes := make([]byte, 4*len(dims))
		for i, d := range dims {
			order.PutUint32(dimBytes[i*4:], uint32(d))
		}
		putElem(5, dimBytes)
		putElem(1, []byte("x"))

		var out bytes.Buffer
		var hdr [4]byte
		order.PutUint32(hdr[:], 14)
		out.Write(hdr[:])
		order.PutUint32(hdr[:], uint32(body.Len()))
		out.Write(hdr[:])
		out.Write(body.Bytes())
		return out.Bytes()
	}

	// Unsupported class 2.
	expectErrIs(t, build(2, []int32{1, 1}), mat5.LittleEndian, mat5.ErrClass)
	// Reserved flag bits outside class byte and complex bit.
	expectErrIs(t, build(6|0x10000, []int32{1, 1}), mat5.LittleEndian, mat5.ErrBadElement)
	// Complex on an int32 class.
	expectErrIs(t, build(12|0x800, []int32{1, 1}), mat5.LittleEndian, mat5.ErrClass)
	// Second flags word nonzero.
	raw := build(6, []int32{1, 1})
	// Flags payload begins after matrix header (8) + element header (8).
	raw[20] = 1
	expectErrIs(t, raw, mat5.LittleEndian, mat5.ErrBadElement)
}

func TestTruncatedAndTopLevelRules(t *testing.T) {
	// Half of a header.
	expectErrIs(t, []byte{14, 0}, mat5.LittleEndian, mat5.ErrTruncated)

	// A normal numeric element is not allowed as a top-level variable.
	var out bytes.Buffer
	order := binary.LittleEndian
	var tmp [4]byte
	order.PutUint32(tmp[:], 9)
	out.Write(tmp[:])
	order.PutUint32(tmp[:], 0)
	out.Write(tmp[:])
	expectErrIs(t, out.Bytes(), mat5.LittleEndian, mat5.ErrBadType)
}

func TestZeroLimitRejected(t *testing.T) {
	lim := mat5.Limits{MaxInflatedBytes: 0, MaxMatrixNodes: 1, MaxNumericCells: 1, MaxDepth: 1}
	if _, err := mat5.Parse(nil, mat5.LittleEndian, lim); err == nil {
		t.Fatal("zero inflated-byte limit must be rejected")
	}
}

func TestCumulativeInflateBudget(t *testing.T) {
	enc := mat5enc.NewBuilder(mat5enc.LittleEndian)
	for _, name := range []string{"aa", "bb"} {
		if err := enc.AddCompressed(&mat5enc.Matrix{
			Name: name, Class: 12, Dims: []int32{2, 1}, Int32: []int32{1, 2},
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Each inflated matrix is roughly 60+ bytes; a 64-byte cap covers neither
	// two full streams and must trip during the second one.
	lim := mat5.Limits{
		MaxInflatedBytes: 64,
		MaxMatrixNodes:   16,
		MaxNumericCells:  16,
		MaxDepth:         4,
	}
	if _, err := mat5.Parse(enc.Bytes(), mat5.LittleEndian, lim); err == nil {
		t.Fatal("cumulative inflated-byte budget must be enforced")
	}
}
