package streamdl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// FileStaging is a Staging reference implementation backed by a data file and
// an atomically replaced metadata file in Dir.
//
// Each Txn.Commit fsyncs the data file and then atomically renames a metadata
// file into place. The on-disk length therefore always describes fully
// persisted bytes; a crash between the two operations simply rolls the store
// back to the previous savepoint. Publish replaces the destination atomically.
type FileStaging struct {
	Dir string

	mu    sync.Mutex
	txnMu sync.Mutex
}

type fileMeta struct {
	Length int64  `json:"length"`
	ETag   string `json:"etag"`
	Total  int64  `json:"total"`
}

func (s *FileStaging) dataPath() string { return filepath.Join(s.Dir, "staging.part") }
func (s *FileStaging) metaPath() string { return filepath.Join(s.Dir, "staging.meta.json") }

// Load returns the last durable savepoint.
func (s *FileStaging) Load(_ context.Context) (Staged, bool, error) {
	raw, err := os.ReadFile(s.metaPath())
	if errors.Is(err, os.ErrNotExist) {
		return Staged{}, false, nil
	}
	if err != nil {
		return Staged{}, false, err
	}
	var meta fileMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return Staged{}, false, fmt.Errorf("streamdl: corrupt staging metadata: %w", err)
	}
	info, err := os.Stat(s.dataPath())
	if err != nil {
		return Staged{}, false, err
	}
	if info.Size() < meta.Length {
		return Staged{}, false, fmt.Errorf("streamdl: data file %d bytes shorter than staged length %d",
			info.Size(), meta.Length)
	}
	return Staged{Length: meta.Length, ETag: meta.ETag, Total: meta.Total}, true, nil
}

// Begin opens an append transaction. Any uncommitted bytes beyond start from a
// previous interrupted transaction are truncated before new writes begin.
func (s *FileStaging) Begin(_ context.Context, start int64, etag string, total int64) (Txn, error) {
	s.txnMu.Lock()

	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		s.txnMu.Unlock()
		return nil, err
	}
	f, err := os.OpenFile(s.dataPath(), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		s.txnMu.Unlock()
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		s.txnMu.Unlock()
		return nil, err
	}
	if info.Size() != start {
		if err := f.Truncate(start); err != nil {
			_ = f.Close()
			s.txnMu.Unlock()
			return nil, err
		}
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		_ = f.Close()
		s.txnMu.Unlock()
		return nil, err
	}

	return &fileTxn{
		stage: s,
		file:  f,
		base:  start,
		etag:  etag,
		total: total,
	}, nil
}

// Reader returns the persisted prefix.
func (s *FileStaging) Reader(_ context.Context) (io.ReadCloser, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	raw, err := os.ReadFile(s.metaPath())
	if err != nil {
		return nil, 0, err
	}
	var meta fileMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, 0, err
	}
	f, err := os.Open(s.dataPath())
	if err != nil {
		return nil, 0, err
	}
	return f, meta.Length, nil
}

// Discard removes data and metadata.
func (s *FileStaging) Discard(_ context.Context) error {
	if err := os.Remove(s.dataPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Remove(s.metaPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Publish atomically materializes the fully persisted content at dst.
func (s *FileStaging) Publish(_ context.Context, dst string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	raw, err := os.ReadFile(s.metaPath())
	if err != nil {
		return err
	}
	var meta fileMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	// Copy through a sibling temp file so the final rename is atomic even
	// across different directories, then fsync before the rename.
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".publish-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	src, err := os.Open(s.dataPath())
	if err != nil {
		_ = tmp.Close()
		return err
	}
	n, err := io.Copy(tmp, io.LimitReader(src, meta.Length))
	_ = src.Close()
	if err != nil {
		_ = tmp.Close()
		return err
	}
	if n != meta.Length {
		_ = tmp.Close()
		return fmt.Errorf("streamdl: publish copied %d bytes, expected %d", n, meta.Length)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, dst)
}

type fileTxn struct {
	stage   *FileStaging
	file    *os.File
	base    int64
	written int64
	etag    string
	total   int64
	closed  bool
}

func (t *fileTxn) Write(p []byte) (int, error) {
	if t.closed {
		return 0, errors.New("streamdl: write on closed staging transaction")
	}
	n, err := t.file.Write(p)
	t.written += int64(n)
	return n, err
}

func (t *fileTxn) Commit(_ context.Context) (int64, error) {
	if t.closed {
		return 0, errors.New("streamdl: commit on closed staging transaction")
	}
	length := t.base + t.written
	if length > t.total {
		t.closed = true
		_ = t.file.Close()
		t.stage.txnMu.Unlock()
		return 0, fmt.Errorf("streamdl: staged length %d exceeds total %d", length, t.total)
	}

	if err := t.file.Sync(); err != nil {
		return 0, err
	}
	meta := fileMeta{Length: length, ETag: t.etag, Total: t.total}
	raw, err := json.Marshal(&meta)
	if err != nil {
		return 0, err
	}
	if err := atomicWriteFile(t.stage.metaPath(), raw, 0o644); err != nil {
		return 0, err
	}
	if err := t.file.Close(); err != nil {
		return 0, err
	}
	t.closed = true
	t.stage.txnMu.Unlock()
	return length, nil
}

func (t *fileTxn) Rollback(_ context.Context) error {
	if t.closed {
		return nil
	}
	_ = t.file.Truncate(t.base)
	err := t.file.Close()
	t.closed = true
	t.stage.txnMu.Unlock()
	return err
}

// atomicWriteFile writes data to path via a sibling temp file and an atomic
// rename, fsyncing both the file and its directory.
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".meta-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	df, err := os.Open(dir)
	if err == nil {
		_ = df.Sync()
		_ = df.Close()
	}
	return nil
}
