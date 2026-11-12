// Command mat5demo is a dependency-free integration example for the mat5
// parser and its standalone mat5enc fixture. It builds a stream in memory
// (simulating the bytes left after the MAT-file header is removed), parses
// it under both byte orders, and resolves values through variable names, a
// cell index chain and final numeric coordinates.
package main

import (
	"fmt"
	"math"

	"example.org/dataeng/q0300/mat5"
)

func main() {
	limits := mat5.Limits{
		MaxInflatedBytes: 1 << 20,
		MaxMatrixNodes:   64,
		MaxNumericCells:  4096,
		MaxDepth:         8,
	}

	for _, bo := range []mat5.Endian{mat5.LittleEndian, mat5.BigEndian} {
		stream := buildDemoStream(bo)
		tbl, err := mat5.Parse(stream, bo, limits)
		if err != nil {
			panic(err)
		}

		fmt.Printf("== %s stream ==\n", endianName(bo))
		for _, variable := range tbl.Variables() {
			fmt.Printf("variable %-6q class=%-6q source=%+v\n",
				variable.Name, variable.Value.Class(), variable.Value.Source())
		}

		// Direct double access with full numeric coordinates.
		s, _, err := tbl.Get("vals", 1, 1) // column-major offset 3
		if err != nil {
			panic(err)
		}
		fmt.Printf("vals[1,1] raw bits=%#x float=%v\n", s.Real, math.Float64frombits(s.Real))

		// Preserved NaN payload and negative zero.
		s, _, err = tbl.Get("spec", 0, 0)
		if err != nil {
			panic(err)
		}
		fmt.Printf("spec[0,0] real=%#x imag=%#x complex=%t\n", s.Real, s.Imag, s.Complex)

		// Cell chain: top-level cell slot 0, inner cell slot 1, then [0,0].
		s, leaf, err := tbl.Get("grid", 0, 1, 0, 0)
		if err != nil {
			panic(err)
		}
		fmt.Printf("grid[0][1][0,0] int32=%d leafSource=%+v\n", s.Int32(), leaf.Source())

		// Compressed variable provenance stays physical + logical, never fake.
		if v, ok := tbl.Lookup("packed"); ok {
			fmt.Printf("packed source=%+v\n", v.Source())
		}
		fmt.Println()
	}
}

func endianName(bo mat5.Endian) string {
	if bo == mat5.BigEndian {
		return "big-endian"
	}
	return "little-endian"
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
