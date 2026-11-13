// Package dataeng reassembles change-data-capture tuples without contacting a
// database.
//
// A Reassembler records relation descriptions, validates tuple shapes and
// column values against the description that was current when the tuple
// arrived, and holds changes that reference external large values until all of
// their numbered chunks are present. A change may carry a new tuple, an old
// tuple, and a key tuple at the same time; key tuples are restricted to the
// relation's identity columns.
package dataeng
