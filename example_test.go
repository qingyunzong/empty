package formal_test

import (
	"context"
	"fmt"
	"os"

	formal "example.org/dlks/formal/q10085"
)

func ExampleCoordinator() {
	dir, err := os.MkdirTemp("", "formal-example-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)

	sink := formal.NewMemorySink()
	coordinator, err := formal.Open(dir, formal.WithSink(sink))
	if err != nil {
		panic(err)
	}
	defer coordinator.Close()

	ctx := context.Background()
	tx, err := coordinator.Begin(ctx, "txn-1")
	if err != nil {
		panic(err)
	}
	if err := tx.Append(
		formal.Record{ID: "r1", Data: []byte("one")},
		formal.Record{ID: "r2", Data: []byte("two")},
	); err != nil {
		panic(err)
	}
	if _, err := tx.Prepare(ctx); err != nil {
		panic(err)
	}

	// Prepare is durable but not visible.
	fmt.Println(len(coordinator.InFlight()), len(coordinator.CommittedRecords()), sink.Len())

	receipt, err := tx.Commit(ctx)
	if err != nil {
		panic(err)
	}
	fmt.Println(receipt.State, len(coordinator.CommittedRecords()), sink.Len())
	// Output:
	// 1 0 0
	// committed 2 1
}
