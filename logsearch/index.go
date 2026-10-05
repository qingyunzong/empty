// Package logsearch provides an immutable byte-suffix index for log search.
//
// An Index is an immutable snapshot: Append returns a new Index covering the
// old data plus the appended bytes, while the receiver stays unchanged, so
// queries against older snapshots always observe the same results.
package logsearch

import (
	"index/suffixarray"
	"sort"
)

// Index is an immutable snapshot of a log built from appended byte chunks.
// The zero value is an empty index ready to use.
type Index struct {
	data []byte
	sa   *suffixarray.Index
}

// New returns an empty index.
func New() *Index {
	return &Index{sa: suffixarray.New(nil)}
}

// Len returns the number of indexed bytes in this snapshot.
func (idx *Index) Len() int { return len(idx.data) }

// Append returns a new Index covering the current data followed by chunk.
// The receiver is not modified; previously obtained snapshots keep observing
// exactly the data they were created from.
func (idx *Index) Append(chunk []byte) *Index {
	data := make([]byte, len(idx.data)+len(chunk))
	copy(data, idx.data)
	copy(data[len(idx.data):], chunk)
	return &Index{data: data, sa: suffixarray.New(data)}
}

// Search returns the sorted offsets of every occurrence of pattern in this
// snapshot. Overlapping occurrences are all reported. An empty pattern
// matches nothing and yields nil.
func (idx *Index) Search(pattern []byte) []int {
	if len(pattern) == 0 {
		return nil
	}
	// suffixarray.Lookup returns matches in unspecified order; sort so
	// callers always get offsets in ascending order.
	hits := idx.sa.Lookup(pattern, -1)
	sort.Ints(hits)
	return hits
}
