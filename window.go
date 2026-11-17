package formal

import "time"

// WindowStats is the aggregate state of one burn-rate window.
//
// AllowedErrors is the event-weighted error budget for the window:
//
//	sum(total_i * (1 - target(day_i)))
//
// BurnRate and BudgetConsumed are errors divided by AllowedErrors. Both are
// zero when the window contains no events.
type WindowStats struct {
	Window         time.Duration
	From           time.Time
	To             time.Time
	Total          int64
	Errors         int64
	AllowedErrors  float64
	BurnRate       float64
	BudgetConsumed float64
	Coverage       float64

	ExpectedBuckets int
	ObservedBuckets int
	MissingBuckets  int

	TargetEffective float64
	Fresh           bool
	Age             time.Duration
	DataOK          bool
}

func aggregateWindow(points []windowPoint, window time.Duration, cfg Config) WindowStats {
	stats := WindowStats{
		Window:          window,
		ExpectedBuckets: len(points),
	}
	if len(points) == 0 {
		return stats
	}

	stats.From = points[0].start
	stats.To = points[len(points)-1].start.Add(cfg.BucketWidth)

	var latestEnd time.Time
	var timeWeightedTarget float64
	for _, point := range points {
		target := cfg.Targets.TargetAt(point.start)
		timeWeightedTarget += float64(cfg.BucketWidth) * target
		if !point.present {
			continue
		}

		stats.ObservedBuckets++
		stats.Total += point.bucket.Total
		stats.Errors += point.bucket.Errors
		stats.AllowedErrors += float64(point.bucket.Total) * (1 - target)

		end := point.start.Add(cfg.BucketWidth)
		if end.After(latestEnd) {
			latestEnd = end
		}
	}

	stats.MissingBuckets = stats.ExpectedBuckets - stats.ObservedBuckets
	stats.Coverage = float64(stats.ObservedBuckets) / float64(stats.ExpectedBuckets)
	if stats.ObservedBuckets > 0 {
		stats.Age = stats.To.Sub(latestEnd)
	} else {
		stats.Age = window
	}
	stats.Fresh = stats.ObservedBuckets > 0 && stats.Age <= cfg.MaxStaleness
	stats.DataOK = stats.Coverage >= cfg.MinCoverage && stats.Fresh

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
