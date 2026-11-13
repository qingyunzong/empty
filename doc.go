// Package dataeng decodes Kafka-style record batches (magic 2) from bytes
// supplied by the caller. It performs no cluster or network I/O.
//
// The decoder validates batch offset and timestamp deltas, decodes commit and
// abort control records without dropping surrounding business records, and
// rejects records whose declared length exceeds the host limit as soon as the
// length field has been read.
package dataeng
