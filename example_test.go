package dataeng_test

import (
	"bytes"
	"fmt"

	"example.org/dataeng/q0323"
	"example.org/dataeng/q0323/fixture"
)

// This is the host integration shape: locate the cell out-of-band, pass an
// immutable ReaderAt plus page geometry, then request column occurrences by
// zero-based index.
func ExampleProject() {
	payload, err := fixture.BuildPayload([]fixture.Column{
		fixture.BlobColumn([]byte("visible")),
		fixture.BlobColumn(make([]byte, 600)),
	})
	if err != nil {
		panic(err)
	}
	cell, err := fixture.BuildCell(
		fixture.Layout{
			PageSize:      512,
			ReservedBytes: 32,
			CellPage:      1,
			CellOffset:    16,
		},
		42,
		payload.Bytes,
		fixture.Options{},
	)
	if err != nil {
		panic(err)
	}

	config := dataeng.Config{
		PageSize:             512,
		ReservedBytes:        32,
		PageCount:            cell.TotalPages,
		HeaderByteBudget:     256,
		ChainPageBudget:      64,
		ProjectionByteBudget: 4096,
	}
	// bytes.Reader is only one host adapter; any immutable io.ReaderAt works.
	result, err := dataeng.Project(bytes.NewReader(cell.File), config, cell.Ref(), []int{0, 1, 0})
	if err != nil {
		panic(err)
	}

	fmt.Printf("rowid=%d local=%d overflow-pages=%d values=%q/%d-bytes/%q\n",
		result.RowID, result.LocalLength, len(result.OverflowPages),
		result.Columns[0].Blob, len(result.Columns[1].Blob), result.Columns[2].Blob)
	// Output:
	// rowid=42 local=135 overflow-pages=1 values="visible"/600-bytes/"visible"
}
