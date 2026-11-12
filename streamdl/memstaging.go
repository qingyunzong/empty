package streamdl

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sync"
)

// MemStaging is an in-memory Staging implementation intended for tests.
// CommitFail, when non-nil, is invoked before every Commit; returning an
// error simulates a failed durability barrier and must leave the previous
// savepoint intact.
type MemStaging struct {
	mu         sync.Mutex
	data       []byte
	etag       string
	total      int64
	exists     bool
	CommitFail func(persistedLength int64) error
}

// NewMemStaging constructs an empty in-memory staging store.
func NewMemStaging() *MemStaging {
	return &MemStaging{}
}

func (s *MemStaging) Load(_ context.Context) (Staged, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.exists {
		return Staged{}, false, nil
	}
	return Staged{Length: int64(len(s.data)), ETag: s.etag, Total: s.total}, true, nil
}

func (s *MemStaging) Begin(_ context.Context, start int64, etag string, total int64) (Txn, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.exists && start != 0 {
		return nil, errors.New("streamdl: cannot resume empty staging")
	}
	if s.exists && int64(len(s.data)) != start {
		return nil, errors.New("streamdl: resume start does not match staged length")
	}
	return &memTxn{
		stage: s,
		buf:   bytes.NewBuffer(append([]byte(nil), s.data...)),
		base:  start,
		etag:  etag,
		total: total,
	}, nil
}

func (s *MemStaging) Reader(_ context.Context) (io.ReadCloser, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.exists {
		return nil, 0, errors.New("streamdl: nothing staged")
	}
	return io.NopCloser(bytes.NewReader(append([]byte(nil), s.data...))), int64(len(s.data)), nil
}
func (s *MemStaging) Discard(_ context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = nil
	s.etag = ""
	s.total = 0
	s.exists = false
	return nil
}

func (s *MemStaging) Publish(_ context.Context, dst string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.exists {
		return errors.New("streamdl: nothing staged to publish")
	}
	return os.WriteFile(dst, append([]byte(nil), s.data...), 0o644)
}

type memTxn struct {
	stage *MemStaging
	buf   *bytes.Buffer
	base  int64
	etag  string
	total int64
	done  bool
}

func (t *memTxn) Write(p []byte) (int, error) {
	if t.done {
		return 0, errors.New("streamdl: write on closed staging transaction")
	}
	return t.buf.Write(p)
}

func (t *memTxn) Commit(_ context.Context) (int64, error) {
	if t.done {
		return 0, errors.New("streamdl: commit on closed staging transaction")
	}
	length := int64(t.buf.Len())
	if length > t.total {
		t.done = true
		return 0, errors.New("streamdl: staged length exceeds total")
	}
	if t.stage.CommitFail != nil {
		if err := t.stage.CommitFail(length); err != nil {
			// Keep the previous savepoint: the transaction buffer is dropped.
			t.done = true
			return 0, err
		}
	}
	t.stage.mu.Lock()
	defer t.stage.mu.Unlock()
	t.stage.data = append([]byte(nil), t.buf.Bytes()...)
	t.stage.etag = t.etag
	t.stage.total = t.total
	t.stage.exists = true
	t.done = true
	return length, nil
}

func (t *memTxn) Rollback(_ context.Context) error {
	if t.done {
		return nil
	}
	t.buf.Reset()
	t.done = true
	return nil
}
