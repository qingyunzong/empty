// Package q217 verifies small, forward-only filter bytecode programs.
//
// The verifier propagates signed integer intervals to every reachable program
// point, narrows intervals on comparison edges, joins incoming edges with an
// envelope, and rejects uninitialized registers or reads it cannot prove to be
// in bounds. Accepted programs return a recomputable certificate for every read.
package q217
