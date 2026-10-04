package trend

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	rootFile  = "root"
	rootTmp   = "root.tmp"
	segPrefix = "seg-"
	segSuffix = ".seg"
)

// fileStore abstracts the durable operations the store relies on, so crash
// behaviour can be simulated in tests.
type fileStore interface {
	// WriteFile durably writes data (fsync before returning).
	WriteFile(name string, data []byte) error
	// Rename atomically replaces new with old and fsyncs the directory.
	Rename(old, new string) error
	ReadFile(name string) ([]byte, error)
	Remove(name string) error
	List() ([]string, error)
}

// dirFS is a fileStore backed by a real directory.
type dirFS struct {
	dir string
}

func newDirFS(dir string) *dirFS { return &dirFS{dir: dir} }

func (d *dirFS) WriteFile(name string, data []byte) error {
	p := filepath.Join(d.dir, name)
	f, err := os.OpenFile(p, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
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
	return f.Close()
}

func (d *dirFS) Rename(old, new string) error {
	if err := os.Rename(filepath.Join(d.dir, old), filepath.Join(d.dir, new)); err != nil {
		return err
	}
	dir, err := os.Open(d.dir)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (d *dirFS) ReadFile(name string) ([]byte, error) {
	return os.ReadFile(filepath.Join(d.dir, name))
}

func (d *dirFS) Remove(name string) error {
	err := os.Remove(filepath.Join(d.dir, name))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (d *dirFS) List() ([]string, error) {
	entries, err := os.ReadDir(d.dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names, nil
}

// rootMeta is the committed root: the current version and its segments.
type rootMeta struct {
	Version  int
	Segments []string
}

// encodeRecord serializes v as "<crc32-hex>\n<json>".
func encodeRecord(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return []byte(fmt.Sprintf("%08x\n%s", crc32.ChecksumIEEE(b), b))
}

func decodeRecord(data []byte, v any) error {
	i := bytes.IndexByte(data, '\n')
	if i < 0 {
		return fmt.Errorf("corrupt record: missing checksum line")
	}
	var sum uint32
	if _, err := fmt.Sscanf(string(data[:i]), "%08x", &sum); err != nil {
		return fmt.Errorf("corrupt record: bad checksum: %w", err)
	}
	if crc32.ChecksumIEEE(data[i+1:]) != sum {
		return fmt.Errorf("corrupt record: checksum mismatch")
	}
	return json.Unmarshal(data[i+1:], v)
}

// Store persists an index as append-only batch segments plus an atomically
// published root file.
type Store struct {
	fs       fileStore
	Index    *Index
	version  int
	segments []string
}

// OpenStore opens or initializes a store, recovering from any interrupted
// publish: a stale root.tmp and unreferenced segments are discarded, so the
// recovered state is always exactly the last fully published root.
func OpenStore(fstore fileStore) (*Store, error) {
	meta := rootMeta{Version: 0}
	names, err := fstore.List()
	if err != nil {
		return nil, err
	}
	existing := make(map[string]bool, len(names))
	for _, n := range names {
		existing[n] = true
	}
	if existing[rootFile] {
		data, err := fstore.ReadFile(rootFile)
		if err != nil {
			return nil, err
		}
		if err := decodeRecord(data, &meta); err != nil {
			return nil, fmt.Errorf("recover root: %w", err)
		}
	}
	// Discard an interrupted publish.
	if existing[rootTmp] {
		if err := fstore.Remove(rootTmp); err != nil {
			return nil, err
		}
	}
	// Discard segments not referenced by the committed root.
	referenced := make(map[string]bool, len(meta.Segments))
	for _, s := range meta.Segments {
		referenced[s] = true
	}
	for _, n := range names {
		if strings.HasPrefix(n, segPrefix) && strings.HasSuffix(n, segSuffix) && !referenced[n] {
			if err := fstore.Remove(n); err != nil {
				return nil, err
			}
		}
	}
	// Replay the committed segments.
	idx := NewIndex()
	for _, seg := range meta.Segments {
		data, err := fstore.ReadFile(seg)
		if err != nil {
			return nil, fmt.Errorf("recover segment %s: %w", seg, err)
		}
		var b Batch
		if err := decodeRecord(data, &b); err != nil {
			return nil, fmt.Errorf("recover segment %s: %w", seg, err)
		}
		if _, err := idx.Commit(b); err != nil {
			return nil, fmt.Errorf("recover segment %s: %w", seg, err)
		}
	}
	return &Store{fs: fstore, Index: idx, version: meta.Version, segments: meta.Segments}, nil
}

// Version returns the last published version.
func (s *Store) Version() int { return s.version }

// Publish durably commits a batch as the next version. The root publish is
// atomic: a crash at any point leaves either the previous root or the new
// one fully visible after recovery, never a torn state.
func (s *Store) Publish(b Batch) (int, error) {
	if err := s.Index.validate(b); err != nil {
		return 0, err
	}
	segName := fmt.Sprintf("%s%06d%s", segPrefix, s.version+1, segSuffix)
	if err := s.fs.WriteFile(segName, encodeRecord(b)); err != nil {
		return 0, err
	}
	meta := rootMeta{
		Version:  s.version + 1,
		Segments: append(append([]string(nil), s.segments...), segName),
	}
	if err := s.fs.WriteFile(rootTmp, encodeRecord(meta)); err != nil {
		return 0, err
	}
	if err := s.fs.Rename(rootTmp, rootFile); err != nil {
		return 0, err
	}
	if _, err := s.Index.Commit(b); err != nil {
		return 0, err
	}
	s.version = meta.Version
	s.segments = meta.Segments
	return s.version, nil
}
