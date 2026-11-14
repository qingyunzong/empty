// Package dataeng decodes mainframe fixed-width records for the host data
// ingestion layer.
//
// A Registry selects a Schema for each raw record from its byte length, the
// EBCDIC code page, and an optional version discriminator field. Packed
// decimal, overpunch (zoned) decimal, and blank-padded character fields are
// each validated independently; records that fail are isolated as BadRecord
// values that keep their absolute stream offset and raw bytes. The Reader
// frames the stream strictly by byte count, never by UTF-8 character count,
// so records spanning block boundaries are reassembled correctly.
package dataeng
