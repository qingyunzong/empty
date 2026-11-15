package dataeng

import (
	"bufio"
	"io"
)

// lineReader reads newline-terminated lines without ever joining a partial
// final line to data from another shard.
type lineReader struct {
	br    *bufio.Reader
	limit int
	buf   []byte
}

func newLineReader(r io.Reader, limit int) *lineReader {
	if limit <= 0 {
		limit = 16 << 20
	}
	bufSize := 64 << 10
	if limit+1 < bufSize {
		bufSize = limit + 1
	}
	if bufSize < 2 {
		bufSize = 2
	}
	return &lineReader{
		br:    bufio.NewReaderSize(r, bufSize),
		limit: limit,
	}
}

// next returns one line without its trailing LF. A trailing CR is also removed.
// The returned slice is only valid until the next call to next.
func (lr *lineReader) next() ([]byte, error) {
	lr.buf = lr.buf[:0]
	for {
		frag, err := lr.br.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			if len(lr.buf)+len(frag) > lr.limit {
				return nil, ErrLineTooLong
			}
			lr.buf = append(lr.buf, frag...)
			continue
		}
		if err == io.EOF {
			if len(lr.buf) == 0 && len(frag) == 0 {
				return nil, io.EOF
			}
			if len(lr.buf)+len(frag) > lr.limit {
				return nil, ErrLineTooLong
			}
			return nil, ErrSplitLine
		}
		if err != nil {
			return nil, err
		}

		content := frag[:len(frag)-1]
		payloadLen := len(lr.buf) + len(content)
		if len(content) > 0 && content[len(content)-1] == '\r' {
			payloadLen--
		}
		if payloadLen > lr.limit {
			return nil, ErrLineTooLong
		}
		if len(lr.buf) > 0 {
			lr.buf = append(lr.buf, content...)
			content = lr.buf
		}
		if n := len(content); n > 0 && content[n-1] == '\r' {
			content = content[:n-1]
		}
		return content, nil
	}
}
