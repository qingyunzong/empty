// Package dataeng decodes multi-table change logs organized by schema
// generation.
//
// The input is a stream of events carrying strictly increasing global
// sequence numbers: SchemaEvent announces the ordered column IDs and
// types of one table generation, RowEvent carries a value sequence for a
// generation and CommitEvent closes a batch.
//
// Rows are mapped onto stable column IDs instead of ordinal positions,
// so reordering columns between generations never cross-wires values.
// Schema generations for one table must be strictly increasing, both
// within a batch (in global sequence order) and across commits. The only
// supported column types are nullable int64, string and bool.
//
// A row may arrive before the schema it references; such rows are staged
// and resolved at commit time. If any generation remains unresolved, or
// any row fails arity or type validation, the entire batch is rejected
// and neither its schemas nor its rows become visible. Pending data is
// always private until a successful commit.
package dataeng
