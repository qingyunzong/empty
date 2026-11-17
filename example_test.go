package formal_test

import (
	"fmt"

	"example.org/dlks/formal/q10182"
)

func ExampleCoordinator() {
	c, err := formal.New([]formal.MemberID{"worker-0", "worker-1"})
	if err != nil {
		panic(err)
	}

	for _, member := range []formal.MemberID{"worker-0", "worker-1"} {
		if err := c.SubmitGradient(formal.Gradient{
			Member:     member,
			Generation: 1,
			Step:       0,
		}); err != nil {
			panic(err)
		}
	}

	id, err := c.CreateCheckpoint()
	if err != nil {
		panic(err)
	}
	for _, member := range []formal.MemberID{"worker-0", "worker-1"} {
		if err := c.ConfirmCheckpoint(formal.CheckpointAck{
			ID:         id,
			Member:     member,
			Generation: 1,
		}); err != nil {
			panic(err)
		}
	}

	checkpoint, visible := c.Checkpoint(id)
	status := c.Status()
	fmt.Println(visible, checkpoint.Generation, checkpoint.Step, status.Step, len(checkpoint.ConfirmedBy))
	// Output: true 1 0 1 2
}
