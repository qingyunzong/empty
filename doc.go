// Package dataeng implements a compact, randomly accessible index for logical
// 0/1 sequences.
//
// The on-disk format is a 13-byte header followed by an MSB-first bit stream:
//
//	u8  b                 block width, 1..63
//	u32 S (little endian) checkpoint interval, 1..4096
//	u64 N (little endian) logical length, 0..2^32-1
//
// Each block stores its one-count c in ceil(log2(b+1)) bits and then its
// ordinal in w = ceil(log2(C(m,c))) bits.  The ordinal orders all same-weight
// m-bit words by ordinary binary value, with the first logical bit as the
// most significant bit.  The final byte of the stream is zero-padded in its
// low bits only.
//
// Open validates the complete snapshot before publishing an Index.  The
// published index keeps the compressed payload, one directory entry per S
// blocks, and at most one decoded block cache.  It never materializes the
// original bit vector.
package dataeng
