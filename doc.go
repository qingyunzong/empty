// Package dataeng reassembles Kubernetes CRI container log records.
//
// Container runtimes write CRI logs as
//
//	<timestamp> <stream> <tag> <content>
//
// where tag is either P (a partial record that continues on a later line)
// or F (the final fragment of a record). Log rotation can leave a partial
// record at the end of one file and start another file with an unrelated
// record that happens to have the same timestamp.
//
// Reassembler keeps partial records separate by stream, source tag,
// timestamp, and file generation. A record is only completed by an F
// fragment with the same key. If a key disappears because its file was
// rotated, or because the input reached EOF, the buffered content is emitted
// as one record marked Truncated instead of being discarded.
package dataeng
