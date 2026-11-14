// Package dataeng adjudicates the order of scanned archive pages.
//
// A batch is scored from several independent kinds of evidence: explicit
// page-number OCR candidates, duplex front/back parity, source file order,
// and content digests that identify duplicate scans. The solver returns the
// best arrangement first and, when equally or nearly equally credible
// interpretations remain, additional arrangements together with their
// costs instead of forcing a single answer.
//
// Covers, inserts, and pages whose OCR produced no number are transparent
// to the continuous page-number chain. Missing pages are tolerated by
// default; RequireContiguous enables strict gap checking with declared
// MissingPages exemptions. Small batches can be solved exhaustively with
// SolveExact, which proves the first candidate optimal.
package dataeng
