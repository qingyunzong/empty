// Package dataeng parses chunked binary row streams for a database
// accessor.
//
// A stream begins with the four ASCII magic bytes "ROW1" followed by zero
// or more rows and a terminator row. Each row starts with a signed,
// big-endian 16-bit field count: -1 (0xFFFF) is the terminator and must be
// the final bytes of the stream; any other negative value is illegal; a
// non-negative count must equal the fixed number of columns configured on
// the parser.
//
// Every field starts with a signed, big-endian 32-bit byte length: -1 means
// NULL, any other negative value is illegal, and a non-negative length is
// followed by that many raw body bytes. Column types are raw bytes, signed
// big-endian 64-bit integers (whose bodies must be exactly eight bytes),
// and strict UTF-8 text. NULL is distinct from an empty body.
//
// Input may be delivered in arbitrarily small chunks, including one byte at
// a time. Partial frames are retained internally. All parse errors report an
// absolute byte offset within the stream.
package dataeng
