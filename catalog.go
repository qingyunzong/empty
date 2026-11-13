package dataeng

import (
	"fmt"
	"sort"
)

// Catalog is an immutable-in-practice snapshot graph. Snapshots are keyed by
// ID and linked by ParentID; branch names point at head snapshots.
//
// Build a Catalog with NewCatalog or NewCatalogWithBranches. Once built, only
// branch heads can be added or moved with AddBranch.
type Catalog struct {
	snapshots map[int64]Snapshot
	branches  map[string]int64
}

// NewCatalog validates and copies a snapshot graph.
func NewCatalog(snapshots []Snapshot) (*Catalog, error) {
	return NewCatalogWithBranches(snapshots, nil)
}

// NewCatalogWithBranches validates a snapshot graph and resolves branch heads.
func NewCatalogWithBranches(snapshots []Snapshot, branches map[string]int64) (*Catalog, error) {
	c := &Catalog{
		snapshots: make(map[int64]Snapshot, len(snapshots)),
		branches:  make(map[string]int64, len(branches)),
	}
	for _, snapshot := range snapshots {
		if snapshot.ID <= 0 {
			return nil, fmt.Errorf("dataeng: snapshot ID must be positive, got %d", snapshot.ID)
		}
		if _, exists := c.snapshots[snapshot.ID]; exists {
			return nil, fmt.Errorf("dataeng: duplicate snapshot ID %d", snapshot.ID)
		}
		if snapshot.ParentID < 0 {
			return nil, fmt.Errorf("dataeng: snapshot %d has negative parent ID %d", snapshot.ID, snapshot.ParentID)
		}
		if snapshot.ParentID == snapshot.ID {
			return nil, fmt.Errorf("dataeng: snapshot %d is its own parent", snapshot.ID)
		}
		if snapshot.SequenceNumber < 0 {
			return nil, fmt.Errorf("dataeng: snapshot %d has negative sequence number %d", snapshot.ID, snapshot.SequenceNumber)
		}
		c.snapshots[snapshot.ID] = cloneSnapshot(snapshot)
	}

	for _, snapshot := range c.snapshots {
		if snapshot.ParentID != 0 {
			parent, ok := c.snapshots[snapshot.ParentID]
			if !ok {
				return nil, fmt.Errorf("dataeng: snapshot %d refers to missing parent %d", snapshot.ID, snapshot.ParentID)
			}
			if snapshot.SequenceNumber < parent.SequenceNumber {
				return nil, fmt.Errorf("dataeng: snapshot %d sequence %d is older than parent %d sequence %d",
					snapshot.ID, snapshot.SequenceNumber, parent.ID, parent.SequenceNumber)
			}
		}
	}
	if err := c.validateAcyclic(); err != nil {
		return nil, err
	}

	names := make([]string, 0, len(branches))
	for name := range branches {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		id := branches[name]
		if err := c.AddBranch(name, id); err != nil {
			return nil, err
		}
	}
	return c, nil
}

func cloneSnapshot(s Snapshot) Snapshot {
	out := s
	if s.DeleteFiles != nil {
		out.DeleteFiles = make([]DeleteFile, len(s.DeleteFiles))
		for i, file := range s.DeleteFiles {
			out.DeleteFiles[i] = cloneDeleteFile(file)
		}
	}
	if s.RemovedDeleteFiles != nil {
		out.RemovedDeleteFiles = append([]string(nil), s.RemovedDeleteFiles...)
	}
	return out
}

func cloneDeleteFile(f DeleteFile) DeleteFile {
	out := f
	if f.Records != nil {
		out.Records = append([]PositionDelete(nil), f.Records...)
	}
	return out
}

func (c *Catalog) validateAcyclic() error {
	const (
		visiting = iota + 1
		done
	)
	state := make(map[int64]int, len(c.snapshots))
	var visit func(int64) error
	visit = func(id int64) error {
		switch state[id] {
		case done:
			return nil
		case visiting:
			return fmt.Errorf("dataeng: snapshot parent cycle at %d", id)
		}
		state[id] = visiting
		if snapshot := c.snapshots[id]; snapshot.ParentID != 0 {
			if err := visit(snapshot.ParentID); err != nil {
				return err
			}
		}
		state[id] = done
		return nil
	}
	for id := range c.snapshots {
		if err := visit(id); err != nil {
			return err
		}
	}
	return nil
}

// AddBranch adds or moves a named branch head. A branch may be moved forward or
// backward; visibility is always recomputed from the new head's ancestry.
func (c *Catalog) AddBranch(name string, snapshotID int64) error {
	if name == "" {
		return fmt.Errorf("dataeng: branch name must not be empty")
	}
	if _, ok := c.snapshots[snapshotID]; !ok {
		return fmt.Errorf("dataeng: branch %q refers to unknown snapshot %d", name, snapshotID)
	}
	c.branches[name] = snapshotID
	return nil
}

// ResolveBranch returns the head snapshot ID for a branch.
func (c *Catalog) ResolveBranch(name string) (int64, error) {
	id, ok := c.branches[name]
	if !ok {
		return 0, fmt.Errorf("dataeng: unknown branch %q", name)
	}
	return id, nil
}

// BranchNames returns branch names in sorted order.
func (c *Catalog) BranchNames() []string {
	names := make([]string, 0, len(c.branches))
	for name := range c.branches {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Snapshot returns an immutable copy of a snapshot.
func (c *Catalog) Snapshot(id int64) (Snapshot, bool) {
	snapshot, ok := c.snapshots[id]
	if !ok {
		return Snapshot{}, false
	}
	return cloneSnapshot(snapshot), true
}

// SnapshotCount returns the number of snapshots in the catalog.
func (c *Catalog) SnapshotCount() int {
	return len(c.snapshots)
}

// Lineage returns the ancestor chain for snapshotID ordered from the root to
// the target. The target is included.
func (c *Catalog) Lineage(snapshotID int64) ([]Snapshot, error) {
	ids, err := c.lineageIDs(snapshotID)
	if err != nil {
		return nil, err
	}
	lineage := make([]Snapshot, 0, len(ids))
	for _, id := range ids {
		lineage = append(lineage, cloneSnapshot(c.snapshots[id]))
	}
	return lineage, nil
}

func (c *Catalog) lineageIDs(snapshotID int64) ([]int64, error) {
	if snapshotID == 0 {
		return nil, fmt.Errorf("dataeng: unknown snapshot 0")
	}
	var reversed []int64
	seen := make(map[int64]bool)
	for id := snapshotID; id != 0; {
		if seen[id] {
			return nil, fmt.Errorf("dataeng: snapshot parent cycle at %d", id)
		}
		seen[id] = true
		snapshot, ok := c.snapshots[id]
		if !ok {
			return nil, fmt.Errorf("dataeng: unknown snapshot %d", id)
		}
		reversed = append(reversed, id)
		id = snapshot.ParentID
	}
	ids := make([]int64, len(reversed))
	for i := range reversed {
		ids[len(reversed)-1-i] = reversed[i]
	}
	return ids, nil
}

// VisibleDeleteFiles resolves the delete files visible at snapshotID.
//
// Visibility is lineage-scoped: only the target's ancestors contribute. Delete
// files added on sibling branches are not inherited. Within the lineage,
// RemovedDeleteFiles tombstones hide earlier additions, and a later addition of
// the same delete file makes it visible again.
//
// Returned delete files are deterministically ordered by canonical path. A
// DeleteFile with SequenceNumber zero inherits the sequence number of the
// snapshot that introduced it; SnapshotID is filled in when zero.
func (c *Catalog) VisibleDeleteFiles(snapshotID int64) ([]DeleteFile, error) {
	ids, err := c.lineageIDs(snapshotID)
	if err != nil {
		return nil, err
	}

	visible := make(map[string]DeleteFile)
	for _, id := range ids {
		snapshot := c.snapshots[id]
		for _, raw := range snapshot.RemovedDeleteFiles {
			if raw == "" {
				return nil, fmt.Errorf("dataeng: snapshot %d removes an empty delete path", snapshot.ID)
			}
			delete(visible, CanonicalPath(raw))
		}
		for i, file := range snapshot.DeleteFiles {
			if file.SequenceNumber < 0 {
				return nil, fmt.Errorf("dataeng: delete file %q in snapshot %d has negative sequence %d",
					file.Path, snapshot.ID, file.SequenceNumber)
			}
			key := CanonicalPath(file.Path)
			if file.Path == "" {
				// An empty path is allowed for a synthetic/global delete batch,
				// but it must not collide with a real delete file or with
				// another synthetic delete file.
				key = fmt.Sprintf("\x00synthetic:%d:%d", snapshot.ID, i)
			}
			prior, visibleBefore := visible[key]
			if file.SequenceNumber == 0 {
				// A snapshot manifest may repeat an inherited delete file.
				// Preserve the sequence number of the snapshot that actually
				// introduced it instead of making the delete appear newer.
				if visibleBefore {
					file.SequenceNumber = prior.SequenceNumber
				} else {
					file.SequenceNumber = snapshot.SequenceNumber
				}
			}
			if file.SnapshotID == 0 {
				if visibleBefore {
					file.SnapshotID = prior.SnapshotID
				} else {
					file.SnapshotID = snapshot.ID
				}
			}
			visible[key] = cloneDeleteFile(file)
		}
	}

	files := make([]DeleteFile, 0, len(visible))
	for _, file := range visible {
		files = append(files, file)
	}
	sort.SliceStable(files, func(i, j int) bool {
		ki, kj := CanonicalPath(files[i].Path), CanonicalPath(files[j].Path)
		if ki != kj {
			return ki < kj
		}
		if files[i].Path != files[j].Path {
			return files[i].Path < files[j].Path
		}
		if files[i].SequenceNumber != files[j].SequenceNumber {
			return files[i].SequenceNumber < files[j].SequenceNumber
		}
		return files[i].SnapshotID < files[j].SnapshotID
	})
	return files, nil
}

// PlanSnapshot plans deletes visible at snapshotID.
func (c *Catalog) PlanSnapshot(snapshotID int64, dataFiles []DataFile, options ...PlanOption) (Plan, error) {
	deleteFiles, err := c.VisibleDeleteFiles(snapshotID)
	if err != nil {
		return Plan{}, err
	}
	plan, err := planVisible(snapshotID, dataFiles, deleteFiles, newPlanConfig(options...))
	if err != nil {
		return Plan{}, err
	}
	return plan, nil
}

// PlanBranch plans deletes visible at a branch head.
func (c *Catalog) PlanBranch(name string, dataFiles []DataFile, options ...PlanOption) (Plan, error) {
	id, err := c.ResolveBranch(name)
	if err != nil {
		return Plan{}, err
	}
	return c.PlanSnapshot(id, dataFiles, options...)
}
