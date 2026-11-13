package dataeng

import (
	"sort"
	"sync"
	"time"
)

// fileEntry is the internal bookkeeping for one data file.
type fileEntry struct {
	file DataFile

	// active is true while the file is part of the current manifest.
	active bool

	// claimedBy holds the id of the plan currently occupying the file. Empty
	// when the file is unoccupied.
	claimedBy string
}

// Manager is an importable, goroutine-safe compaction state component. It owns
// the table manifest, the compaction plan registry, optimistic concurrency
// control and the safe-to-recycle list.
//
// A Manager value is not usable until constructed with NewManager.
type Manager struct {
	mu sync.RWMutex

	// files indexes every known file by its unique path.
	files map[string]*fileEntry

	// plans stores plan state by plan id.
	plans map[string]*CompactionPlan

	// snapshots is the append-only snapshot history in id order.
	snapshots []*Snapshot

	// currentID is the id of the latest snapshot (0 before the first write).
	currentID int64

	// recycle is the safe-to-recycle list in insertion order.
	recycle []RecycleItem

	// planSeq produces unique generated plan ids.
	planSeq uint64

	now func() time.Time
}

// NewManager creates an empty manager whose first manifest change becomes
// snapshot id 1.
func NewManager() *Manager {
	return &Manager{
		files: make(map[string]*fileEntry),
		plans: make(map[string]*CompactionPlan),
		now:   time.Now,
	}
}

// Append registers newly discovered files as an ordinary manifest append and
// returns the new snapshot id. Files are partition-scoped only in the sense
// that one append may touch several partitions at once. Re-adding a path that
// is already known (active or retired) is rejected to keep file identity
// stable.
func (m *Manager) Append(files ...DataFile) (int64, error) {
	if len(files) == 0 {
		return 0, ErrEmptyOutput
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	seen := make(map[string]struct{}, len(files))
	for _, f := range files {
		if f.Path == "" {
			return 0, ErrInvalidPath
		}
		if _, ok := seen[f.Path]; ok {
			return 0, ErrDuplicatePath
		}
		seen[f.Path] = struct{}{}
		if _, ok := m.files[f.Path]; ok {
			return 0, ErrOutputExists
		}
	}

	added := make([]DataFile, 0, len(files))
	for _, f := range files {
		m.files[f.Path] = &fileEntry{file: f, active: true}
		added = append(added, f)
	}

	snap := m.nextSnapshot(added, nil)
	m.snapshots = append(m.snapshots, snap)
	return snap.ID, nil
}

// CurrentSnapshotID returns the id of the latest snapshot, or zero when no
// manifest change has happened yet.
func (m *Manager) CurrentSnapshotID() int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.currentID
}

// Manifest returns a copy of the active manifest at the current snapshot.
func (m *Manager) Manifest() Manifest {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := Manifest{SnapshotID: m.currentID}
	for _, entry := range m.files {
		if entry.active {
			out.Files = append(out.Files, entry.file)
		}
	}
	sortFiles(out.Files)
	return out
}

// ActiveFiles returns the active files of one partition, ordered by path.
func (m *Manager) ActiveFiles(partition Partition) []DataFile {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var out []DataFile
	for _, entry := range m.files {
		if entry.active && entry.file.Partition == partition {
			out = append(out, entry.file)
		}
	}
	sortFiles(out)
	return out
}

// Snapshots returns a deep copy of the append-only snapshot history.
func (m *Manager) Snapshots() []Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]Snapshot, 0, len(m.snapshots))
	for _, snap := range m.snapshots {
		out = append(out, Snapshot{
			ID:           snap.ID,
			ParentID:     snap.ParentID,
			CreatedAt:    snap.CreatedAt,
			AddedFiles:   cloneFiles(snap.AddedFiles),
			RemovedFiles: cloneFiles(snap.RemovedFiles),
		})
	}
	return out
}

// IsClaimed reports whether a path is currently occupied by an open plan.
func (m *Manager) IsClaimed(path string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()

	entry, ok := m.files[path]
	return ok && entry.claimedBy != ""
}

// ClaimOwner returns the plan id currently occupying a path, or "" when the
// file is unoccupied or unknown.
func (m *Manager) ClaimOwner(path string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if entry, ok := m.files[path]; ok {
		return entry.claimedBy
	}
	return ""
}

// nextSnapshot builds a new snapshot while holding the write lock.
func (m *Manager) nextSnapshot(added, removed []DataFile) *Snapshot {
	m.currentID++
	return &Snapshot{
		ID:           m.currentID,
		ParentID:     m.currentID - 1,
		CreatedAt:    m.now(),
		AddedFiles:   cloneFiles(added),
		RemovedFiles: cloneFiles(removed),
	}
}

func cloneFiles(in []DataFile) []DataFile {
	if len(in) == 0 {
		return nil
	}
	out := make([]DataFile, len(in))
	copy(out, in)
	return out
}

func sortFiles(files []DataFile) {
	sort.Slice(files, func(i, j int) bool {
		if files[i].Partition != files[j].Partition {
			return files[i].Partition < files[j].Partition
		}
		return files[i].Path < files[j].Path
	})
}
