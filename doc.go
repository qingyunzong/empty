// Package dataeng provides a small, streaming UTF-8 grapheme segmenter for
// cursor-oriented user interfaces.
//
// The package intentionally implements only the rule subset requested by the
// embedding application. It is not a complete implementation of the Unicode
// grapheme cluster algorithm, and it never consults the Unicode database.
// Code point properties are supplied by the caller through PropertyLookup.
//
// A Segmenter accepts UTF-8 in arbitrary chunks. Boundaries are decided only
// between code points, including across chunk boundaries. A trailing code point
// is not considered a cluster until Finish is called. Each successfully
// closed cluster is passed to the configured Sink with its half-open raw byte
// and UTF-16 intervals, in that order, together with its original text.
//
// Invalid or truncated UTF-8 reports the byte offset at which the offending
// sequence starts. Clusters delivered before the failure remain delivered.
// The cluster that was still open at the failure is never delivered.
package dataeng
