package trendlib

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	baseFileName = "base.json"
	rootFileName = "ROOT"
	batchPrefix  = "batch-"
)

// ErrCrash is returned by Store.PublishBatch when a simulated crash
// failpoint triggers, leaving the on-disk state exactly where a real crash
// would leave it.
var ErrCrash = errors.New("trendlib: simulated crash")

// Store persists an Index to a directory. A batch update writes and syncs
// its data file first, then atomically publishes the new root pointer via
// rename, so recovery after a crash always finds either the old or the new
// root, never a partially published batch.
type Store struct {
	dir string
	idx *Index

	// Failpoint simulates a crash during PublishBatch: "start" crashes
	// before any write, "data" crashes after the batch data is durable but
	// before the root is published.
	Failpoint string
}

// CreateStore initializes a store in dir with the base samples as
// version 0.
func CreateStore(dir string, base []Sample) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	data, err := json.Marshal(base)
	if err != nil {
		return nil, err
	}
	if err := atomicWrite(dir, baseFileName, data); err != nil {
		return nil, err
	}
	if err := atomicWrite(dir, rootFileName, []byte("0")); err != nil {
		return nil, err
	}
	return &Store{dir: dir, idx: NewIndex(base)}, nil
}

// OpenStore recovers a store from dir, replaying committed batches up to
// the published root. Orphaned batch files newer than the root (left by a
// crash before root publish) are ignored, and stale temporary files are
// removed.
func OpenStore(dir string) (*Store, error) {
	root, err := readRoot(dir)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, baseFileName))
	if err != nil {
		return nil, err
	}
	var base []Sample
	if err := json.Unmarshal(data, &base); err != nil {
		return nil, fmt.Errorf("trendlib: corrupt base: %w", err)
	}
	idx := NewIndex(base)
	for v := 1; v <= root; v++ {
		b, err := readBatch(dir, v)
		if err != nil {
			return nil, err
		}
		idx.Publish(b)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
	return &Store{dir: dir, idx: idx}, nil
}

// Index returns the in-memory index reconstructed from durable state.
func (s *Store) Index() *Index { return s.idx }

// PublishBatch durably commits b as the next version: batch data file
// first, then an atomic root publish.
func (s *Store) PublishBatch(b Batch) (int, error) {
	if s.Failpoint == "start" {
		return 0, ErrCrash
	}
	v := s.idx.Version() + 1
	data, err := json.Marshal(b)
	if err != nil {
		return 0, err
	}
	if err := atomicWrite(s.dir, batchFileName(v), data); err != nil {
		return 0, err
	}
	if s.Failpoint == "data" {
		return 0, ErrCrash
	}
	if err := atomicWrite(s.dir, rootFileName, []byte(strconv.Itoa(v))); err != nil {
		return 0, err
	}
	return s.idx.Publish(b), nil
}

func batchFileName(v int) string { return batchPrefix + strconv.Itoa(v) + ".json" }

func readBatch(dir string, v int) (Batch, error) {
	data, err := os.ReadFile(filepath.Join(dir, batchFileName(v)))
	if err != nil {
		return Batch{}, err
	}
	var b Batch
	if err := json.Unmarshal(data, &b); err != nil {
		return Batch{}, fmt.Errorf("trendlib: corrupt batch %d: %w", v, err)
	}
	return b, nil
}

func readRoot(dir string) (int, error) {
	data, err := os.ReadFile(filepath.Join(dir, rootFileName))
	if err != nil {
		return 0, err
	}
	v, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0, fmt.Errorf("trendlib: corrupt root: %w", err)
	}
	return v, nil
}

// atomicWrite writes data to a temp file, fsyncs it, renames it over the
// target and fsyncs the directory.
func atomicWrite(dir, name string, data []byte) error {
	tmp := filepath.Join(dir, name+".tmp")
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, name)); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
