package formal_test

import (
	"fmt"
	"time"

	"example.org/dlks/formal/q10187"
)

func ExampleEvaluator() {
	start := time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)
	clock := formal.NewManualClock(start.Add(10 * time.Minute))
	evaluator, err := formal.NewEvaluator(formal.Config{
		BucketWidth:      time.Minute,
		ShortWindow:      5 * time.Minute,
		LongWindow:       10 * time.Minute,
		FireThreshold:    1,
		RecoverThreshold: 0.5,
		MinCoverage:      1,
		Targets:          formal.FixedTarget(0.999),
	}, clock)
	if err != nil {
		panic(err)
	}

	for i := 0; i < 10; i++ {
		_, _ = evaluator.Ingest(formal.Bucket{
			Start:  start.Add(time.Duration(i) * time.Minute),
			Total:  100_000,
			Errors: 101,
		})
	}
	result, err := evaluator.EvaluateNow()
	if err != nil {
		panic(err)
	}
	fmt.Printf("firing=%v short=%.2f long=%.2f\n",
		result.Firing(), result.Short.BurnRate, result.Long.BurnRate)
	// Output: firing=true short=1.01 long=1.01
}
