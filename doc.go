// Package dataeng reassembles multi-sentence messages from fragments supplied
// by the caller. It performs no I/O and does not receive radio traffic.
//
// A fragment carries a message identifier, the total number of sentences in
// the message, its one-based sentence number, and the number of fill bits at
// the end of its payload. Fragments may arrive out of order. A message is
// complete once sentences 1 through Total are present exactly once.
//
// Validation is strict:
//
//   - all fragments of a message must report the same Total;
//   - sentence numbers must run from 1 through Total without gaps or duplicates;
//   - FillBits may be nonzero only on sentence Total;
//   - after the final fill bits are removed, the payload must contain a
//     multiple of six data bits.
//
// A fragment that fails validation is discarded and the message it belongs to
// is failed. Missing fragments expire only when the caller asks the Assembler
// to expire them using the caller's clock; the package never starts timers or
// reads the wall clock unless no clock was supplied.
package dataeng
