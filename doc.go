// Package dataeng assembles downloaded content ranges without initiating any
// transfer. Callers register half-open byte segments or suffixes measured from
// the end of the content. Identical overlapping bytes are merged, conflicting
// bytes reject the incoming segment while retaining both sources, and gaps
// remain explicit holes rather than zero-filled data.
//
// A suffix stays pending until the total content length is known. The ledger
// marks itself complete only when the total is known, every byte in
// [0, TotalSize) is covered, and no conflict has been recorded.
package dataeng
