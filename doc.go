// Package q154 decodes compressed sensor frames delivered by the acquisition
// pipeline.
//
// A frame is laid out as follows, with all multi-bit fields serialized
// most-significant-bit first and the final partial byte zero-padded:
//
//   - count: 32-bit big-endian unsigned record count;
//   - when count is non-zero, the first record holds an 8-byte big-endian
//     signed int64 timestamp and an 8-byte raw uint64 value;
//   - every subsequent record encodes:
//   - a one-bit timestamp flag: 0 means the delta-of-delta is zero, 1 means
//     a canonical signed LEB128 delta-of-delta follows. The very first
//     delta is implicitly zero, so no delta is stored for the first record;
//   - a one-bit value flag: 0 means the value is unchanged, 1 means a 6-bit
//     leading-zero count, a 6-bit significant-bit width (width 0 denotes 64
//     bits) and the significant bits of value XOR previous value follow;
//   - zero padding up to the next byte boundary;
//   - a 32-bit big-endian CRC32-IEEE checksum covering every preceding byte.
//
// A zero-record frame contains only the count and the checksum. Bit-level
// state is preserved across arbitrary transport blocks. Non-canonical signed
// LEB128 encodings, out-of-range significant widths and integer overflows
// are rejected, and records are delivered only after the whole frame,
// including its checksum, has been validated.
package q154
