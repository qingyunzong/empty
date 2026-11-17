package formal_test

import (
	"testing"
	"time"

	"example.org/dlks/formal/q10187"
)

func TestEvaluateNowUsesVirtualClock(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	clock := formal.NewManualClock(start.Add(10 * time.Minute))
	cfg := baseConfig()
	evaluator, err := formal.NewEvaluator(cfg, clock)
	if err != nil {
		t.Fatal(err)
	}
	seed(t, evaluator, start, 10, time.Minute, 100_000, 101)

	result, err := evaluator.EvaluateNow()
	if err != nil {
		t.Fatal(err)
	}
	if !result.At.Equal(clock.Now()) || !result.Firing() {
		t.Fatalf("EvaluateNow at=%s firing=%v", result.At, result.Firing())
	}

	clock.Advance(time.Minute)
	result, err = evaluator.EvaluateNow()
	if err != nil {
		t.Fatal(err)
	}
	if !result.At.Equal(start.Add(11*time.Minute)) || result.DataOK {
		t.Fatalf("advanced evaluation at=%s dataOK=%v", result.At, result.DataOK)
	}
}
