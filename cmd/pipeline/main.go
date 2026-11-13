// Command pipeline demonstrates an ingestion pipeline calling the dataeng
// package. Watermarks are supplied explicitly; event processing never
// advances them.
package main

import (
	"fmt"
	"time"

	dataeng "example.org/dataeng13/q0070"
)

type fixedClock struct {
	now time.Time
}

func (c *fixedClock) Now() time.Time {
	return c.now
}

func (c *fixedClock) advance(d time.Duration) {
	c.now = c.now.Add(d)
}

func main() {
	clock := &fixedClock{now: time.Date(2024, time.January, 1, 0, 0, 0, 0, time.UTC)}
	p := dataeng.MustNewProcessor(dataeng.Options{
		WindowSize:      10 * time.Second,
		AllowedLateness: 5 * time.Second,
		Clock:           clock,
	})

	base := time.Unix(0, 0).UTC()
	emit := func(outputs []dataeng.Output) {
		for _, out := range outputs {
			switch out.Kind {
			case dataeng.KindSideOutput:
				fmt.Printf("%-11s key=%s window=%s event=%d reason=%s\n",
					out.Kind, out.Key, out.Window, out.Event.Value, out.Reason)
			default:
				fmt.Printf("%-11s key=%s window=%s value=%d count=%d version=%d\n",
					out.Kind, out.Key, out.Window, out.Value, out.Count, out.Version)
			}
		}
	}

	emit(p.Process(dataeng.Event{Key: "views", Timestamp: base.Add(1 * time.Second), Value: 2}))
	emit(p.Process(dataeng.Event{Key: "views", Timestamp: base.Add(9 * time.Second), Value: 3}))
	emit(p.AdvanceWatermark(base.Add(10 * time.Second)))

	clock.advance(time.Minute)
	emit(p.Process(dataeng.Event{Key: "views", Timestamp: base.Add(3 * time.Second), Value: 4}))

	emit(p.AdvanceWatermark(base.Add(15 * time.Second)))
	clock.advance(time.Minute)
	emit(p.Process(dataeng.Event{Key: "views", Timestamp: base.Add(4 * time.Second), Value: 9}))
}
