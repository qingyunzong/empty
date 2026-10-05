package tidx

import (
	"bufio"
	"io"
)

// scanBufSize is the fixed fragment buffer used for streaming. Lines longer
// than this are processed in multiple fragments without extra allocation.
const scanBufSize = 32 * 1024

// errBufferFull mirrors bufio.ErrBufferFull.
var errBufferFull = bufio.ErrBufferFull

// lineReader wraps a *bufio.Reader bound to its underlying source so that
// repeated nextLine calls share one fixed-size buffer.
type lineReader struct {
	br *bufio.Reader
}

// getLineReader returns r as a *lineReader, reusing r directly when it
// already is one (keeps buffering across nextLine calls).
func getLineReader(r io.Reader) *lineReader {
	if lr, ok := r.(*lineReader); ok {
		return lr
	}
	return &lineReader{br: bufio.NewReaderSize(r, scanBufSize)}
}

// ReadSlice reads until the first occurrence of delim, returning a fragment
// that may be shorter than the line when the line exceeds the buffer.
func (lr *lineReader) ReadSlice(delim byte) ([]byte, error) {
	return lr.br.ReadSlice(delim)
}

// Read implements io.Reader so a *lineReader can wrap itself.
func (lr *lineReader) Read(p []byte) (int, error) { return lr.br.Read(p) }
