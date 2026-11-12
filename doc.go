// Package dataeng provides exact conversions between legacy 32-bit
// hexadecimal floating-point samples and IEEE binary32 values.
//
// HexWordToBinary32 performs one round-to-nearest, ties-to-even conversion
// entirely in integer arithmetic. Binary32ToHexWord performs the reverse
// conversion using the canonical leading-nonzero mantissa representation.
package dataeng
