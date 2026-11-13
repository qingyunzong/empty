package dataeng

import (
	"fmt"
	"sort"
)

// PlanCompaction selects active, unoccupied files from one partition and
// registers a compaction plan anchored to the current snapshot. The returned
// plan is a copy; mutate the manager only through its lifecycle methods.
//
// Files claimed by another open plan are skipped so that two plans never
// silently target the same input. When fewer than opts.MinFiles (default two)
// eligible files exist, ErrNothingToCompact is returned.
func (m *Manager) PlanCompaction(partition Partition, opts PlanOptions) (CompactionPlan, error) {
	minFiles := opts.MinFiles
	if minFiles <= 0 {
		minFiles = 2
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	planID := opts.PlanID
	if planID != "" {
		if _, exists := m.plans[planID]; exists {
			return CompactionPlan{}, ErrPlanIDExists
		}
	}

	var candidates []DataFile
	var totalSize int64
	for _, entry := range m.files {
		if !entry.active || entry.file.Partition != partition || entry.claimedBy != "" {
			continue
		}
		if opts.MaxTotalSizeInBytes > 0 && totalSize+entry.file.SizeInBytes > opts.MaxTotalSizeInBytes {
			continue
		}
		candidates = append(candidates, entry.file)
		totalSize += entry.file.SizeInBytes
	}
	sortFiles(candidates)

	if opts.MaxFiles > 0 && len(candidates) > opts.MaxFiles {
		candidates = candidates[:opts.MaxFiles]
	}
	if len(candidates) < minFiles {
		return CompactionPlan{}, ErrNothingToCompact
	}

	if planID == "" {
		m.planSeq++
		planID = fmt.Sprintf("plan-%d", m.planSeq)
	}

	now := m.now()
	plan := &CompactionPlan{
		ID:             planID,
		Partition:      partition,
		BaseSnapshotID: m.currentID,
		Status:         PlanPlanned,
		Replacement: ReplacementSet{
			Inputs: cloneFiles(candidates),
		},
		CreatedAt: now,
		UpdatedAt: now,
		claimed:   !opts.NoClaim,
	}

	if plan.claimed {
		for _, f := range candidates {
			m.files[f.Path].claimedBy = planID
		}
	}
	m.plans[planID] = plan
	return clonePlan(plan), nil
}

// GetPlan returns a copy of a plan by id.
func (m *Manager) GetPlan(planID string) (CompactionPlan, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	plan, ok := m.plans[planID]
	if !ok {
		return CompactionPlan{}, fmt.Errorf("%w: %s", ErrPlanNotFound, planID)
	}
	return clonePlan(plan), nil
}

// Plans returns copies of all registered plans ordered by plan id.
func (m *Manager) Plans() []CompactionPlan {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]CompactionPlan, 0, len(m.plans))
	for _, plan := range m.plans {
		out = append(out, clonePlan(plan))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Commit validates that every input file of the plan is still active on the
// current snapshot and then applies the replacement set atomically. If any
// input was removed by an earlier intersecting compaction (or any other
// manifest change), ErrConflict is returned and nothing is mutated, leaving
// the plan open for retry. On success a new snapshot is appended and the
// replaced inputs are queued for safe recycling.
func (m *Manager) Commit(planID string, outputs []DataFile) (CommitResult, error) {
	if len(outputs) == 0 {
		return CommitResult{}, ErrEmptyOutput
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	plan, ok := m.plans[planID]
	if !ok {
		return CommitResult{}, fmt.Errorf("%w: %s", ErrPlanNotFound, planID)
	}
	if plan.Status != PlanPlanned {
		return CommitResult{}, fmt.Errorf("%w: %s is %s", ErrPlanNotOpen, planID, plan.Status)
	}

	// Output validation happens before any state change so a bad job cannot
	// partially mutate the manifest.
	seen := make(map[string]struct{}, len(outputs))
	for _, out := range outputs {
		if out.Path == "" {
			return CommitResult{}, ErrInvalidPath
		}
		if _, dup := seen[out.Path]; dup {
			return CommitResult{}, fmt.Errorf("%w: %s", ErrDuplicatePath, out.Path)
		}
		seen[out.Path] = struct{}{}
		if out.Partition != plan.Partition {
			return CommitResult{}, fmt.Errorf("%w: %s", ErrPartitionMismatch, out.Path)
		}
		if _, exists := m.files[out.Path]; exists {
			return CommitResult{}, fmt.Errorf("%w: %s", ErrOutputExists, out.Path)
		}
	}

	// Optimistic concurrency control: the commit is only valid while every
	// planned input remains active. Intersecting compactions therefore resolve
	// to a single winner regardless of claim configuration.
	var stale []string
	for _, input := range plan.Replacement.Inputs {
		entry, ok := m.files[input.Path]
		if !ok || !entry.active {
			stale = append(stale, input.Path)
		}
	}
	if len(stale) > 0 {
		sort.Strings(stale)
		return CommitResult{}, fmt.Errorf("%w: plan %s base snapshot %d, stale files %v",
			ErrConflict, planID, plan.BaseSnapshotID, stale)
	}

	now := m.now()
	removed := cloneFiles(plan.Replacement.Inputs)
	added := cloneFiles(outputs)

	for _, input := range removed {
		entry := m.files[input.Path]
		entry.active = false
		entry.claimedBy = ""
		m.recycle = append(m.recycle, RecycleItem{
			Path:        input.Path,
			Partition:   input.Partition,
			Reason:      RecycleReplacedInput,
			PlanID:      planID,
			SnapshotID:  m.currentID + 1,
			Immediately: false,
			CreatedAt:   now,
		})
	}
	for _, out := range added {
		m.files[out.Path] = &fileEntry{file: out, active: true}
	}

	snap := m.nextSnapshot(added, removed)
	m.snapshots = append(m.snapshots, snap)

	plan.Status = PlanCommitted
	plan.UpdatedAt = now
	plan.CommitSnapshotID = snap.ID
	plan.Replacement.Outputs = cloneFiles(added)
	plan.claimed = false

	return CommitResult{
		PlanID:     planID,
		SnapshotID: snap.ID,
		Removed:    removed,
		Added:      added,
	}, nil
}

// Fail marks a plan as failed after its physical job errors. Its outputs never
// enter the manifest: they are recorded on the safe-to-recycle list with the
// failed-output reason instead. The input claims are released so the files
// become eligible for another plan.
func (m *Manager) Fail(planID string, produced []DataFile) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	plan, ok := m.plans[planID]
	if !ok {
		return fmt.Errorf("%w: %s", ErrPlanNotFound, planID)
	}
	if plan.Status != PlanPlanned {
		return fmt.Errorf("%w: %s is %s", ErrPlanNotOpen, planID, plan.Status)
	}

	now := m.now()
	for _, out := range produced {
		// Failed outputs are unknown to the manifest by definition. Guard
		// against an accidental duplicate so the recycle list stays unique.
		if _, exists := m.files[out.Path]; exists {
			continue
		}
		m.recycle = append(m.recycle, RecycleItem{
			Path:        out.Path,
			Partition:   out.Partition,
			Reason:      RecycleFailedOutput,
			PlanID:      planID,
			SnapshotID:  0,
			Immediately: true,
			CreatedAt:   now,
		})
	}

	m.releaseClaims(plan)
	plan.Status = PlanFailed
	plan.UpdatedAt = now
	plan.Replacement.Outputs = cloneFiles(produced)
	return nil
}

// Abort cancels a plan that never produced outputs, releasing its claims.
func (m *Manager) Abort(planID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	plan, ok := m.plans[planID]
	if !ok {
		return fmt.Errorf("%w: %s", ErrPlanNotFound, planID)
	}
	if plan.Status != PlanPlanned {
		return fmt.Errorf("%w: %s is %s", ErrPlanNotOpen, planID, plan.Status)
	}

	m.releaseClaims(plan)
	plan.Status = PlanAborted
	plan.UpdatedAt = m.now()
	return nil
}

// releaseClaims frees every input occupied by a plan while holding the lock.
func (m *Manager) releaseClaims(plan *CompactionPlan) {
	if !plan.claimed {
		return
	}
	for _, input := range plan.Replacement.Inputs {
		if entry, ok := m.files[input.Path]; ok && entry.claimedBy == plan.ID {
			entry.claimedBy = ""
		}
	}
	plan.claimed = false
}

func clonePlan(plan *CompactionPlan) CompactionPlan {
	cp := *plan
	cp.Replacement.Inputs = cloneFiles(plan.Replacement.Inputs)
	cp.Replacement.Outputs = cloneFiles(plan.Replacement.Outputs)
	return cp
}
