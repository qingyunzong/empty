package formal_test

import (
	"context"
	"fmt"

	"example.org/dlks/formal/q10157"
)

func ExampleCoordinator() {
	ctx := context.Background()
	store := formal.NewMemStore()

	base := store.Begin()
	if err := base.Put("a", "1"); err != nil {
		panic(err)
	}
	if _, err := base.Commit(ctx); err != nil {
		panic(err)
	}

	// This transaction begins before the snapshot and commits after it.
	crossing := store.Begin()
	if err := crossing.Put("b", "2"); err != nil {
		panic(err)
	}

	index := formal.NewMemIndex()
	c, err := formal.New(formal.Config{
		Snapshots: store,
		Log:       store,
		Index:     index,
		Audit:     formal.SnapshotAuditor{Source: store},
	})
	if err != nil {
		panic(err)
	}
	if err := c.Scan(ctx); err != nil {
		panic(err)
	}
	if _, err := crossing.Commit(ctx); err != nil {
		panic(err)
	}

	cert, err := c.Seal(ctx)
	if err != nil {
		panic(err)
	}
	if err := c.Publish(ctx, cert); err != nil {
		panic(err)
	}

	fmt.Println(c.State(), index.Len(), cert.Verified())
	// Output: visible 2 true
}
