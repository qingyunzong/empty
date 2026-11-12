// Package dataeng is a small read-only decoder for a documented subset of
// FlatBuffers-style device collection messages.
//
// The host supplies compiled table definitions (schema); flatc is never
// invoked. Open validates every schema-known object reachable from the root
// table, including shared vtables, tables, strings and vectors, before
// returning a Handle. Reads through Handle.Get and Value.Get never mutate the
// borrowed buffer and never expose its backing array.
package dataeng
