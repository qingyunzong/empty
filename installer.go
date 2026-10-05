// Package recovery implements chunked snapshot installation for node
// recovery. Chunks are received into a staging area, the payload digest is
// verified once all chunks arrive, and the snapshot is published
// atomically. A crash or restart at any point leaves either the complete
// old state or the complete new state on disk.
package recovery

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

var (
	ErrNoSession       = errors.New("recovery: no snapshot installation in progress")
	ErrSessionActive   = errors.New("recovery: snapshot installation already in progress for this version")
	ErrVersionMismatch = errors.New("recovery: chunk belongs to a different snapshot version")
	ErrChunkRange      = errors.New("recovery: chunk sequence number out of range")
	ErrChunkConflict   = errors.New("recovery: duplicate chunk with different content")
	ErrIncomplete      = errors.New("recovery: snapshot chunks missing")
	ErrDigestMismatch  = errors.New("recovery: snapshot digest mismatch")
)

const (
	currentDir  = "current"
	incomingDir = "incoming"
	oldDir      = "old"
	metaFile    = "meta.json"
	payloadFile = "payload"
)

// Meta describes a snapshot being installed or already published.
type Meta struct {
	Version uint64 `json:"version"` // snapshot version / term
	Index   uint64 `json:"index"`   // last log index included in the snapshot
	Chunks  int    `json:"chunks"`  // total number of chunks
	Digest  []byte `json:"digest"`  // sha256 of the assembled payload
}

// Installer receives snapshot chunks and publishes them atomically.
type Installer struct {
	mu      sync.Mutex
	dir     string
	session *Meta // non-nil while an installation is in progress
}

// Open opens (or creates) the installer storage rooted at dir and recovers
// from any interrupted installation: a half-finished publish is rolled
// forward or back, and a half-received snapshot is discarded. After Open
// returns, the on-disk state is either the complete old snapshot or the
// complete new one.
func Open(dir string) (*Installer, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	old := filepath.Join(dir, oldDir)
	current := filepath.Join(dir, currentDir)
	if _, err := os.Stat(old); err == nil {
		if _, err := os.Stat(current); err == nil {
			// Crash after the new snapshot was renamed into place:
			// the new state won, drop the backup of the old one.
			if err := os.RemoveAll(old); err != nil {
				return nil, err
			}
		} else {
			// Crash before the new snapshot was renamed in: roll
			// back to the complete old state.
			if err := os.Rename(old, current); err != nil {
				return nil, err
			}
		}
	}
	// An incomplete incoming snapshot is never published; discard it so
	// the old state remains the only visible one.
	if err := os.RemoveAll(filepath.Join(dir, incomingDir)); err != nil {
		return nil, err
	}
	if err := syncDir(dir); err != nil {
		return nil, err
	}
	return &Installer{dir: dir}, nil
}

// Begin starts a new installation session. If a session for a different
// version is in progress it is aborted and replaced; a session for the
// same version is an error.
func (in *Installer) Begin(m Meta) error {
	in.mu.Lock()
	defer in.mu.Unlock()
	if m.Chunks <= 0 {
		return fmt.Errorf("recovery: chunk count must be positive")
	}
	if len(m.Digest) != sha256.Size {
		return fmt.Errorf("recovery: digest must be %d bytes", sha256.Size)
	}
	if in.session != nil {
		if in.session.Version == m.Version {
			return ErrSessionActive
		}
		if err := in.discardIncomingLocked(); err != nil {
			return err
		}
	}
	incoming := filepath.Join(in.dir, incomingDir)
	if err := os.MkdirAll(incoming, 0o755); err != nil {
		return err
	}
	if err := writeJSONAtomic(filepath.Join(incoming, metaFile), m); err != nil {
		return err
	}
	if err := syncDir(in.dir); err != nil {
		return err
	}
	cp := m
	cp.Digest = append([]byte(nil), m.Digest...)
	in.session = &cp
	return nil
}

// WriteChunk stores one chunk of the active session. Chunks for any other
// version are rejected without touching state. Rewriting a chunk with
// identical content is a no-op; rewriting it with different content aborts
// the installation and reports ErrChunkConflict.
func (in *Installer) WriteChunk(version uint64, seq int, data []byte) error {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.session == nil {
		return ErrNoSession
	}
	if version != in.session.Version {
		return ErrVersionMismatch
	}
	if seq < 0 || seq >= in.session.Chunks {
		return ErrChunkRange
	}
	path := filepath.Join(in.dir, incomingDir, chunkName(seq))
	if existing, err := os.ReadFile(path); err == nil {
		if bytes.Equal(existing, data) {
			return nil
		}
		if derr := in.discardIncomingLocked(); derr != nil {
			return derr
		}
		return ErrChunkConflict
	}
	if err := writeFileAtomic(path, data); err != nil {
		return err
	}
	return syncDir(filepath.Join(in.dir, incomingDir))
}

// Complete finishes the active session: it requires every chunk, verifies
// the assembled payload against the announced digest, and atomically
// publishes the snapshot. On any failure the installation is aborted and
// the previously published state is left untouched.
func (in *Installer) Complete(version uint64) error {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.session == nil {
		return ErrNoSession
	}
	if version != in.session.Version {
		return ErrVersionMismatch
	}
	payload, err := in.assembleLocked()
	if err != nil {
		return err
	}
	sum := sha256.Sum256(payload)
	if !bytes.Equal(sum[:], in.session.Digest) {
		if derr := in.discardIncomingLocked(); derr != nil {
			return derr
		}
		return ErrDigestMismatch
	}
	incoming := filepath.Join(in.dir, incomingDir)
	if err := writeFileAtomic(filepath.Join(incoming, payloadFile), payload); err != nil {
		return err
	}
	for _, seq := range chunkSeqs(incoming) {
		if err := os.Remove(filepath.Join(incoming, chunkName(seq))); err != nil {
			return err
		}
	}
	if err := syncDir(incoming); err != nil {
		return err
	}
	if err := in.publishLocked(); err != nil {
		return err
	}
	in.session = nil
	return nil
}

// Abort discards any in-progress installation.
func (in *Installer) Abort() error {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.session == nil {
		return nil
	}
	return in.discardIncomingLocked()
}

// Installing reports whether a snapshot installation is in progress.
func (in *Installer) Installing() bool {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.session != nil
}

// Session returns the metadata of the in-progress installation, if any.
func (in *Installer) Session() (Meta, bool) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.session == nil {
		return Meta{}, false
	}
	return *in.session, true
}

// Snapshot returns the currently published snapshot metadata and payload.
func (in *Installer) Snapshot() (Meta, []byte, bool) {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.snapshotLocked()
}

func (in *Installer) snapshotLocked() (Meta, []byte, bool) {
	var m Meta
	raw, err := os.ReadFile(filepath.Join(in.dir, currentDir, metaFile))
	if err != nil {
		return Meta{}, nil, false
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return Meta{}, nil, false
	}
	payload, err := os.ReadFile(filepath.Join(in.dir, currentDir, payloadFile))
	if err != nil {
		return Meta{}, nil, false
	}
	return m, payload, true
}

func (in *Installer) assembleLocked() ([]byte, error) {
	incoming := filepath.Join(in.dir, incomingDir)
	var buf bytes.Buffer
	for seq := 0; seq < in.session.Chunks; seq++ {
		data, err := os.ReadFile(filepath.Join(incoming, chunkName(seq)))
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w: chunk %d of %d", ErrIncomplete, seq, in.session.Chunks)
		}
		if err != nil {
			return nil, err
		}
		buf.Write(data)
	}
	return buf.Bytes(), nil
}

// publishLocked swaps incoming into place as current via rename. Recovery
// in Open guarantees the swap resolves to old-complete or new-complete.
func (in *Installer) publishLocked() error {
	current := filepath.Join(in.dir, currentDir)
	old := filepath.Join(in.dir, oldDir)
	incoming := filepath.Join(in.dir, incomingDir)
	if err := os.RemoveAll(old); err != nil {
		return err
	}
	if _, err := os.Stat(current); err == nil {
		if err := os.Rename(current, old); err != nil {
			return err
		}
		if err := syncDir(in.dir); err != nil {
			return err
		}
	}
	if err := os.Rename(incoming, current); err != nil {
		return err
	}
	if err := syncDir(in.dir); err != nil {
		return err
	}
	if err := os.RemoveAll(old); err != nil {
		return err
	}
	return syncDir(in.dir)
}

func (in *Installer) discardIncomingLocked() error {
	in.session = nil
	if err := os.RemoveAll(filepath.Join(in.dir, incomingDir)); err != nil {
		return err
	}
	return syncDir(in.dir)
}

func chunkName(seq int) string {
	return "chunk-" + fmt.Sprintf("%06d", seq)
}

func chunkSeqs(dir string) []int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var seqs []int
	for _, e := range entries {
		if seq, ok := ParseChunkName(e.Name()); ok {
			seqs = append(seqs, seq)
		}
	}
	sort.Ints(seqs)
	return seqs
}

func writeJSONAtomic(path string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, raw)
}

func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
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
	return os.Rename(tmp, path)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// DigestOf computes the snapshot digest for a payload, a helper for
// senders building a Meta.
func DigestOf(parts ...[]byte) []byte {
	h := sha256.New()
	for _, p := range parts {
		io.Copy(h, bytes.NewReader(p))
	}
	return h.Sum(nil)
}

// ParseChunkName exposes chunk sequence parsing for tests and tools.
func ParseChunkName(name string) (int, bool) {
	rest, ok := strings.CutPrefix(name, "chunk-")
	if !ok {
		return 0, false
	}
	var seq int
	if _, err := fmt.Sscanf(rest, "%d", &seq); err != nil {
		return 0, false
	}
	return seq, true
}
