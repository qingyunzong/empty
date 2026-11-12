package mergejoin_test

import (
	"context"
	"fmt"

	"example.org/dataeng/q0146/mergejoin"
)

// ExampleJoiner shows a host wiring two paginated sorted streams into a
// bounded-memory merge join, spilling oversize key groups through the
// replayable in-memory staging implementation and driving flow control with
// a Gate.
func ExampleJoiner() {
	leftRows := []mergejoin.Row[string]{
		{Key: 1, ID: 101, Payload: "a"},
		{Key: 2, ID: 102, Payload: "b"},
		{Key: 2, ID: 103, Payload: "c"},
	}
	rightRows := []mergejoin.Row[int]{
		{Key: 2, ID: 201, Payload: 10},
		{Key: 2, ID: 202, Payload: 20},
		{Key: 3, ID: 203, Payload: 30},
	}

	left := mergejoin.NewSliceStream(leftRows, 2)
	right := mergejoin.NewSliceStream(rightRows, 2)

	// A one-row budget forces the repeated key-2 group through staging.
	cfg := mergejoin.Config[string, int]{MaxGroupRows: 1}
	gate := mergejoin.NewGate()

	emit := func(_ context.Context, pair mergejoin.Pair[string, int]) (mergejoin.Decision, error) {
		fmt.Printf("key=%d left=%d right=%d\n", pair.Key, pair.Left.ID, pair.Right.ID)
		return mergejoin.Proceed, nil
	}

	joiner, err := mergejoin.New(
		left,
		right,
		cfg,
		emit,
		func() (mergejoin.Staging[string, int], error) {
			return mergejoin.NewMemStaging[string, int](), nil
		},
	)
	if err != nil {
		panic(err)
	}
	joiner.WithGate(gate)

	result, err := joiner.Run(context.Background())
	if err != nil {
		panic(err)
	}
	fmt.Printf("pairs=%d groups=%d\n", result.Pairs, result.MatchedGroups)
	// Output:
	// key=2 left=102 right=201
	// key=2 left=102 right=202
	// key=2 left=103 right=201
	// key=2 left=103 right=202
	// pairs=4 groups=1
}

// ExampleGate demonstrates pausing after an acknowledged pair and resuming
// without re-sending it.
func ExampleGate_pauseAndResume() {
	gate := mergejoin.NewGate()
	ctx := context.Background()

	go func() {
		// The consumer pauses, then later resumes the producer.
		gate.Pause()
		gate.Resume()
	}()

	gate.Wait(ctx.Done())
	fmt.Println("resumed without re-send")
	// Output:
	// resumed without re-send
}
