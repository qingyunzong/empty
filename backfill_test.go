package formal_test

import (
	"errors"
	"math/rand"
	"testing"

	"example.org/dlks/formal/q10190"
)

func successConfig(minSamples int) formal.Config {
	return baseConfig(formal.MetricSpec{
		Name:             "success",
		Kind:             formal.KindProportion,
		Direction:        formal.HigherIsBetter,
		MinSamplesPerArm: minSamples,
	})
}

func TestBackfillRecomputesBeforeExecution(t *testing.T) {
	engine := mustEngine(t, successConfig(50))
	r := rand.New(rand.NewSource(71))
	control := bernoulli(r, 0.90, 100)
	treatment := bernoulli(r, 0.20, 100)
	ingestRange(t, engine, "success", formal.Control, "c", control, 0, 100)
	ingestRange(t, engine, "success", formal.Treatment, "t", treatment, 0, 100)

	decision := engine.Evaluate()
	if decision.Action != formal.Rollback {
		t.Fatalf("initial action = %s, want rollback", decision.Action)
	}

	revisedControl := make([]float64, 100)
	revisedTreatment := make([]float64, 100)
	for i := range revisedControl {
		revisedTreatment[i] = 1
	}
	ingestRange(t, engine, "success", formal.Control, "c", revisedControl, 0, 100)
	ingestRange(t, engine, "success", formal.Treatment, "t", revisedTreatment, 0, 100)

	decision = engine.Evaluate()
	if decision.Action != formal.ScaleUp {
		t.Fatalf("after corrected backfill: action=%s (%s), want scale_up", decision.Action, decision.Reason)
	}
	if decision.Locked || engine.RollbackExecuted() {
		t.Fatal("unexecuted rollback must not lock the controller")
	}
	result := metricResult(t, decision, "success")
	if result.ControlMean != 0 || result.TreatmentMean != 1 {
		t.Fatalf("backfill was not reflected: control=%v treatment=%v", result.ControlMean, result.TreatmentMean)
	}
	if result.ControlN != 100 || result.TreatmentN != 100 {
		t.Fatalf("upsert changed sample counts: %d/%d, want 100/100", result.ControlN, result.TreatmentN)
	}
}

func TestBackfillCannotUndoExecutedRollback(t *testing.T) {
	engine := mustEngine(t, successConfig(50))
	r := rand.New(rand.NewSource(73))
	control := bernoulli(r, 0.90, 100)
	treatment := bernoulli(r, 0.20, 100)
	ingestRange(t, engine, "success", formal.Control, "c", control, 0, 100)
	ingestRange(t, engine, "success", formal.Treatment, "t", treatment, 0, 100)

	decision := engine.Evaluate()
	if decision.Action != formal.Rollback {
		t.Fatalf("initial action = %s, want rollback", decision.Action)
	}
	if err := engine.Execute(formal.Rollback); err != nil {
		t.Fatalf("Execute(rollback): %v", err)
	}
	rollbackLook, ok := engine.RollbackLook()
	if !ok || rollbackLook != 1 {
		t.Fatalf("rollback look = %d/%v, want 1/true", rollbackLook, ok)
	}

	revisedControl := make([]float64, 100)
	revisedTreatment := make([]float64, 100)
	for i := range revisedControl {
		revisedTreatment[i] = 1
	}
	ingestRange(t, engine, "success", formal.Control, "c", revisedControl, 0, 100)
	ingestRange(t, engine, "success", formal.Treatment, "t", revisedTreatment, 0, 100)

	decision = engine.Evaluate()
	if decision.Action != formal.Rollback || !decision.Locked || !decision.Final {
		t.Fatalf("after backfill: %+v, want locked final rollback", decision)
	}
	if !contains(decision.HelpfulMetrics, "success") {
		t.Fatalf("statistics were not recomputed after backfill: helpful=%v", decision.HelpfulMetrics)
	}
	result := metricResult(t, decision, "success")
	if result.ControlMean != 0 || result.TreatmentMean != 1 {
		t.Fatalf("backfill was not reflected: control=%v treatment=%v", result.ControlMean, result.TreatmentMean)
	}
	if result.Look != 1 {
		t.Fatalf("locked recomputation consumed a new look: got %d, want 1", result.Look)
	}

	if err := engine.Execute(formal.ScaleUp); !errors.Is(err, formal.ErrRollbackLocked) {
		t.Fatalf("Execute(ScaleUp) after rollback = %v, want ErrRollbackLocked", err)
	}
	if got := engine.TrafficPercent(); got != 0 {
		t.Fatalf("traffic after locked rollback = %v, want 0", got)
	}
}

func TestUpsertAndLateArrival(t *testing.T) {
	cfg := baseConfig(formal.MetricSpec{
		Name:             "latency",
		Kind:             formal.KindContinuous,
		Direction:        formal.LowerIsBetter,
		MinSamplesPerArm: 2,
	})
	engine := mustEngine(t, cfg)
	batch := []formal.Observation{
		{Metric: "latency", Arm: formal.Control, Value: 10, ID: "c1"},
		{Metric: "latency", Arm: formal.Control, Value: 20, ID: "c2"},
		{Metric: "latency", Arm: formal.Treatment, Value: 11, ID: "t1"},
		{Metric: "latency", Arm: formal.Treatment, Value: 21, ID: "t2"},
	}
	if err := engine.AddBatch(batch); err != nil {
		t.Fatalf("AddBatch: %v", err)
	}
	if err := engine.Add(formal.Observation{Metric: "latency", Arm: formal.Control, Value: 100, ID: "c1"}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	controlN, treatmentN, err := engine.Samples("latency")
	if err != nil || controlN != 2 || treatmentN != 2 {
		t.Fatalf("samples = %d/%d err=%v, want 2/2", controlN, treatmentN, err)
	}
	decision := engine.Evaluate()
	result := metricResult(t, decision, "latency")
	if result.ControlMean != 60 {
		t.Fatalf("control mean = %v, want 60 after replacing c1", result.ControlMean)
	}

	late := []formal.Observation{
		{Metric: "latency", Arm: formal.Control, Value: 30, ID: "c3"},
		{Metric: "latency", Arm: formal.Treatment, Value: 31, ID: "t3"},
	}
	if err := engine.Backfill(late...); err != nil {
		t.Fatalf("Backfill: %v", err)
	}
	controlN, treatmentN, _ = engine.Samples("latency")
	if controlN != 3 || treatmentN != 3 {
		t.Fatalf("samples after late arrival = %d/%d, want 3/3", controlN, treatmentN)
	}
}

func TestUpsertRejectsArmChangeAndInvalidValues(t *testing.T) {
	engine := mustEngine(t, successConfig(10))
	if err := engine.Add(formal.Observation{Metric: "success", Arm: formal.Control, Value: 1, ID: "x"}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := engine.Add(formal.Observation{Metric: "success", Arm: formal.Treatment, Value: 1, ID: "x"}); !errors.Is(err, formal.ErrInvalidArm) {
		t.Fatalf("arm change error = %v, want ErrInvalidArm", err)
	}
	if err := engine.Add(formal.Observation{Metric: "success", Arm: formal.Control, Value: 0.5, ID: "y"}); !errors.Is(err, formal.ErrInvalidValue) {
		t.Fatalf("proportion validation = %v, want ErrInvalidValue", err)
	}
	if err := engine.Add(formal.Observation{Metric: "missing", Arm: formal.Control, Value: 1}); !errors.Is(err, formal.ErrUnknownMetric) {
		t.Fatalf("unknown metric error = %v, want ErrUnknownMetric", err)
	}
}

func TestAddBatchIsAtomic(t *testing.T) {
	engine := mustEngine(t, successConfig(10))
	batch := []formal.Observation{
		{Metric: "success", Arm: formal.Control, Value: 1, ID: "ok"},
		{Metric: "success", Arm: formal.Treatment, Value: 0.25, ID: "bad"},
	}
	if err := engine.AddBatch(batch); !errors.Is(err, formal.ErrInvalidValue) {
		t.Fatalf("AddBatch error = %v, want ErrInvalidValue", err)
	}
	controlN, treatmentN, _ := engine.Samples("success")
	if controlN != 0 || treatmentN != 0 {
		t.Fatalf("partial batch applied: %d/%d", controlN, treatmentN)
	}
}

func TestDuplicateIDInBatchIsLastWriteWins(t *testing.T) {
	cfg := baseConfig(formal.MetricSpec{
		Name:             "latency",
		Kind:             formal.KindContinuous,
		Direction:        formal.LowerIsBetter,
		MinSamplesPerArm: 2,
	})
	engine := mustEngine(t, cfg)
	batch := []formal.Observation{
		{Metric: "latency", Arm: formal.Control, Value: 10, ID: "c1"},
		{Metric: "latency", Arm: formal.Control, Value: 50, ID: "c1"},
		{Metric: "latency", Arm: formal.Control, Value: 20, ID: "c2"},
		{Metric: "latency", Arm: formal.Treatment, Value: 30, ID: "t1"},
		{Metric: "latency", Arm: formal.Treatment, Value: 40, ID: "t2"},
	}
	if err := engine.AddBatch(batch); err != nil {
		t.Fatalf("AddBatch: %v", err)
	}
	controlN, _, _ := engine.Samples("latency")
	if controlN != 2 {
		t.Fatalf("control samples = %d, want 2", controlN)
	}
	result := metricResult(t, engine.Evaluate(), "latency")
	if result.ControlMean != 35 {
		t.Fatalf("control mean = %v, want (50+20)/2 = 35", result.ControlMean)
	}
}
