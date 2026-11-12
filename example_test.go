package dataeng_test

import (
	"fmt"
	"log"

	dataeng "example.org/dataeng/q0058"
)

func Example() {
	schema := dataeng.Schema{Columns: map[string]dataeng.ColumnType{
		"id":  dataeng.TypeInt64,
		"tag": dataeng.TypeString,
	}}

	expr, err := dataeng.Compile(schema, "id < 100 AND NOT tag IS NULL")
	if err != nil {
		log.Fatal(err)
	}

	batch := &dataeng.Batch{
		RowCount: 3,
		Columns: map[string]any{
			"id":  &dataeng.Int64Column{Dict: []int64{7, 200, 50}, Values: []int32{0, 1, -1}},
			"tag": &dataeng.StringColumn{Dict: []string{"a", "b"}, Values: []int32{0, -1, 1}},
		},
	}
	bitmap, err := expr.Evaluate(batch)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(bitmap.SelectedRows())
	// Output: [0]
}
