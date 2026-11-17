package formal_test

import (
	"errors"
	"testing"
	"time"

	"example.org/dlks/formal/q10187"
)

func TestTriggerRequiresBothWindowsAndStrictBoundary(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	at := start.Add(10 * time.Minute)

	// The short window is over 1.0 but the long window is not.
	evaluator := newEvaluator(t, baseConfig())
	seed(t, evaluator, start, 5, time.Minute, 100_000, 0)
	seed(t, evaluator, start.Add(5*time.Minute), 5, time.Minute, 100_000, 101)

	result := evaluate(t, evaluator, at)
	requireFloat(t, "short burn", result.Short.BurnRate, 1.01)
	requireFloat(t, "long burn", result.Long.BurnRate, 0.505)
	if result.Firing() || result.Transition != formal.TransitionNone {
		t.Fatalf("short-only breach fired: state=%s transition=%s", result.State, result.Transition)
	}

	// Backfilling the older half pushes the long window over too.
	for i := 0; i < 5; i++ {
		put(t, evaluator, start.Add(time.Duration(i)*time.Minute), 100_000, 101)
	}
	result = evaluate(t, evaluator, at)
	requireFloat(t, "long burn after backfill", result.Long.BurnRate, 1.01)
	if !result.Firing() || result.Transition != formal.TransitionFired {
		t.Fatalf("pair breach did not fire: state=%s transition=%s", result.State, result.Transition)
	}

	// A burn rate exactly at the threshold is not a fire.
	boundary := newEvaluator(t, baseConfig())
	seed(t, boundary, start, 10, time.Minute, 100_000, 100)
	result = evaluate(t, boundary, at)
	requireFloat(t, "boundary short burn", result.Short.BurnRate, 1)
	requireFloat(t, "boundary long burn", result.Long.BurnRate, 1)
	if result.Firing() {
		t.Fatal("burn rate exactly at fire threshold must not fire")
	}

	// One additional error in every bucket crosses the boundary.
	oneMore := newEvaluator(t, baseConfig())
	seed(t, oneMore, start, 10, time.Minute, 100_000, 101)
	result = evaluate(t, oneMore, at)
	requireFloat(t, "over-boundary short burn", result.Short.BurnRate, 1.01)
	if !result.Firing() {
		t.Fatal("burn rate above fire threshold did not fire")
	}
}

func TestOneWindowExactlyAtThresholdDoesNotFire(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	at := start.Add(10 * time.Minute)
	evaluator := newEvaluator(t, baseConfig())

	// Long window burn is exactly 1.0; short window is 2.0.
	seed(t, evaluator, start, 5, time.Minute, 100_000, 0)
	seed(t, evaluator, start.Add(5*time.Minute), 5, time.Minute, 100_000, 200)
	result := evaluate(t, evaluator, at)
	requireFloat(t, "short burn", result.Short.BurnRate, 2)
	requireFloat(t, "long burn", result.Long.BurnRate, 1)
	if result.Firing() {
		t.Fatal("pair with one window exactly at the threshold fired")
	}
}

func TestHysteresisUsesAgingWindows(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	evaluator := newEvaluator(t, baseConfig())

	seed(t, evaluator, start, 10, time.Minute, 100_000, 101)
	result := evaluate(t, evaluator, start.Add(10*time.Minute))
	if !result.Firing() {
		t.Fatal("expected firing")
	}

	// Healthy buckets enter the short window, but the long window still
	// contains five high-burn buckets: the pair is in the hysteresis band.
	seed(t, evaluator, start.Add(10*time.Minute), 5, time.Minute, 100_000, 40)
	result = evaluate(t, evaluator, start.Add(15*time.Minute))
	requireFloat(t, "short burn in hysteresis band", result.Short.BurnRate, 0.4)
	requireFloat(t, "long burn in hysteresis band", result.Long.BurnRate, 0.705)
	if !result.Firing() || result.Transition != formal.TransitionNone {
		t.Fatalf("hysteresis band cleared alert: state=%s transition=%s", result.State, result.Transition)
	}

	// Once all high-burn buckets age out, both windows are below the recovery
	// threshold and the alert clears.
	seed(t, evaluator, start.Add(15*time.Minute), 5, time.Minute, 100_000, 40)
	result = evaluate(t, evaluator, start.Add(20*time.Minute))
	requireFloat(t, "short burn recovered", result.Short.BurnRate, 0.4)
	requireFloat(t, "long burn recovered", result.Long.BurnRate, 0.4)
	if result.Firing() || result.Transition != formal.TransitionCleared {
		t.Fatalf("recovery did not clear: state=%s transition=%s", result.State, result.Transition)
	}
}

func TestRecoveryThresholdIsInclusive(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	at := start.Add(10 * time.Minute)
	evaluator := newEvaluator(t, baseConfig())

	seed(t, evaluator, start, 10, time.Minute, 100_000, 101)
	if result := evaluate(t, evaluator, at); !result.Firing() {
		t.Fatal("expected firing")
	}

	// 50 errors per 100k at target 0.999 is exactly the 0.5 recover threshold.
	for minute := 0; minute < 10; minute++ {
		put(t, evaluator, start.Add(time.Duration(minute)*time.Minute), 100_000, 50)
	}
	result := evaluate(t, evaluator, at)
	requireFloat(t, "short recover boundary", result.Short.BurnRate, 0.5)
	requireFloat(t, "long recover boundary", result.Long.BurnRate, 0.5)
	if result.Firing() || result.Transition != formal.TransitionCleared {
		t.Fatalf("inclusive recovery boundary did not clear: state=%s transition=%s",
			result.State, result.Transition)
	}
}

func TestRecoveryDwell(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	cfg := baseConfig()
	cfg.LongWindow = 6 * time.Minute
	cfg.RecoverFor = 2 * time.Minute
	evaluator := newEvaluator(t, cfg)

	seed(t, evaluator, start.Add(4*time.Minute), 6, time.Minute, 100_000, 101)
	if result := evaluate(t, evaluator, start.Add(10*time.Minute)); !result.Firing() {
		t.Fatal("expected firing")
	}
	seed(t, evaluator, start.Add(10*time.Minute), 6, time.Minute, 100_000, 40)

	result := evaluate(t, evaluator, start.Add(16*time.Minute))
	if !result.Firing() || !result.RecoveryPending {
		t.Fatalf("expected pending recovery, got state=%s pending=%v", result.State, result.RecoveryPending)
	}
	if !result.RecoverSince.Equal(start.Add(16 * time.Minute)) {
		t.Fatalf("recover since = %s", result.RecoverSince)
	}
	if result.RecoverRemaining != 2*time.Minute {
		t.Fatalf("remaining = %s, want 2m", result.RecoverRemaining)
	}

	put(t, evaluator, start.Add(16*time.Minute), 100_000, 40)
	result = evaluate(t, evaluator, start.Add(17*time.Minute))
	if !result.Firing() || !result.RecoveryPending || result.RecoverRemaining != time.Minute {
		t.Fatalf("dwell advanced incorrectly: state=%s pending=%v remaining=%s",
			result.State, result.RecoveryPending, result.RecoverRemaining)
	}

	put(t, evaluator, start.Add(17*time.Minute), 100_000, 40)
	result = evaluate(t, evaluator, start.Add(18*time.Minute))
	if result.Firing() || result.Transition != formal.TransitionCleared {
		t.Fatalf("dwell did not clear: state=%s transition=%s", result.State, result.Transition)
	}
}

func TestDataGapHoldsAlertAndResetsRecoveryDwell(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	cfg := baseConfig()
	cfg.LongWindow = 6 * time.Minute
	cfg.RecoverFor = 2 * time.Minute
	evaluator := newEvaluator(t, cfg)

	seed(t, evaluator, start.Add(4*time.Minute), 6, time.Minute, 100_000, 101)
	if result := evaluate(t, evaluator, start.Add(10*time.Minute)); !result.Firing() {
		t.Fatal("expected firing")
	}
	seed(t, evaluator, start.Add(10*time.Minute), 6, time.Minute, 100_000, 40)
	result := evaluate(t, evaluator, start.Add(16*time.Minute))
	if !result.RecoveryPending {
		t.Fatal("expected recovery to be pending")
	}

	// 10:16 and 10:17 are absent, so the newest bucket is stale.
	result = evaluate(t, evaluator, start.Add(18*time.Minute))
	if result.DataOK {
		t.Fatal("expected insufficient data")
	}
	if !result.Firing() || result.RecoveryPending || !result.RecoverSince.IsZero() {
		t.Fatalf("gap should hold firing and reset dwell: state=%s pending=%v since=%s",
			result.State, result.RecoveryPending, result.RecoverSince)
	}

	// Recovery evidence must restart from scratch after the gap.
	put(t, evaluator, start.Add(16*time.Minute), 100_000, 40)
	put(t, evaluator, start.Add(17*time.Minute), 100_000, 40)
	result = evaluate(t, evaluator, start.Add(18*time.Minute))
	if !result.RecoveryPending || !result.RecoverSince.Equal(start.Add(18*time.Minute)) {
		t.Fatalf("dwell did not restart: pending=%v since=%s", result.RecoveryPending, result.RecoverSince)
	}
	put(t, evaluator, start.Add(18*time.Minute), 100_000, 40)
	put(t, evaluator, start.Add(19*time.Minute), 100_000, 40)
	result = evaluate(t, evaluator, start.Add(20*time.Minute))
	if result.Firing() || result.Transition != formal.TransitionCleared {
		t.Fatalf("alert did not clear after fresh dwell: state=%s transition=%s", result.State, result.Transition)
	}
}

func TestMissingAndStaleDataCannotFire(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	cfg := baseConfig()
	cfg.MinCoverage = 0.9
	evaluator := newEvaluator(t, cfg)

	// Coverage is exactly 0.9, but the newest bucket is missing so the window
	// is stale and must not be used.
	seed(t, evaluator, start, 9, time.Minute, 100_000, 101)
	result := evaluate(t, evaluator, start.Add(10*time.Minute))
	requireFloat(t, "coverage without tail", result.Long.Coverage, 0.9)
	if result.Long.Fresh || result.DataOK {
		t.Fatalf("stale window accepted: fresh=%v dataOK=%v", result.Long.Fresh, result.DataOK)
	}
	if result.Firing() {
		t.Fatal("stale data fired")
	}

	put(t, evaluator, start.Add(9*time.Minute), 100_000, 101)
	result = evaluate(t, evaluator, start.Add(10*time.Minute))
	if !result.DataOK || !result.Firing() {
		t.Fatalf("complete data did not fire: dataOK=%v state=%s", result.DataOK, result.State)
	}

	// Losing two tail buckets drops coverage below 0.9. A firing alert holds.
	evaluator.Store().Delete(start.Add(9 * time.Minute))
	evaluator.Store().Delete(start.Add(8 * time.Minute))
	result = evaluate(t, evaluator, start.Add(10*time.Minute))
	if result.DataOK || result.Short.DataOK || result.Long.DataOK {
		t.Fatal("low coverage reported as usable")
	}
	if !result.Firing() || result.Transition != formal.TransitionNone {
		t.Fatalf("gap changed firing state: state=%s transition=%s", result.State, result.Transition)
	}
}

func TestOutOfOrderBackfillRecomputesBudget(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	at := start.Add(10 * time.Minute)
	evaluator := newEvaluator(t, baseConfig())

	// 10:06 and 10:09 are missing. Even though every present bucket is over
	// budget, the pair cannot fire.
	for _, minute := range []int{0, 1, 2, 3, 4, 5, 7, 8} {
		put(t, evaluator, start.Add(time.Duration(minute)*time.Minute), 100_000, 101)
	}
	result := evaluate(t, evaluator, at)
	if result.DataOK || result.Firing() {
		t.Fatalf("incomplete data fired: dataOK=%v state=%s", result.DataOK, result.State)
	}
	beforeRevision := result.Revision

	// A late bucket for 10:06 arrives first, out of order.
	put(t, evaluator, start.Add(6*time.Minute), 100_000, 101)
	result = evaluate(t, evaluator, at)
	if result.Revision <= beforeRevision {
		t.Fatalf("revision did not advance: %d <= %d", result.Revision, beforeRevision)
	}
	if result.DataOK || result.Firing() {
		t.Fatal("alert fired before the tail bucket was backfilled")
	}

	// The tail bucket completes both windows.
	put(t, evaluator, start.Add(9*time.Minute), 100_000, 101)
	result = evaluate(t, evaluator, at)
	if !result.DataOK || !result.Firing() {
		t.Fatalf("backfilled pair did not fire: dataOK=%v state=%s", result.DataOK, result.State)
	}
	requireFloat(t, "short budget consumed", result.Short.BudgetConsumed, 1.01)
	requireFloat(t, "long budget consumed", result.Long.BudgetConsumed, 1.01)

	// A correction to the newest bucket lowers the short burn into the
	// hysteresis band. The alert must not clear on a correction alone.
	put(t, evaluator, start.Add(9*time.Minute), 100_000, 0)
	result = evaluate(t, evaluator, at)
	requireFloat(t, "corrected short burn", result.Short.BurnRate, 404.0/500.0)
	requireFloat(t, "corrected long burn", result.Long.BurnRate, 909.0/1000.0)
	if !result.Firing() || result.Transition != formal.TransitionNone {
		t.Fatalf("correction cleared alert: state=%s transition=%s", result.State, result.Transition)
	}

	// Fully healthy data clears it.
	for minute := 0; minute < 10; minute++ {
		put(t, evaluator, start.Add(time.Duration(minute)*time.Minute), 100_000, 40)
	}
	result = evaluate(t, evaluator, at)
	if result.Firing() || result.Transition != formal.TransitionCleared {
		t.Fatalf("healthy data did not clear: state=%s transition=%s", result.State, result.Transition)
	}
}

func TestNaturalDayTargetChangeChangesBudget(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skipf("time zone unavailable: %v", err)
	}
	cfg := baseConfig()
	cfg.FireThreshold = 1.8
	cfg.RecoverThreshold = 0.9
	cfg.Targets = formal.TargetSchedule{
		Location: shanghai,
		Default:  0.999,
		Daily:    map[string]float64{"2026-11-17": 0.99},
	}
	evaluator := newEvaluator(t, cfg)

	// Ten one-minute buckets span local midnight. The first five use the
	// previous day's 0.99 target; the last five use the default 0.999.
	from := time.Date(2026, 11, 17, 23, 55, 0, 0, shanghai)
	for i := 0; i < 10; i++ {
		targetStart := from.Add(time.Duration(i) * time.Minute)
		errors := int64(10)
		put(t, evaluator, targetStart, 1000, errors)
	}
	at := time.Date(2026, 11, 18, 0, 5, 0, 0, shanghai)
	result := evaluate(t, evaluator, at)

	requireFloat(t, "long allowed errors", result.Long.AllowedErrors, 55)
	requireFloat(t, "long errors", float64(result.Long.Errors), 100)
	requireFloat(t, "long burn", result.Long.BurnRate, 100.0/55.0)
	requireFloat(t, "long effective target", result.Long.TargetEffective, 1-55.0/10_000.0)
	requireFloat(t, "short burn", result.Short.BurnRate, 10)
	if result.Long.From.In(shanghai).Format("2006-01-02T15:04") != "2026-11-17T23:55" {
		t.Fatalf("long window start = %s", result.Long.From.In(shanghai))
	}
	if !result.Firing() {
		t.Fatalf("cross-day burn did not fire: %+v", result.Long)
	}
}

func TestEvaluationTimeRegression(t *testing.T) {
	evaluator := newEvaluator(t, baseConfig())
	at := mustTime(t, "2026-11-18T10:10:00Z")
	evaluate(t, evaluator, at)
	if _, err := evaluator.Evaluate(at.Add(-time.Nanosecond)); !errors.Is(err, formal.ErrTimeRegression) {
		t.Fatalf("error = %v, want ErrTimeRegression", err)
	}
	if _, err := evaluator.Evaluate(time.Time{}); !errors.Is(err, formal.ErrInvalidEvaluationTime) {
		t.Fatalf("error = %v, want ErrInvalidEvaluationTime", err)
	}
}
