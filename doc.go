// Package dataeng validates reports for closed primary-key intervals.
//
// An Interval is inclusive at both ends and keys are compared byte-for-byte.
// A Validator owns the assignment and completion state for a collection of
// worker intervals. Reports are accepted atomically: if any key violates the
// assignment, the whole batch is rejected and no state changes.
package dataeng
