package formal_test

import (
	"math/rand"
	"testing"
	"time"

	"example.org/dlks/formal/q10187"
)

// naiveWindow intentionally recomputes a window by walking every bucket-grid
// point with no shared aggregation code. It is the oracle for the evaluator.
func naiveWindow(
	buckets []formal.Bucket,
	from, to time.Time,
	window time.Duration,
	width time.Duration,
	targets formal.TargetSchedule,
	minCoverage float64,
	maxStaleness time.Duration,
) formal.WindowStats {
	byStart := make(map[int64]formal.Bucket, len(buckets))
	for _, bucket := range buckets {
		byStart[bucket.Start.UnixNano()] = bucket
	}
	stats := formal.WindowStats{
		Window:          window,
		From:            from,
		To:              to,
		ExpectedBuckets: int(to.Sub(from) / width),
	}
	var latestEnd time.Time
	var timeWeightedTarget float64
	for start := from; start.Before(to); start = start.Add(width) {
		target := targets.TargetAt(start)
		timeWeightedTarget += float64(width) * target
		bucket, present := byStart[start.UnixNano()]
		if !present {
			continue
		}
		stats.ObservedBuckets++
		stats.Total += bucket.Total
		stats.Errors += bucket.Errors
		stats.AllowedErrors += float64(bucket.Total) * (1 - target)
		if end := start.Add(width); end.After(latestEnd) {
			latestEnd = end
		}
	}
	stats.MissingBuckets = stats.ExpectedBuckets - stats.ObservedBuckets
	stats.Coverage = float64(stats.ObservedBuckets) / float64(stats.ExpectedBuckets)
	if stats.ObservedBuckets == 0 {
		stats.Age = window
	} else {
		stats.Age = to.Sub(latestEnd)
	}
	stats.Fresh = stats.ObservedBuckets > 0 && stats.Age <= maxStaleness
	stats.DataOK = stats.Coverage >= minCoverage && stats.Fresh
	if stats.AllowedErrors > 0 {
		stats.BurnRate = float64(stats.Errors) / stats.AllowedErrors
	}
	stats.BudgetConsumed = stats.BurnRate
	if stats.Total > 0 {
		stats.TargetEffective = 1 - stats.AllowedErrors/float64(stats.Total)
	} else if window > 0 {
		stats.TargetEffective = timeWeightedTarget / float64(window)
	}
	return stats
}

func requireStatsEqual(t *testing.T, got, want formal.WindowStats) {
	t.Helper()
	if !got.From.Equal(want.From) || !got.To.Equal(want.To) || got.Window != want.Window {
		t.Fatalf("window bounds: got [%s,%s) %s, want [%s,%s) %s",
			got.From, got.To, got.Window, want.From, want.To, want.Window)
	}
	if got.Total != want.Total || got.Errors != want.Errors {
		t.Fatalf("counts: got total=%d errors=%d, want total=%d errors=%d",
			got.Total, got.Errors, want.Total, want.Errors)
	}
	if got.ExpectedBuckets != want.ExpectedBuckets ||
		got.ObservedBuckets != want.ObservedBuckets ||
		got.MissingBuckets != want.MissingBuckets {
		t.Fatalf("bucket counts: got expected=%d observed=%d missing=%d, want %d/%d/%d",
			got.ExpectedBuckets, got.ObservedBuckets, got.MissingBuckets,
			want.ExpectedBuckets, want.ObservedBuckets, want.MissingBuckets)
	}
	requireFloat(t, "allowed errors", got.AllowedErrors, want.AllowedErrors)
	requireFloat(t, "burn rate", got.BurnRate, want.BurnRate)
	requireFloat(t, "budget consumed", got.BudgetConsumed, want.BudgetConsumed)
	requireFloat(t, "coverage", got.Coverage, want.Coverage)
	requireFloat(t, "effective target", got.TargetEffective, want.TargetEffective)
	if got.Fresh != want.Fresh || got.DataOK != want.DataOK || got.Age != want.Age {
		t.Fatalf("data state: got fresh=%v ok=%v age=%s, want fresh=%v ok=%v age=%s",
			got.Fresh, got.DataOK, got.Age, want.Fresh, want.DataOK, want.Age)
	}
}

func TestRandomizedDifferentialAgainstNaiveAggregation(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skipf("time zone unavailable: %v", err)
	}
	rng := rand.New(rand.NewSource(10187))
	width := time.Minute
	shortWindow := 7 * time.Minute
	longWindow := 23 * time.Minute
	start := time.Date(2026, 11, 17, 23, 40, 0, 0, shanghai)

	for iteration := 0; iteration < 300; iteration++ {
		cfg := formal.Config{
			BucketWidth:      width,
			ShortWindow:      shortWindow,
			LongWindow:       longWindow,
			FireThreshold:    1.3,
			RecoverThreshold: 0.6,
			MinCoverage:      0.75 + rng.Float64()*0.25,
			MaxStaleness:     time.Duration(rng.Intn(3)) * width,
			Targets: formal.TargetSchedule{
				Location: shanghai,
				Default:  0.999,
				Daily: map[string]float64{
					"2026-11-17": 0.99,
					"2026-11-18": 0.995,
				},
			},
		}
		evaluator, err := formal.NewEvaluator(cfg, nil)
		if err != nil {
			t.Fatalf("iteration %d: %v", iteration, err)
		}

		type sample struct {
			minute int
			bucket formal.Bucket
		}
		var samples []sample
		for minute := 0; minute < 40; minute++ {
			if rng.Intn(8) == 0 {
				continue
			}
			total := int64(rng.Intn(20_000))
			errors := int64(0)
			if total > 0 {
				errors = int64(rng.Intn(int(total) + 1))
			}
			samples = append(samples, sample{
				minute: minute,
				bucket: formal.Bucket{
					Start:  start.Add(time.Duration(minute) * width),
					Total:  total,
					Errors: errors,
				},
			})
		}
		// Ingest in a shuffled order to exercise out-of-order handling.
		for _, index := range rng.Perm(len(samples)) {
			if _, err := evaluator.Ingest(samples[index].bucket); err != nil {
				t.Fatalf("iteration %d ingest: %v", iteration, err)
			}
		}

		cut := start.Add(40 * width)
		result := evaluate(t, evaluator, cut)
		all := evaluator.Store().Buckets()
		wantLong := naiveWindow(all, cut.Add(-longWindow), cut, longWindow, width,
			cfg.Targets, cfg.MinCoverage, cfg.MaxStaleness)
		wantShort := naiveWindow(all, cut.Add(-shortWindow), cut, shortWindow, width,
			cfg.Targets, cfg.MinCoverage, cfg.MaxStaleness)
		requireStatsEqual(t, result.Long, wantLong)
		requireStatsEqual(t, result.Short, wantShort)
	}
}
