package forward

import "io"

// Source yields the request body one chunk at a time.
type Source interface {
	// ReadChunk fills buf and returns the number of bytes read.
	// Returning (0, nil) yields an empty chunk, which is forwarded like
	// any other. io.EOF (optionally with n > 0) ends the stream cleanly;
	// any other error is reported as a *ReadError, never as a limit hit.
	ReadChunk(buf []byte) (int, error)
	// Close shuts the source down. It may be called concurrently with a
	// blocked ReadChunk (e.g. on cancellation) and must unblock it.
	Close() error
}

// NewReaderSource adapts an io.Reader into a Source. One Read call maps to
// one chunk, so chunk boundaries (including empty chunks from (0, nil)
// reads) follow the reader. If r is an io.Closer it is closed on Close.
func NewReaderSource(r io.Reader) Source {
	s := &readerSource{r: r}
	if c, ok := r.(io.Closer); ok {
		s.c = c
	}
	return s
}

type readerSource struct {
	r io.Reader
	c io.Closer
}

func (s *readerSource) ReadChunk(buf []byte) (int, error) { return s.r.Read(buf) }

func (s *readerSource) Close() error {
	if s.c != nil {
		return s.c.Close()
	}
	return nil
}
