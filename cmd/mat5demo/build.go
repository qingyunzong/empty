package main

import (
	"math"

	"example.org/dataeng/q0300/mat5"
	"example.org/dataeng/q0300/mat5/mat5enc"
)

func buildDemoStream(bo mat5.Endian) []byte {
	enc := mat5enc.NewBuilder(toEncEndian(bo))

	// 2x2 double matrix with a negative zero among the raw bit patterns.
	must(enc.AddMatrix(&mat5enc.Matrix{
		Name:  "vals",
		Class: 6,
		Dims:  []int32{2, 2},
		Real: []uint64{
			math.Float64bits(1.5), math.Float64bits(-2.25),
			math.Float64bits(math.Copysign(0, -1)), math.Float64bits(4),
		},
	}))

	// Complex double carrying a NaN payload.
	must(enc.AddMatrix(&mat5enc.Matrix{
		Name:    "spec",
		Class:   6,
		Complex: true,
		Dims:    []int32{1, 2},
		Real:    []uint64{math.Float64bits(math.NaN()) | 0xABCD, math.Float64bits(7)},
		Imag:    []uint64{math.Float64bits(math.Copysign(0, -1)), math.Float64bits(-7)},
	}))

	// Two-layer cell: outer 1x2, inner cell in slot 0 with two int32 leaves,
	// a double leaf in slot 1. All child names are empty.
	leaf0 := &mat5enc.Matrix{Class: 12, Dims: []int32{1, 1}, Int32: []int32{31}}
	leaf1 := &mat5enc.Matrix{Class: 12, Dims: []int32{1, 1}, Int32: []int32{41}}
	inner := &mat5enc.Matrix{Class: 1, Dims: []int32{2, 1}, Children: []*mat5enc.Matrix{leaf0, leaf1}}
	doubleLeaf := &mat5enc.Matrix{
		Class: 6, Dims: []int32{1, 1}, Real: []uint64{math.Float64bits(9.25)},
	}
	must(enc.AddMatrix(&mat5enc.Matrix{
		Name:     "grid",
		Class:    1,
		Dims:     []int32{1, 2},
		Children: []*mat5enc.Matrix{inner, doubleLeaf},
	}))

	// A compressed variable; its bytes are not padded to an eight-byte
	// boundary, and the next variable could start immediately afterward.
	must(enc.AddCompressed(&mat5enc.Matrix{
		Name:  "packed",
		Class: 12,
		Dims:  []int32{2, 1},
		Int32: []int32{-3, 6},
	}))

	return enc.Bytes()
}

func toEncEndian(bo mat5.Endian) mat5enc.Endian {
	if bo == mat5.BigEndian {
		return mat5enc.BigEndian
	}
	return mat5enc.LittleEndian
}
