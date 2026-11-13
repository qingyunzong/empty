// Package dataeng implements a chunk-safe delimited-text reader.
//
// The reader is designed for import pipelines. It accepts input split at
// arbitrary byte boundaries, including boundaries that fall in the middle of a
// quoted newline, an escaped quote, a multi-byte delimiter, or a UTF-8
// sequence. Every field reports the exact half-open byte interval it occupied
// in the original stream.
//
// Malformed quoting is a record-local error. After reporting the bad physical
// record, the reader skips to the next physical line and continues. A field
// or record that exceeds a configured size limit is discarded in the same way;
// scanning continues until a reliable record boundary is found.
package dataeng
