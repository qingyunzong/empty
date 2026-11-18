// Package formal implements a watermark-based garbage collector for an
// MVCC transaction engine. It tracks the oldest active transaction and
// the safe watermark, reclaims expired versions along per-key version
// chains, and double-checks every victim against the raw active
// snapshot set so that concurrent watermark advancement and long range
// scans can never observe a prematurely reclaimed version.
package formal
