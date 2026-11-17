package formal_test

import (
	"fmt"

	"example.org/dlks/formal/q10190"
)

func ExampleEngine() {
	engine, err := formal.New(formal.Config{
		Alpha: 0.05,
		Metrics: []formal.MetricSpec{{
			Name:             "success",
			Kind:             formal.KindProportion,
			Direction:        formal.HigherIsBetter,
			MinSamplesPerArm: 20,
		}},
		TrafficSteps: []float64{1, 5, 10},
	})
	if err != nil {
		panic(err)
	}

	var batch []formal.Observation
	for i := 0; i < 60; i++ {
		batch = append(batch,
			formal.Observation{Metric: "success", Arm: formal.Control, Value: 1, ID: fmt.Sprintf("c-%d", i)},
			formal.Observation{Metric: "success", Arm: formal.Treatment, Value: 0, ID: fmt.Sprintf("t-%d", i)},
		)
	}
	if err := engine.Backfill(batch...); err != nil {
		panic(err)
	}

	decision := engine.Evaluate()
	fmt.Println(decision.Action)
	if err := engine.Execute(decision.Action); err != nil {
		panic(err)
	}
	fmt.Println(engine.TrafficPercent())

	// Output:
	// rollback
	// 0
}
