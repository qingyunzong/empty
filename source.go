package dataeng

import (
	"context"
	"errors"
	"io"
)

// ErrUnsorted is returned when a source yields rows out of key order.
var ErrUnsorted = errors.New("dataeng: input source is not sorted by key")

// Row is a single record with a composite sort key and an opaque payload.
type Row struct {
	Key Key
	Val any
}

// Source yields rows in non-decreasing key order, in chunks of bounded
// size. It returns io.EOF when exhausted.
type Source interface {
	NextChunk(ctx context.Context) ([]Row, error)
}

// SliceSource adapts an in-memory slice into a chunked Source.
type SliceSource struct {
	rows  []Row
	chunk int
	pos   int
}

// NewSliceSource returns a Source that serves rows in chunks of chunkSize.
func NewSliceSource(rows []Row, chunkSize int) *SliceSource {
	if chunkSize <= 0 {
		chunkSize = len(rows)
		if chunkSize == 0 {
			chunkSize = 1
		}
	}
	return &SliceSource{rows: rows, chunk: chunkSize}
}

func (s *SliceSource) NextChunk(context.Context) ([]Row, error) {
	if s.pos >= len(s.rows) {
		return nil, io.EOF
	}
	end := s.pos + s.chunk
	if end > len(s.rows) {
		end = len(s.rows)
	}
	out := s.rows[s.pos:end]
	s.pos = end
	return out, nil
}

// cursor presents a chunked Source as a row stream with single-row lookahead
// and validates the sort invariant.
type cursor struct {
	src  Source
	buf  []Row
	idx  int
	eof  bool
	last Key
	has  bool
}

func newCursor(src Source) *cursor { return &cursor{src: src} }

func (c *cursor) fill(ctx context.Context) error {
	for c.idx >= len(c.buf) {
		if c.eof {
			return io.EOF
		}
		chunk, err := c.src.NextChunk(ctx)
		if err != nil {
			if err == io.EOF {
				c.eof = true
				return io.EOF
			}
			return err
		}
		if len(chunk) == 0 {
			continue
		}
		c.buf = chunk
		c.idx = 0
	}
	return nil
}

// peek returns the current row without consuming it.
func (c *cursor) peek(ctx context.Context) (Row, error) {
	if err := c.fill(ctx); err != nil {
		return Row{}, err
	}
	if c.has && CompareKeys(c.buf[c.idx].Key, c.last) < 0 {
		return Row{}, ErrUnsorted
	}
	return c.buf[c.idx], nil
}

// advance consumes the current row, checking key order.
func (c *cursor) advance(ctx context.Context) error {
	if err := c.fill(ctx); err != nil {
		return err
	}
	k := c.buf[c.idx].Key
	if c.has && CompareKeys(k, c.last) < 0 {
		return ErrUnsorted
	}
	c.last = k
	c.has = true
	c.idx++
	return nil
}
