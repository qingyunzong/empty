// Package noderecovery implements chunked snapshot installation for node
// recovery. A snapshot is received in out-of-order chunks, verified against
// a digest, and published atomically. Log entries arriving during an
// installation are buffered and only entries after the snapshot's last
// included index are applied. A crash or restart at any point leaves the
// node with either the fully old or the fully new state.
package noderecovery

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

var (
	// ErrVersionMismatch is returned when a chunk belongs to a different
	// snapshot than the one currently being received.
	ErrVersionMismatch = errors.New("snapshot: chunk belongs to a different snapshot version")
	// ErrDuplicateConflict is returned when a chunk offset was already
	// received with different content.
	ErrDuplicateConflict = errors.New("snapshot: duplicate chunk with different content")
	// ErrDigestMismatch is returned when the assembled snapshot does not
	// match the announced digest.
	ErrDigestMismatch = errors.New("snapshot: assembled data does not match digest")
	// ErrChunkConflict is returned when stream metadata (digest, last
	// index) differs between chunks of the same snapshot.
	ErrChunkConflict = errors.New("snapshot: conflicting chunk metadata")
)

// Entry is a log entry applied to the node's key-value state.
type Entry struct {
	Index uint64
	Key   string
	Value string
}

// Chunk is one piece of a snapshot stream. Digest and LastIndex must be
// identical on every chunk of a snapshot. The chunk with Last=true marks
// the end of the stream; the total size is its Offset + len(Data).
type Chunk struct {
	SnapshotID string
	LastIndex  uint64   // last log index included in the snapshot
	Offset     int64    // byte offset of Data within the snapshot payload
	Data       []byte   //
	Last       bool     // true for the final chunk
	Digest     [32]byte // sha256 of the complete snapshot payload
}

type committedState struct {
	LastIndex uint64            `json:"last_index"`
	Data      map[string]string `json:"data"`
}

type chunkMeta struct {
	SnapshotID string     `json:"snapshot_id"`
	LastIndex  uint64     `json:"last_index"`
	Digest     [32]byte   `json:"digest"`
	Received   [][2]int64 `json:"received"` // [offset, length] ranges
	Total      int64      `json:"total"`    // valid once GotLast
	GotLast    bool       `json:"got_last"`
}

type incoming struct {
	meta chunkMeta
	file *os.File
}

// Node is a recovering node with a committed state and an optional
// in-progress snapshot installation.
type Node struct {
	dir string
	mu  sync.Mutex

	state   map[string]string
	applied uint64

	install *incoming
	pending []Entry // log entries buffered while an install is in progress
}

// Open opens (or creates) a node rooted at dir. A previously interrupted
// installation is resumed from disk; the committed state is always either
// the fully old or the fully new snapshot.
func Open(dir string) (*Node, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	n := &Node{dir: dir, state: map[string]string{}}

	if buf, err := os.ReadFile(filepath.Join(dir, "state.json")); err == nil {
		var cs committedState
		if err := json.Unmarshal(buf, &cs); err != nil {
			return nil, fmt.Errorf("snapshot: corrupt committed state: %w", err)
		}
		n.state = cs.Data
		n.applied = cs.LastIndex
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	if buf, err := os.ReadFile(filepath.Join(dir, "incoming", "meta.json")); err == nil {
		var meta chunkMeta
		if err := json.Unmarshal(buf, &meta); err != nil {
			// Unreadable partial state: discard, committed state is intact.
			os.RemoveAll(filepath.Join(dir, "incoming"))
			return n, nil
		}
		f, err := os.OpenFile(filepath.Join(dir, "incoming", "data.part"), os.O_RDWR, 0o644)
		if err != nil {
			os.RemoveAll(filepath.Join(dir, "incoming"))
			return n, nil
		}
		n.install = &incoming{meta: meta, file: f}
	}
	return n, nil
}

// Close releases resources held by the node.
func (n *Node) Close() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.install != nil {
		return n.install.file.Close()
	}
	return nil
}

// State returns a copy of the committed key-value state.
func (n *Node) State() map[string]string {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := make(map[string]string, len(n.state))
	for k, v := range n.state {
		out[k] = v
	}
	return out
}

// AppliedIndex returns the index of the last applied log entry.
func (n *Node) AppliedIndex() uint64 {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.applied
}

// Append applies a log entry. While a snapshot installation is in
// progress the entry is buffered; once the snapshot is published only
// buffered entries after the snapshot's last included index are applied.
func (n *Node) Append(e Entry) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.install != nil {
		n.pending = append(n.pending, e)
		return nil
	}
	return n.applyLocked(e)
}

func (n *Node) applyLocked(e Entry) error {
	if e.Index <= n.applied {
		return nil // stale or already applied
	}
	n.state[e.Key] = e.Value
	n.applied = e.Index
	return n.persistLocked()
}

// ReceiveChunk consumes one snapshot chunk. Chunks may arrive out of
// order. When the final chunk completes a contiguous, digest-verified
// payload, the snapshot is published atomically.
func (n *Node) ReceiveChunk(c Chunk) error {
	n.mu.Lock()
	defer n.mu.Unlock()

	if n.install != nil && n.install.meta.SnapshotID != c.SnapshotID {
		return ErrVersionMismatch
	}
	if n.install == nil {
		if err := n.beginInstallLocked(c); err != nil {
			return err
		}
	}
	meta := &n.install.meta
	if meta.Digest != c.Digest || meta.LastIndex != c.LastIndex {
		n.abortInstallLocked()
		return ErrChunkConflict
	}

	end := c.Offset + int64(len(c.Data))
	for _, r := range meta.Received {
		rEnd := r[0] + r[1]
		if r[0] < end && c.Offset < rEnd {
			if r[0] == c.Offset && r[1] == int64(len(c.Data)) {
				// Exact duplicate: identical content is idempotent,
				// different content fails the installation.
				existing := make([]byte, r[1])
				if _, err := n.install.file.ReadAt(existing, r[0]); err != nil {
					return err
				}
				if bytes.Equal(existing, c.Data) {
					return nil
				}
				n.abortInstallLocked()
				return ErrDuplicateConflict
			}
			n.abortInstallLocked()
			return ErrChunkConflict
		}
	}

	if _, err := n.install.file.WriteAt(c.Data, c.Offset); err != nil {
		return err
	}
	if err := n.install.file.Sync(); err != nil {
		return err
	}
	meta.Received = append(meta.Received, [2]int64{c.Offset, int64(len(c.Data))})
	if c.Last {
		meta.GotLast = true
		meta.Total = end
	}
	if err := n.persistMetaLocked(); err != nil {
		return err
	}

	if meta.GotLast && contiguous(meta.Received, meta.Total) {
		return n.publishLocked()
	}
	return nil
}

func (n *Node) beginInstallLocked(c Chunk) error {
	dir := filepath.Join(n.dir, "incoming")
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, "data.part"), os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	n.install = &incoming{
		meta: chunkMeta{SnapshotID: c.SnapshotID, LastIndex: c.LastIndex, Digest: c.Digest},
		file: f,
	}
	return nil
}

// abortInstallLocked discards the partial snapshot. Buffered entries are
// drained against the unchanged committed state.
func (n *Node) abortInstallLocked() {
	n.install.file.Close()
	os.RemoveAll(filepath.Join(n.dir, "incoming"))
	n.install = nil
	n.drainPendingLocked()
}

// publishLocked verifies the assembled payload and atomically replaces
// the committed state, then applies buffered entries beyond the
// snapshot's last included index.
func (n *Node) publishLocked() error {
	meta := n.install.meta
	payload := make([]byte, meta.Total)
	if _, err := n.install.file.ReadAt(payload, 0); err != nil {
		return err
	}
	if sha256.Sum256(payload) != meta.Digest {
		n.abortInstallLocked()
		return ErrDigestMismatch
	}
	var snap struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(payload, &snap); err != nil {
		n.abortInstallLocked()
		return fmt.Errorf("snapshot: undecodable payload: %w", err)
	}

	n.state = snap.Data
	n.applied = meta.LastIndex
	if err := n.persistLocked(); err != nil {
		return err
	}

	n.install.file.Close()
	if err := os.RemoveAll(filepath.Join(n.dir, "incoming")); err != nil {
		return err
	}
	n.install = nil
	n.drainPendingLocked()
	return syncDir(n.dir)
}

// drainPendingLocked applies buffered entries whose index is beyond the
// last applied index, in index order; the rest are discarded.
func (n *Node) drainPendingLocked() {
	sort.Slice(n.pending, func(i, j int) bool { return n.pending[i].Index < n.pending[j].Index })
	pending := n.pending
	n.pending = nil
	for _, e := range pending {
		n.applyLocked(e)
	}
}

func (n *Node) persistLocked() error {
	buf, err := json.Marshal(committedState{LastIndex: n.applied, Data: n.state})
	if err != nil {
		return err
	}
	final := filepath.Join(n.dir, "state.json")
	tmp := final + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(buf); err != nil {
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
	if err := os.Rename(tmp, final); err != nil {
		return err
	}
	return syncDir(n.dir)
}

func (n *Node) persistMetaLocked() error {
	buf, err := json.Marshal(n.install.meta)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(n.dir, "incoming", "meta.json"), buf, 0o644)
}

func contiguous(ranges [][2]int64, total int64) bool {
	sorted := make([][2]int64, len(ranges))
	copy(sorted, ranges)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i][0] < sorted[j][0] })
	var pos int64
	for _, r := range sorted {
		if r[0] != pos {
			return false
		}
		pos += r[1]
	}
	return pos == total
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
