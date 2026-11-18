// Package formal implements an alert rule engine for notification paths.
//
// The engine keeps a set of firing alerts and one atomic rule snapshot. It
// deduplicates alerts by label fingerprint, applies time-windowed silences and
// label-based inhibitions, and groups the remaining alerts into notifications.
// Snapshot computes the complete notification set from one consistent state;
// Poll provides at-most-once delivery of stable notification identities.
package formal
