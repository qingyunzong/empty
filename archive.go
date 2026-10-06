// Package archive implements a content-addressed block archive with
// reference-counted blocks and transactionally published manifests.
//
// Blocks are located by a short digest prefix and confirmed by
// re-hashing their bytes, so collisions in the short prefix are
// tolerated. Publishing a manifest and incrementing block reference
// counts happen in one critical section; a publish carries an
// operation ID so retries never double-count. After a crash, Open
// rescans all manifests to repair reference counts while leaving
// unpublished staging blocks untouched.
package archive

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// Digest identifies a block by content.
type Digest [32]byte

func (d Digest) String() string { return hex.EncodeToString(d[:]) }

// shortOf returns the short digest prefix used to locate candidate blocks.
func shortOf(d Digest) string { return hex.EncodeToString(d[:4]) }

// ErrNotFound is returned when no committed block matches a digest.
var ErrNotFound = errors.New("archive: block not found")

type manifest struct {
	ID     string   `json:"id"`
	OpID   string   `json:"op_id"`
	Blocks []string `json:"blocks"`
}

// Store is a content-addressed block archive rooted at a directory.
type Store struct {
	dir        string
	digestFunc func([]byte) Digest

	mu        sync.Mutex
	index     map[string][]Digest // short digest -> committed block digests
	refcounts map[Digest]int
	ops       map[string]bool // applied publish operation IDs
}

// Option configures a Store.
type Option func(*Store)

// WithDigestFunc overrides the digest function. Tests use it to inject
// short-digest collisions.
func WithDigestFunc(f func([]byte) Digest) Option {
	return func(s *Store) { s.digestFunc = f }
}

// Open opens (or creates) the store at dir and runs crash recovery:
// the block index is rebuilt from committed blocks and reference counts
// are repaired by scanning all published manifests. Staging blocks that
// were never published are kept as-is.
func Open(dir string, opts ...Option) (*Store, error) {
	s := &Store{
		dir: dir,
		digestFunc: func(b []byte) Digest {
			return Digest(sha256.Sum256(b))
		},
		index:     make(map[string][]Digest),
		refcounts: make(map[Digest]int),
		ops:       make(map[string]bool),
	}
	for _, o := range opts {
		o(s)
	}
	for _, sub := range []string{"blocks", "staging", "manifests"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return nil, err
		}
	}
	if err := s.rebuildIndex(); err != nil {
		return nil, err
	}
	if err := s.repairRefcounts(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) blocksDir() string    { return filepath.Join(s.dir, "blocks") }
func (s *Store) stagingDir() string   { return filepath.Join(s.dir, "staging") }
func (s *Store) manifestsDir() string { return filepath.Join(s.dir, "manifests") }

// Dir returns the store's root directory.
func (s *Store) Dir() string { return s.dir }

func (s *Store) blockPath(d Digest) string {
	return filepath.Join(s.blocksDir(), d.String())
}

func (s *Store) stagingPath(d Digest) string {
	return filepath.Join(s.stagingDir(), d.String())
}

// Stage writes data as an unpublished staging block and returns its digest.
func (s *Store) Stage(data []byte) (Digest, error) {
	d := s.digestFunc(data)
	if err := writeFileAtomic(s.stagingPath(d), data, 0o644); err != nil {
		return Digest{}, err
	}
	return d, nil
}

// Publish atomically commits the staged blocks and records the manifest,
// incrementing block reference counts in the same critical section.
// Publishing again with the same opID is a no-op, so retries never
// double-count.
func (s *Store) Publish(opID, manifestID string, blocks []Digest) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.ops[opID] {
		return nil
	}
	if _, err := os.Stat(filepath.Join(s.manifestsDir(), manifestID+".json")); err == nil {
		return fmt.Errorf("archive: manifest %q already published under another operation", manifestID)
	}

	// Move staged blocks into the committed store. A block that is
	// already committed (e.g. a retry after a crash mid-publish) is
	// left in place.
	for _, d := range blocks {
		dst := s.blockPath(d)
		if _, err := os.Stat(dst); err == nil {
			continue
		}
		if err := os.Rename(s.stagingPath(d), dst); err != nil {
			return fmt.Errorf("archive: block %s not staged: %w", d, err)
		}
		short := shortOf(d)
		if !containsDigest(s.index[short], d) {
			s.index[short] = append(s.index[short], d)
		}
	}

	m := manifest{ID: manifestID, OpID: opID, Blocks: make([]string, len(blocks))}
	for i, d := range blocks {
		m.Blocks[i] = d.String()
	}
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(s.manifestsDir(), manifestID+".json"), data, 0o644); err != nil {
		return err
	}

	for _, d := range blocks {
		s.refcounts[d]++
	}
	if err := s.persistRefcountsLocked(); err != nil {
		return err
	}
	s.ops[opID] = true
	return nil
}

// Get returns the committed block for d. Candidates are located by the
// short digest prefix and confirmed by re-hashing their bytes, so
// colliding prefixes never return the wrong block.
func (s *Store) Get(d Digest) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, cand := range s.index[shortOf(d)] {
		data, err := os.ReadFile(s.blockPath(cand))
		if err != nil {
			continue
		}
		if s.digestFunc(data) == d {
			return data, nil
		}
	}
	return nil, ErrNotFound
}

// Refcount returns the reference count of a block.
func (s *Store) Refcount(d Digest) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refcounts[d]
}

// StagedBlocks lists digests of unpublished staging blocks.
func (s *Store) StagedBlocks() ([]Digest, error) {
	entries, err := os.ReadDir(s.stagingDir())
	if err != nil {
		return nil, err
	}
	var out []Digest
	for _, e := range entries {
		d, err := ParseDigest(e.Name())
		if err == nil {
			out = append(out, d)
		}
	}
	return out, nil
}

// Extract reads a manifest and concatenates its block bytes in order.
func (s *Store) Extract(manifestID string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.readManifestLocked(manifestID)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	for _, hexDigest := range m.Blocks {
		d, err := ParseDigest(hexDigest)
		if err != nil {
			return nil, err
		}
		data, err := s.getLocked(d)
		if err != nil {
			return nil, fmt.Errorf("archive: manifest %q: %w", manifestID, err)
		}
		buf.Write(data)
	}
	return buf.Bytes(), nil
}

// Verify extracts the manifest and checks the full de-archived bytes
// against want.
func (s *Store) Verify(manifestID string, want []byte) error {
	got, err := s.Extract(manifestID)
	if err != nil {
		return err
	}
	if !bytes.Equal(got, want) {
		return fmt.Errorf("archive: manifest %q: extracted %d bytes, want %d bytes (content mismatch: %v)",
			manifestID, len(got), len(want), !bytes.Equal(got, want))
	}
	return nil
}

// ParseDigest parses a hex digest string.
func ParseDigest(s string) (Digest, error) {
	var d Digest
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != len(d) {
		return d, fmt.Errorf("archive: invalid digest %q", s)
	}
	copy(d[:], b)
	return d, nil
}

func (s *Store) getLocked(d Digest) ([]byte, error) {
	for _, cand := range s.index[shortOf(d)] {
		data, err := os.ReadFile(s.blockPath(cand))
		if err != nil {
			continue
		}
		if s.digestFunc(data) == d {
			return data, nil
		}
	}
	return nil, ErrNotFound
}

func (s *Store) readManifestLocked(manifestID string) (*manifest, error) {
	data, err := os.ReadFile(filepath.Join(s.manifestsDir(), manifestID+".json"))
	if err != nil {
		return nil, err
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// rebuildIndex scans committed blocks and rebuilds the short-digest index.
func (s *Store) rebuildIndex() error {
	entries, err := os.ReadDir(s.blocksDir())
	if err != nil {
		return err
	}
	for _, e := range entries {
		d, err := ParseDigest(e.Name())
		if err != nil {
			continue
		}
		short := shortOf(d)
		if !containsDigest(s.index[short], d) {
			s.index[short] = append(s.index[short], d)
		}
	}
	return nil
}

// repairRefcounts rescans every published manifest and rebuilds reference
// counts and the applied-operation set from scratch, repairing any drift
// caused by a crash. Staging blocks are deliberately left alone.
func (s *Store) repairRefcounts() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := os.ReadDir(s.manifestsDir())
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)

	s.refcounts = make(map[Digest]int)
	s.ops = make(map[string]bool)
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(s.manifestsDir(), name))
		if err != nil {
			return err
		}
		var m manifest
		if err := json.Unmarshal(data, &m); err != nil {
			return fmt.Errorf("archive: corrupt manifest %q: %w", name, err)
		}
		s.ops[m.OpID] = true
		for _, hexDigest := range m.Blocks {
			d, err := ParseDigest(hexDigest)
			if err != nil {
				return err
			}
			s.refcounts[d]++
		}
	}
	return s.persistRefcountsLocked()
}

func (s *Store) persistRefcountsLocked() error {
	m := make(map[string]int, len(s.refcounts))
	for d, n := range s.refcounts {
		m[d.String()] = n
	}
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(s.dir, "refcounts.json"), data, 0o644)
}

func containsDigest(list []Digest, d Digest) bool {
	for _, x := range list {
		if x == d {
			return true
		}
	}
	return false
}

// writeFileAtomic writes data to path via a temp file, fsync, and rename.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
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
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		dir.Sync()
		dir.Close()
	}
	return nil
}
