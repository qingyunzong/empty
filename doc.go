// Package dataeng projects selected columns from one SQLite-style table-leaf
// cell without reading unprojected payload bytes.
//
// The caller locates the target cell and supplies immutable snapshot geometry.
// The package validates the complete overflow chain, the record header, every
// serial type, and the complete body length before returning values. It does
// not parse a database header, B-tree directory, SQL, or WAL, and it never
// writes to the snapshot.
package dataeng
