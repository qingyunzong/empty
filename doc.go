// Package dataeng merges sorted record segments for the collection
// pipeline. Records carry a key, a non-negative sequence number, an
// operation (write or delete), and a payload. Segments must be sorted by
// key and then by sequence; conflicts and sequence gaps only affect the
// key involved, while an unsorted segment or a missing watermark fails
// the whole merge.
package dataeng
