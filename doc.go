// Package dataeng decodes one compact acquisition-payload value. It handles
// delta-coded structure fields, nibble-packed container lengths and element
// types, zig-zag LEB128 integers, little-endian float64 values, and raw byte
// runs. Callers supply a Schema; the package does not interpret an outer
// network frame.
package dataeng
