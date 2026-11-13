// Package dataeng provides importable IMAP BODY section reassembly for
// archive workloads.
//
// A Message collects literal fragments for any number of BODY sections. Each
// fragment is identified by its section, its origin octet offset within that
// section, and the bytes of the literal that the server actually returned.
// Fragments may arrive out of order or concurrently. The assembler merges
// adjacent and identical overlapping fragments, rejects conflicting overlaps,
// reports holes, and records short literals (server truncation).
//
// Section completion is based on the expected section size and on coverage of
// the actual literal bytes. It is never inferred from the lengths that were
// requested in FETCH commands.
package dataeng
