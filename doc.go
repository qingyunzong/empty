// Package dataeng decodes the delimited exchange stream received by the
// collection agent and delivers validated envelopes to the host.
//
// The first three bytes of a stream declare the field separator, the segment
// terminator and the escape character; they must be distinct ASCII bytes.
// In the remaining stream the escape character quotes the byte that follows
// it. Segments are terminated by the declared terminator and carry fields
// split by the declared separator. BEGIN (exactly 2 fields: type and control
// ID) opens an envelope, ROW (type plus arbitrary fields) appends a row, and
// END (exactly 3 fields: type, same control ID, decimal row count without
// leading zeros) closes it. Nested envelopes and ROW segments outside an
// envelope are rejected, and an envelope is delivered only when its END
// checks pass.
//
// The host sets positive budgets for a single field's decoded size and for
// an envelope's raw source bytes. Any violation revokes the current envelope
// and reports the absolute source offset; envelopes completed earlier are
// kept and the parser resynchronises at the next segment boundary.
//
//	p, _ := dataeng.NewParser(4096, 1<<20)
//	envs, err := p.Feed(chunk) // call per chunk, any size
//	// ... after the last chunk:
//	if err := p.Finish(); err != nil { /* truncated stream */ }
package dataeng
