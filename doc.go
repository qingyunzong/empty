// Package dataeng provides a multi-source quota scheduler for collection
// hosts. A Scheduler dispatches ready tasks under global and per-source
// concurrency limits plus per-source minimum start intervals, using an
// injectable clock so timing behavior is fully testable.
package dataeng
