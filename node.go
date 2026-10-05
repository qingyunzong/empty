package recovery

import "sync"

// Entry is a replicated log entry.
type Entry struct {
	Index uint64
	Data  []byte
}

// Node combines a snapshot Installer with a log. While a snapshot is
// being installed, incoming log entries are buffered; once the snapshot
// is published, only buffered entries after the snapshot index are
// applied, since earlier ones are already covered by the snapshot.
type Node struct {
	mu          sync.Mutex
	installer   *Installer
	applied     []Entry
	buffered    []Entry
	snapIndex   uint64 // index of the currently published snapshot
	hasSnapshot bool
}

// NewNode opens a Node rooted at dir, recovering any interrupted
// installation via the Installer.
func NewNode(dir string) (*Node, error) {
	inst, err := Open(dir)
	if err != nil {
		return nil, err
	}
	n := &Node{installer: inst}
	if m, _, ok := inst.Snapshot(); ok {
		n.snapIndex = m.Index
		n.hasSnapshot = true
	}
	return n, nil
}

// Installer exposes the underlying snapshot installer.
func (n *Node) Installer() *Installer { return n.installer }

// Append records a log entry. During snapshot installation the entry is
// buffered; otherwise it is applied immediately. Entries at or below the
// published snapshot index are always dropped.
func (n *Node) Append(e Entry) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.hasSnapshot && e.Index <= n.snapIndex {
		return
	}
	if n.installer.Installing() {
		n.buffered = append(n.buffered, e)
		return
	}
	n.applied = append(n.applied, e)
}

// BeginSnapshot starts a chunked snapshot installation.
func (n *Node) BeginSnapshot(m Meta) error { return n.installer.Begin(m) }

// WriteSnapshotChunk stores one snapshot chunk.
func (n *Node) WriteSnapshotChunk(version uint64, seq int, data []byte) error {
	return n.installer.WriteChunk(version, seq, data)
}

// CompleteSnapshot verifies and publishes the snapshot, then replays the
// buffered log: entries after the snapshot index are applied, the rest
// are discarded as covered by the snapshot.
func (n *Node) CompleteSnapshot(version uint64) error {
	if err := n.installer.Complete(version); err != nil {
		return err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	m, _, _ := n.installer.Snapshot()
	n.snapIndex = m.Index
	n.hasSnapshot = true
	kept := n.buffered[:0]
	for _, e := range n.buffered {
		if e.Index > n.snapIndex {
			n.applied = append(n.applied, e)
		}
	}
	n.buffered = kept[:0]
	return nil
}

// AbortSnapshot discards any in-progress installation. Buffered entries
// are kept: without a new snapshot they are still needed, and they are
// applied immediately.
func (n *Node) AbortSnapshot() error {
	if err := n.installer.Abort(); err != nil {
		return err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.applied = append(n.applied, n.buffered...)
	n.buffered = nil
	return nil
}

// Applied returns the applied log entries in apply order.
func (n *Node) Applied() []Entry {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]Entry(nil), n.applied...)
}

// Buffered returns the entries currently held back by an in-progress
// snapshot installation.
func (n *Node) Buffered() []Entry {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]Entry(nil), n.buffered...)
}

// SnapshotIndex returns the index of the published snapshot and whether
// one exists.
func (n *Node) SnapshotIndex() (uint64, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.snapIndex, n.hasSnapshot
}
