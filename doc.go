// Package dataeng compiles a host-supplied, already-parsed copybook subset AST
// into a byte layout and decodes records into exact decimal values and raw
// byte ranges. It never parses COBOL source text.
//
// Layouts support nested groups, fixed and DEPENDING ON OCCURS, and adjacent
// root-level REDEFINES groups. Decoding is all-or-nothing: every record must
// consume exactly its input length.
package dataeng
