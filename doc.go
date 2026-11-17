// Package formal implements deterministic tail-based trace sampling for a
// distributed tracing pipeline.
//
// A Collector aggregates out-of-order span fragments per trace, decides once
// at a fixed deadline, and applies business rules in priority order. Late
// fragments may supplement a retained trace but can never revive a dropped
// one. All time-dependent behavior is driven by a Clock, making the component
// testable with a virtual clock.
package formal
