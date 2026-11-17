package formal

// WatermarkGenerator tracks the maximum event timestamp observed and exposes a
// monotonically non-decreasing watermark. With bounded out-of-orderness B the
// watermark for observed time t is t-B; it can never move backwards.
type WatermarkGenerator struct {
	maxEventTime          int64
	boundedOutOfOrderness int64
	watermark             int64
}

// NewWatermarkGenerator builds a generator. A negative bound is treated as
// zero (perfect watermark tracking).
func NewWatermarkGenerator(boundedOutOfOrderness int64) *WatermarkGenerator {
	bound := boundedOutOfOrderness
	if bound < 0 {
		bound = 0
	}
	return &WatermarkGenerator{
		maxEventTime:          MinTimestamp,
		boundedOutOfOrderness: bound,
		watermark:             MinTimestamp,
	}
}

// Observe records an event timestamp and returns the resulting watermark.
func (g *WatermarkGenerator) Observe(timestamp int64) int64 {
	if timestamp > g.maxEventTime {
		g.maxEventTime = timestamp
	}
	candidate := g.maxEventTime - g.boundedOutOfOrderness
	if candidate > g.watermark {
		g.watermark = candidate
	}
	return g.watermark
}

// Advance forces the watermark to the given timestamp if it is newer. A
// backwards advance is ignored, preserving the monotonicity guarantee.
func (g *WatermarkGenerator) Advance(timestamp int64) int64 {
	if timestamp > g.watermark {
		g.watermark = timestamp
	}
	return g.watermark
}

// Watermark returns the current watermark.
func (g *WatermarkGenerator) Watermark() int64 {
	return g.watermark
}
