package dataeng_test

import (
	"context"
	"fmt"

	"example.org/dataeng/q0139"
)

func Example() {
	ctx := context.Background()
	store := dataeng.NewMemoryStore()
	writer := dataeng.NewWriter(store, "warehouse/events")

	version, err := writer.WriteBatch(ctx, []dataeng.Input{
		{Path: "part-0001", Data: []byte("first")},
		{Path: "part-0002", Data: []byte("second")},
	})
	if err != nil {
		panic(err)
	}

	reader := dataeng.NewReader(store, "warehouse/events")
	snapshot, err := reader.Open(ctx)
	if err != nil {
		panic(err)
	}
	data, err := reader.Read(ctx, "part-0002")
	if err != nil {
		panic(err)
	}

	fmt.Println(version.Generation, len(snapshot.Files), string(data))
	// Output: 1 2 second
}
