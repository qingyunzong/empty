package delivery_test

import (
	"context"
	"errors"
	"fmt"

	"example.org/dataeng/q0247/delivery"
)

func Example() {
	ctx := context.Background()
	store := delivery.NewMemoryStore()

	// Rebuilt from the durable store after a process restart.
	tracker, err := delivery.NewTracker(ctx, store)
	if err != nil {
		panic(err)
	}
	// Each link attach opens a fresh generation.
	epoch, _ := tracker.BeginGeneration(ctx)

	// A transfer arrives on the link.
	in, err := tracker.Incoming(ctx, delivery.NewTag([]byte("order-42")), 1)
	if err != nil {
		panic(err)
	}

	// Business data is written exactly once; accepted follows the commit.
	rec, err := tracker.Commit(ctx, in.Record.Tag, func(_ context.Context, _ delivery.Record) error {
		fmt.Println("payload written once")
		return nil
	})
	if err != nil {
		panic(err)
	}
	fmt.Printf("committed=%v outcome=%s settled=%v\n", rec.Committed, rec.Outcome, rec.Settled)

	// The peer settles on the current generation; a stale epoch is fenced.
	if _, err := tracker.Disposition(ctx, epoch, rec.Tag, delivery.OutcomeAccepted, true); err != nil {
		panic(err)
	}
	if _, err := tracker.Disposition(ctx, epoch-1, rec.Tag, delivery.OutcomeModified, true); !errors.Is(err, delivery.ErrStaleGeneration) {
		panic("stale disposition must be rejected")
	}

	unsettled, _ := tracker.Reconcile(ctx)
	fmt.Printf("unsettled=%d\n", len(unsettled))
	// Output:
	// payload written once
	// committed=true outcome=accepted settled=false
	// unsettled=0
}
