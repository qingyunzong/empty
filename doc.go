// Package dataeng provides a canonical shortest-round-trip decimal encoding
// for raw IEEE 754 binary64 bit patterns.
//
// Format takes the original uint64 bits and returns a sign, an exact integer
// coefficient, a decimal exponent, canonical scientific text, and the exact
// round-to-nearest-even interval. Verify proves that the decimal is in the
// interval and is shortest and closest under the contract's tie-break rules.
//
// The package deliberately does not perform JSON encoding or presentation
// formatting. All production selection and verification uses exact integer
// and rational arithmetic, never floating-point parsing or formatting.
package dataeng
