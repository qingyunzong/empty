// Package dataeng provides an incremental decoder for interleaved text
// messages and length-prefixed binary frames. It performs no I/O and never
// opens a connection; callers feed stream chunks to Decoder.Push.
package dataeng
