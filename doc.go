// Package dataeng parses unit expressions into dimension vectors and exact
// rational scales, and converts measurement values between commensurable
// units. It supports affine temperature scales (degC, degF) but forbids
// them inside products, quotients, and powers. Prefix and unit-name
// matching is longest-first, unknown symbols are reported with their input
// position, and conversion round-trip error is constrained by a decimal
// policy. Dimension mismatches are rejected.
package dataeng
