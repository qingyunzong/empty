// Package dataeng implements event-time tumbling windows for an ingestion
// pipeline that receives an external watermark.
//
// A window is the half-open interval [Start, End). It closes when the
// processor is told that the watermark has reached End. Closing emits one
// aggregate result. Events that arrive after the close, but before
// End+AllowedLateness, revise the aggregate: the processor emits a retraction
// carrying the previous aggregate followed by the corrected result. Events
// that arrive once the watermark has reached End+AllowedLateness only go to
// the side output and never change the window aggregate. With an allowed
// lateness of zero, every event that arrives after a window closes goes to
// the side output.
//
// The processor never advances the watermark on its own. In particular,
// processing an event does not move the watermark to that event's timestamp.
// The watermark changes only through AdvanceWatermark, and a value supplied
// by the caller is adopted exactly; the processor never invents a later one.
//
// The processor is safe for concurrent use.
package dataeng
