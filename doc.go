// Package dataeng implements conservative Apache ORC stripe and row-group
// pruning.
//
// The reader understands ORC row indexes, bloom-filter indexes, writer
// timezones and timestamp statistics. Predicates produce candidate row
// intervals; when statistics are missing, malformed, or cannot be interpreted
// safely the affected groups are reported as may-match rather than pruned.
//
// Legacy timestamp statistics (writer version < ORC-135) are local wall-clock
// values. They are translated through the stripe's declared writer timezone,
// and DST gaps/overlaps widen the candidate interval instead of dropping rows.
package dataeng
