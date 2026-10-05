// Package archive implements a content-addressed block archive store.
//
// Blocks are located by a short digest and confirmed by comparing full
// bytes, so a colliding digest function never corrupts dedup. Publishing
// a manifest and bumping block reference counts happen in one critical
// section; retries of the same manifest ID are no-ops. On Open the store
// scans manifests to repair reference counts, keeps staged blocks that
// were never published, and Extract verifies the full archive bytes
// against the manifest checksum.
package archive

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// DigestFunc computes the short digest used to locate candidate blocks.
// It is injectable so tests can force collisions.
type DigestFunc func(data []byte) uint64

// DefaultDigest uses the first 8 bytes of SHA-256.
func DefaultDigest(data []byte) uint64 {
	sum := sha256.Sum256(data)
	return binary.BigEndian.Uint64(sum[:8])
}

// Manifest describes a published archive: an ordered list of block
// hashes plus the size and SHA-256 of the full extracted bytes.
type Manifest struct {
	ID     string   `json:"id"`
	Blocks []string `json:"blocks"`
	Size   int64    `json:"size"`
	SHA256 string   `json:"sha256"`
}

// Store is a block archive rooted at a directory:
//
//	blocks/<sha256-hex>    block contents
//	manifests/<id>.json    published manifests
//	counts.json            persisted reference counts (repaired on Open)
type Store struct {
	dir    string
	digest DigestFunc

	mu        sync.Mutex
	index     map[uint64][]string // short digest -> block hashes
	where     map[string]uint64   // block hash -> its short digest
	counts    map[string]int      // block hash -> reference count
	manifests map[string]Manifest
}

// Option configures a Store.
type Option func(*Store)

// WithDigestFunc overrides the short digest function.
func WithDigestFunc(fn DigestFunc) Option {
	return func(s *Store) { s.digest = fn }
}

// Open opens (or creates) the store at dir and runs recovery: manifests
// on disk are scanned to rebuild reference counts, and staged blocks
// that were never published are kept.
func Open(dir string, opts ...Option) (*Store, error) {
	s := &Store{
		dir:       dir,
		digest:    DefaultDigest,
		index:     map[uint64][]string{},
		where:     map[string]uint64{},
		counts:    map[string]int{},
		manifests: map[string]Manifest{},
	}
	for _, opt := range opts {
		opt(s)
	}
	for _, sub := range []string{"blocks", "manifests"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return nil, err
		}
	}
	if err := s.loadBlocks(); err != nil {
		return nil, err
	}
	if err := s.recover(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) blockPath(hash string) string {
	return filepath.Join(s.dir, "blocks", hash)
}

func (s *Store) manifestPath(id string) string {
	return filepath.Join(s.dir, "manifests", id+".json")
}

func (s *Store) countsPath() string {
	return filepath.Join(s.dir, "counts.json")
}

// loadBlocks rebuilds the short-digest index from blocks on disk and
// verifies each block's content matches its hash name.
func (s *Store) loadBlocks() error {
	entries, err := os.ReadDir(filepath.Join(s.dir, "blocks"))
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, "blocks", e.Name()))
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != e.Name() {
			return fmt.Errorf("archive: block %s content does not match its hash", e.Name())
		}
		short := s.digest(data)
		s.index[short] = append(s.index[short], e.Name())
		s.where[e.Name()] = short
	}
	return nil
}

// recover scans manifests on disk and rebuilds reference counts from
// scratch, repairing any counts lost or corrupted by a crash. Staged
// blocks with zero references are left untouched.
func (s *Store) recover() error {
	entries, err := os.ReadDir(filepath.Join(s.dir, "manifests"))
	if err != nil {
		return err
	}
	counts := map[string]int{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, "manifests", e.Name()))
		if err != nil {
			return err
		}
		var m Manifest
		if err := json.Unmarshal(data, &m); err != nil {
			return fmt.Errorf("archive: manifest %s: %w", e.Name(), err)
		}
		s.manifests[m.ID] = m
		for _, hash := range unique(m.Blocks) {
			counts[hash]++
		}
	}
	s.counts = counts
	return s.saveCountsLocked()
}

// Put stores data as a block and returns its hex SHA-256 hash. Existing
// blocks are located by short digest and confirmed by comparing full
// bytes, so digest collisions never cause false dedup.
func (s *Store) Put(data []byte) (string, error) {
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	short := s.digest(data)

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, candidate := range s.index[short] {
		if candidate != hash {
			continue // digest collision: same bucket, different content
		}
		existing, err := os.ReadFile(s.blockPath(hash))
		if err != nil {
			return "", err
		}
		if !bytes.Equal(existing, data) {
			return "", fmt.Errorf("archive: block %s content mismatch", hash)
		}
		return hash, nil // already stored
	}

	if err := writeFileAtomic(s.blockPath(hash), data, 0o644); err != nil {
		return "", err
	}
	s.index[short] = append(s.index[short], hash)
	s.where[hash] = short
	return hash, nil
}

// Publish atomically records a manifest and increments the reference
// counts of its blocks. Publishing the same ID again is a no-op, so
// retries never double-count. The manifest file is made durable before
// counts.json is rewritten; a crash in between is repaired by recovery
// on the next Open.
func (s *Store) Publish(id string, blocks []string) (Manifest, error) {
	if id == "" || id == "." || id == ".." || strings.ContainsAny(id, `/\`) {
		return Manifest{}, fmt.Errorf("archive: invalid manifest id %q", id)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if m, ok := s.manifests[id]; ok {
		return m, nil // retry of an already-published manifest
	}

	m := Manifest{ID: id, Blocks: append([]string(nil), blocks...)}
	h := sha256.New()
	for _, hash := range blocks {
		data, err := os.ReadFile(s.blockPath(hash))
		if err != nil {
			return Manifest{}, fmt.Errorf("archive: publish %s: %w", id, err)
		}
		h.Write(data)
		m.Size += int64(len(data))
	}
	m.SHA256 = hex.EncodeToString(h.Sum(nil))

	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return Manifest{}, err
	}
	if err := writeFileAtomic(s.manifestPath(id), data, 0o644); err != nil {
		return Manifest{}, err
	}
	for _, hash := range unique(m.Blocks) {
		s.counts[hash]++
	}
	if err := s.saveCountsLocked(); err != nil {
		return Manifest{}, err
	}
	s.manifests[id] = m
	return m, nil
}

// Release removes a manifest and decrements reference counts, collecting
// blocks whose count reaches zero. Releasing an unknown ID is a no-op.
func (s *Store) Release(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	m, ok := s.manifests[id]
	if !ok {
		return nil
	}
	if err := os.Remove(s.manifestPath(id)); err != nil {
		return err
	}
	delete(s.manifests, id)
	for _, hash := range unique(m.Blocks) {
		s.counts[hash]--
		if s.counts[hash] <= 0 {
			delete(s.counts, hash)
			if err := os.Remove(s.blockPath(hash)); err != nil {
				return err
			}
			short := s.where[hash]
			delete(s.where, hash)
			bucket := s.index[short]
			for i, h := range bucket {
				if h == hash {
					s.index[short] = append(bucket[:i], bucket[i+1:]...)
					break
				}
			}
		}
	}
	return s.saveCountsLocked()
}

// Extract reassembles the archive identified by id and verifies the full
// bytes against the manifest's size and SHA-256.
func (s *Store) Extract(id string) ([]byte, error) {
	s.mu.Lock()
	m, ok := s.manifests[id]
	s.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("archive: unknown manifest %q", id)
	}

	var buf bytes.Buffer
	h := sha256.New()
	for _, hash := range m.Blocks {
		data, err := os.ReadFile(s.blockPath(hash))
		if err != nil {
			return nil, fmt.Errorf("archive: extract %s: %w", id, err)
		}
		buf.Write(data)
		h.Write(data)
	}
	out := buf.Bytes()
	if int64(len(out)) != m.Size || hex.EncodeToString(h.Sum(nil)) != m.SHA256 {
		return nil, fmt.Errorf("archive: extract %s: full-byte checksum mismatch", id)
	}
	return out, nil
}

// RefCount returns the reference count of a block.
func (s *Store) RefCount(hash string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.counts[hash]
}

// BlockExists reports whether a block file is present, including staged
// blocks that no manifest references yet.
func (s *Store) BlockExists(hash string) bool {
	_, err := os.Stat(s.blockPath(hash))
	return err == nil
}

// Manifest returns the published manifest for id.
func (s *Store) Manifest(id string) (Manifest, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.manifests[id]
	return m, ok
}

func (s *Store) saveCountsLocked() error {
	data, err := json.MarshalIndent(s.counts, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(s.countsPath(), data, 0o644)
}

func unique(hashes []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, h := range hashes {
		if !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	return out
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}
