package formal_test

import (
	"fmt"
	"time"

	formal "example.org/dlks/formal/q10056"
)

func ExampleScheduler() {
	base := time.Unix(0, 0).UTC()
	clock := formal.NewManualClock(base)
	scheduler, err := formal.New(clock, formal.Config{
		Tick:      time.Millisecond,
		WheelSize: 8,
		MaxLevels: 4,
	})
	if err != nil {
		panic(err)
	}

	_ = scheduler.ScheduleAt("later", base.Add(30*time.Millisecond), 2)
	_ = scheduler.ScheduleAt("first", base.Add(10*time.Millisecond), 1)
	_ = scheduler.ScheduleAt("cancelled", base.Add(20*time.Millisecond), 3)
	scheduler.Cancel("cancelled")

	clock.Advance(30 * time.Millisecond)
	for _, event := range scheduler.Poll() {
		fmt.Println(event.ID, event.Payload)
	}

	// Output:
	// first 1
	// later 2
}
