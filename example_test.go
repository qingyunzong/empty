package formal

import (
	"fmt"
	"time"
)

func ExampleCoordinator() {
	coordinator, err := New(Config{GenerationTimeout: 10 * time.Second})
	if err != nil {
		panic(err)
	}

	now := time.Unix(0, 0).UTC()
	if err := coordinator.Join("worker-b", now); err != nil {
		panic(err)
	}
	if err := coordinator.Join("worker-a", now.Add(time.Second)); err != nil {
		panic(err)
	}

	generation, ok := coordinator.Current()
	if !ok {
		panic("no generation")
	}
	for _, member := range generation.Members {
		fmt.Printf("%s=%d\n", member.ID, member.Rank)
	}

	if err := coordinator.Ack("worker-a", generation.Number, now.Add(2*time.Second)); err != nil {
		panic(err)
	}
	if err := coordinator.Ack("worker-b", generation.Number, now.Add(3*time.Second)); err != nil {
		panic(err)
	}

	generation, _ = coordinator.Current()
	fmt.Printf("generation=%d state=%s\n", generation.Number, generation.State)

	// Output:
	// worker-a=0
	// worker-b=1
	// generation=2 state=committed
}
