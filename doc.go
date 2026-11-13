// Package dataeng provides an importable pgoutput (Postgres logical
// replication) state library for collectors. It parses Relation, Begin,
// Commit, streaming transaction, Origin and Truncate messages, decodes
// tuples against the relation schema generation bound to their
// transaction, and tracks a confirmed LSN that only advances past fully
// persisted complete commits.
package dataeng
