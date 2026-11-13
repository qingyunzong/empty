// Package dataeng stitches out-of-order trace fragments (spans, links,
// resources, scopes) into versioned traces for the link-data pipeline.
//
// Spans are merged by trace ID; identical redeliveries are deduplicated and
// conflicting redeliveries of the same span ID are isolated as Conflicts
// instead of being merged. Missing parents never block publication: after
// PublishTimeout the trace snapshot is emitted with OrphanCause root-cause
// markers. A parent arriving after publication produces an incremental
// revision event rather than a resend of the whole trace.
package dataeng
