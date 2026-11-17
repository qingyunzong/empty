package formal

import (
	"fmt"
	"math"
	"time"
)

// Config describes one short/long burn-rate alert pair.
//
// Both windows end at the same evaluation cut and must be integer multiples of
// BucketWidth. The long window must be at least as long as the short window.
type Config struct {
	// BucketWidth is the width of every SLI bucket.
	BucketWidth time.Duration
	// ShortWindow is the fast confirmation window.
	ShortWindow time.Duration
	// LongWindow is the slow confirmation window.
	LongWindow time.Duration
	// FireThreshold is the burn rate both windows must strictly exceed.
	FireThreshold float64
	// RecoverThreshold is the burn rate both windows must be at or below
	// before recovery can start. It must be lower than FireThreshold.
	RecoverThreshold float64
	// MinCoverage is the minimum fraction of expected buckets that must be
	// present for a window to be considered usable. It must be in (0, 1].
	MinCoverage float64
	// MaxStaleness bounds the age of the newest bucket in a window. With zero,
	// the bucket immediately before the evaluation cut must be present.
	MaxStaleness time.Duration
	// RecoverFor is the continuous time both windows must remain at or below
	// RecoverThreshold before a firing alert clears. Zero clears immediately.
	RecoverFor time.Duration
	// Targets supplies the objective for each natural day.
	Targets TargetSchedule
}

// Validate reports whether c is internally consistent.
func (c Config) Validate() error {
	if c.BucketWidth <= 0 {
		return fmt.Errorf("%w: got %s", ErrInvalidBucketWidth, c.BucketWidth)
	}
	if c.ShortWindow < c.BucketWidth {
		return fmt.Errorf("formal: short window %s is shorter than bucket width %s", c.ShortWindow, c.BucketWidth)
	}
	if c.LongWindow < c.ShortWindow {
		return fmt.Errorf("formal: long window %s is shorter than short window %s", c.LongWindow, c.ShortWindow)
	}
	if c.ShortWindow%c.BucketWidth != 0 {
		return fmt.Errorf("formal: short window %s is not a multiple of bucket width %s", c.ShortWindow, c.BucketWidth)
	}
	if c.LongWindow%c.BucketWidth != 0 {
		return fmt.Errorf("formal: long window %s is not a multiple of bucket width %s", c.LongWindow, c.BucketWidth)
	}
	if math.IsNaN(c.FireThreshold) || math.IsInf(c.FireThreshold, 0) || c.FireThreshold <= 0 {
		return fmt.Errorf("formal: fire threshold must be finite and positive, got %v", c.FireThreshold)
	}
	if math.IsNaN(c.RecoverThreshold) || math.IsInf(c.RecoverThreshold, 0) ||
		c.RecoverThreshold < 0 || c.RecoverThreshold >= c.FireThreshold {
		return fmt.Errorf("formal: recover threshold %v must be in [0, fire threshold %v)", c.RecoverThreshold, c.FireThreshold)
	}
	if math.IsNaN(c.MinCoverage) || c.MinCoverage <= 0 || c.MinCoverage > 1 {
		return fmt.Errorf("formal: minimum coverage %v must be in (0, 1]", c.MinCoverage)
	}
	if c.MaxStaleness < 0 {
		return fmt.Errorf("formal: maximum staleness must not be negative, got %s", c.MaxStaleness)
	}
	if c.RecoverFor < 0 {
		return fmt.Errorf("formal: recovery dwell must not be negative, got %s", c.RecoverFor)
	}
	if err := c.Targets.Validate(); err != nil {
		return err
	}
	return nil
}

func (c Config) clone() Config {
	c.Targets = c.Targets.clone()
	return c
}
