package formal_test

import (
	"math"
	"testing"
	"time"

	"example.org/dlks/formal/q10187"
)

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return parsed
}

func baseConfig() formal.Config {
	return formal.Config{
		BucketWidth:      time.Minute,
		ShortWindow:      5 * time.Minute,
		LongWindow:       10 * time.Minute,
		FireThreshold:    1,
		RecoverThreshold: 0.5,
		MinCoverage:      1,
		Targets:          formal.FixedTarget(0.999),
	}
}

func newEvaluator(t *testing.T, cfg formal.Config) *formal.Evaluator {
	t.Helper()
	evaluator, err := formal.NewEvaluator(cfg, nil)
	if err != nil {
		t.Fatalf("new evaluator: %v", err)
	}
	return evaluator
}

func seed(t *testing.T, evaluator *formal.Evaluator, from time.Time, count int, width time.Duration, total, errors int64) {
	t.Helper()
	for i := 0; i < count; i++ {
		bucket := formal.Bucket{
			Start:  from.Add(time.Duration(i) * width),
			Total:  total,
			Errors: errors,
		}
		if _, err := evaluator.Ingest(bucket); err != nil {
			t.Fatalf("ingest bucket %d: %v", i, err)
		}
	}
}

func put(t *testing.T, evaluator *formal.Evaluator, start time.Time, total, errors int64) {
	t.Helper()
	if _, err := evaluator.Ingest(formal.Bucket{Start: start, Total: total, Errors: errors}); err != nil {
		t.Fatalf("put bucket %s: %v", start, err)
	}
}

func evaluate(t *testing.T, evaluator *formal.Evaluator, at time.Time) formal.Result {
	t.Helper()
	result, err := evaluator.Evaluate(at)
	if err != nil {
		t.Fatalf("evaluate %s: %v", at, err)
	}
	return result
}

func requireFloat(t *testing.T, label string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-12*math.Max(1, math.Abs(want)) {
		t.Fatalf("%s = %.15g, want %.15g", label, got, want)
	}
}
