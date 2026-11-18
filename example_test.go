package formal_test

import (
	"fmt"

	drf "example.org/dlks/formal/q10086"
)

func ExampleScheduler() {
	scheduler, _ := drf.NewScheduler(drf.Vector{"cpu": 6, "mem": 6})
	_ = scheduler.AddQueue(drf.Queue{ID: "a", Weight: 1})
	_ = scheduler.AddQueue(drf.Queue{ID: "b", Weight: 2})
	_ = scheduler.Submit(drf.Task{
		ID:       "gang",
		QueueID:  "a",
		Demand:   drf.Vector{"cpu": 2, "mem": 1},
		GangSize: 2,
	})
	_ = scheduler.Submit(drf.Task{
		ID:      "single",
		QueueID: "b",
		Demand:  drf.Vector{"cpu": 1, "mem": 1},
	})
	decision, _ := scheduler.Allocate()

	fmt.Println("admitted:", len(decision.Admitted))
	fmt.Println("used:", decision.Used)
	share, _ := scheduler.QueueShare("a")
	fmt.Println("queue a share:", share)
	// Output:
	// admitted: 2
	// used: {cpu=5,mem=3}
	// queue a share: 2/3
}
