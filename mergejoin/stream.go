package mergejoin

import (
	"context"
	"sync"
)

// SliceStream adapts an in-memory slice to the Stream interface, serving
// rows in pages of PageSize. It is primarily a test and fixture helper;
// production inputs implement Stream directly.
type SliceStream[P any] struct {
	mu       sync.Mutex
	rows     []Row[P]
	pageSize int
	offset   int
	closed   bool
}

// NewSliceStream wraps rows. pageSize is clamped to at least one.
func NewSliceStream[P any](rows []Row[P], pageSize int) *SliceStream[P] {
	if pageSize < 1 {
		pageSize = 1
	}
	return &SliceStream[P]{rows: rows, pageSize: pageSize}
}

// NextPage returns the next non-overlapping page, or io.EOF when exhausted.
func (s *SliceStream[P]) NextPage(_ context.Context) ([]Row[P], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, ErrStreamClosed
	}
	if s.offset >= len(s.rows) {
		return nil, errEOF()
	}
	end := s.offset + s.pageSize
	if end > len(s.rows) {
		end = len(s.rows)
	}
	page := s.rows[s.offset:end:end]
	s.offset = end
	return page, nil
}

// Close marks the stream closed.
func (s *SliceStream[P]) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}
