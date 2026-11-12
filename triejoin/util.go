package triejoin

import (
	"encoding/binary"
	"errors"
)

var (
	errCursorClosed  = errors.New("triejoin: cursor is closed")
	errCursorAtRoot  = errors.New("triejoin: Up called at the trie root")
	errMissingCursor = errors.New("triejoin: relation cursor was not constructed")
)

func containsCol(cols []string, name string) bool {
	for _, c := range cols {
		if c == name {
			return true
		}
	}
	return false
}

func tupleLess(a, b []int64) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// orderedKey encodes a tuple as bytes preserving signed int64 lexicographic
// order, suitable for set deduplication.
func orderedKey(buf []byte, row []int64) []byte {
	for _, v := range row {
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(v)^(1<<63))
		buf = append(buf, b[:]...)
	}
	return buf
}
