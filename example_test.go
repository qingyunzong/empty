package dataeng_test

import (
	"fmt"

	"example.org/dataeng/q0203"
)

func ExamplePlanDeletes() {
	dataFiles := []dataeng.DataFile{
		{Path: "s3://warehouse/data/a.parquet", SequenceNumber: 7},
	}
	deleteFiles := []dataeng.DeleteFile{
		{
			Path:           "s3://warehouse/delete/d1.parquet",
			SequenceNumber: 8,
			Records: []dataeng.PositionDelete{
				{FilePath: "s3://warehouse/data/a.parquet", Position: 3},
				{FilePath: "s3://warehouse/data/a.parquet", Position: 4},
				{FilePath: "s3://warehouse/data/a.parquet", Position: 9},
			},
		},
	}

	plan, err := dataeng.PlanDeletes(dataFiles, deleteFiles)
	if err != nil {
		panic(err)
	}
	for _, file := range plan.Files {
		fmt.Print(file.Path)
		for _, interval := range file.Intervals {
			fmt.Printf(" [%d,%d)", interval.Start, interval.End)
		}
		fmt.Println()
	}
	// Output:
	// s3://warehouse/data/a.parquet [3,5) [9,10)
}
