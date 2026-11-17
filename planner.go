package formal

import (
	"fmt"
	"sort"
)

// Config controls optional planner constraints. Its zero value is the normal
// background-compaction policy: compact only levels above SizeLimit, select
// enough source bytes to bring that level back to its limit, and impose no
// additional byte or file budget.
type Config struct {
	// AllowPartial permits a compaction that does not, by itself, reduce the
	// source level to SizeLimit. It is ignored when MinSourceBytes is set.
	AllowPartial bool

	// MinSourceBytes overrides the automatic source-level relief target. When
	// non-zero, at least this many source bytes must be selected.
	MinSourceBytes uint64

	// PlanWithoutSizePressure also considers levels that are at or below their
	// SizeLimit. In that mode the automatic relief target is zero.
	PlanWithoutSizePressure bool

	// MaxSourceBytes, MaxInputBytes and MaxWriteBytes cap selected source
	// bytes, all input bytes, and estimated output bytes respectively. Zero
	// means unlimited.
	MaxSourceBytes uint64
	MaxInputBytes  uint64
	MaxWriteBytes  uint64

	// MaxFiles caps the number of selected files. Zero means unlimited.
	MaxFiles int

	// MaxConcurrentTasks refuses a new plan when this many tasks are already
	// running. Zero means unlimited.
	MaxConcurrentTasks int

	// ExclusiveLevels forbids any other compaction whose source or target
	// level intersects this plan's levels, even if the key ranges are disjoint.
	ExclusiveLevels bool

	// EnforceTargetSize requires the projected target-level size to remain
	// within the target's SizeLimit. Running tasks writing to the same target
	// contribute their ReservedBytes. A zero SizeLimit remains unlimited.
	EnforceTargetSize bool

	// RetainTombstones disables elision of even safely droppable tombstones.
	RetainTombstones bool
}

// Plan is a feasible L-to-L+1 compaction selected by the planner. InputFiles
// lists source files in key order followed by target files in key order.
type Plan struct {
	SourceLevel int
	TargetLevel int
	SourceFiles []string
	TargetFiles []string
	InputFiles  []string

	SourceBytes uint64
	TargetBytes uint64
	InputBytes  uint64
	// WriteBytes and OutputBytes both estimate the bytes written to the target
	// level. WriteBytes is the value minimized by the planner.
	WriteBytes  uint64
	OutputBytes uint64

	DroppedTombstoneBytes  uint64
	RetainedTombstoneBytes uint64
	DroppedTombstones      bool

	Smallest Key
	Largest  Key
}

// Planner selects compaction inputs from immutable state snapshots.
type Planner struct {
	cfg Config
}

// NewPlanner creates a planner. At most one Config is used; this makes both
// NewPlanner() and NewPlanner(cfg) valid.
func NewPlanner(configs ...Config) *Planner {
	var cfg Config
	if len(configs) > 0 {
		cfg = configs[0]
	}
	return &Planner{cfg: cfg}
}

// Config returns the planner configuration.
func (p *Planner) Config() Config {
	return p.cfg
}

// BuildPlan runs a planner with the zero-value configuration.
func BuildPlan(state State) (Plan, error) {
	return NewPlanner().Plan(state)
}

// Plan selects the feasible compaction with the smallest estimated write
// volume.
//
// Candidate compactions are contiguous key ranges in one source level,
// together with every overlapping file in the next level. Candidate ordering
// is fixed as follows:
//
//  1. smallest WriteBytes;
//  2. smallest InputBytes;
//  3. fewest input files;
//  4. smallest source level;
//  5. lexicographically smallest source file IDs;
//  6. lexicographically smallest target file IDs.
//
// The rules are total for a validated state, so the result does not depend on
// map iteration or input task ordering.
func (p *Planner) Plan(state State) (Plan, error) {
	if err := state.Validate(); err != nil {
		return Plan{}, err
	}
	if err := p.cfg.validate(); err != nil {
		return Plan{}, err
	}
	if p.cfg.MaxConcurrentTasks > 0 && len(state.Running) >= p.cfg.MaxConcurrentTasks {
		return Plan{}, fmt.Errorf("%w: concurrency limit %d reached", ErrNoPlan, p.cfg.MaxConcurrentTasks)
	}
	if len(state.Levels) < 2 {
		return Plan{}, fmt.Errorf("%w: need at least two levels", ErrNoPlan)
	}

	index := buildIndex(state)
	best := candidate{}
	found := false
	relevantLevel := false

	for sourceLevel, level := range state.Levels {
		targetLevel := sourceLevel + 1
		if targetLevel >= len(state.Levels) {
			continue
		}
		overLimit := level.SizeLimit > 0 && level.Size() > level.SizeLimit
		if !overLimit && !p.cfg.PlanWithoutSizePressure {
			continue
		}
		relevantLevel = true

		minSource := p.minimumSourceBytes(level, overLimit)
		target := &state.Levels[targetLevel]
		targetSize := target.Size()

		// File sizes are non-negative and the overlap closure only grows as the
		// source window grows. Therefore, for a fixed start, the first prefix
		// that satisfies minSource is the cheapest feasible prefix. A longer
		// prefix cannot repair a budget or conflict violation and cannot reduce
		// write volume.
		end := 0
		var sourceBytes uint64
		for start := 0; start < len(level.Files); start++ {
			if end < start {
				end = start
				sourceBytes = 0
			}
			for end < len(level.Files) && (end == start || sourceBytes < minSource) {
				sourceBytes = satAdd(sourceBytes, level.Files[end].Size)
				end++
			}
			if sourceBytes < minSource {
				break
			}

			if p.cfg.MaxSourceBytes == 0 || sourceBytes <= p.cfg.MaxSourceBytes {
				if cand, ok := p.evaluate(state, index, sourceLevel, targetLevel, start, end,
					sourceBytes, targetSize); ok {
					if !found || better(cand.plan, best.plan) {
						best = cand
						found = true
					}
				}
			}

			sourceBytes = satSub(sourceBytes, level.Files[start].Size)
		}
	}

	if !relevantLevel {
		return Plan{}, fmt.Errorf("%w: no level exceeds its size limit", ErrNoPlan)
	}
	if !found {
		return Plan{}, fmt.Errorf("%w: all candidates violate a budget, tombstone, or concurrency constraint", ErrNoPlan)
	}
	return best.plan, nil
}

type candidate struct {
	plan Plan
}

func (p *Planner) minimumSourceBytes(level Level, overLimit bool) uint64 {
	if p.cfg.MinSourceBytes > 0 {
		return p.cfg.MinSourceBytes
	}
	if !overLimit || p.cfg.AllowPartial {
		return 0
	}
	return level.Size() - level.SizeLimit
}

func (p *Planner) evaluate(
	state State,
	index stateIndex,
	sourceLevel, targetLevel, start, end int,
	sourceBytes, targetSize uint64,
) (candidate, bool) {
	source := state.Levels[sourceLevel]
	target := state.Levels[targetLevel]
	lo := source.Files[start].Smallest
	hi := source.Files[end-1].Largest

	targetStart, targetEnd := overlappingFiles(target.Files, lo, hi)
	targetCount := targetEnd - targetStart

	var targetBytes uint64
	for _, file := range target.Files[targetStart:targetEnd] {
		targetBytes = satAdd(targetBytes, file.Size)
	}
	inputBytes := satAdd(sourceBytes, targetBytes)
	if p.cfg.MaxInputBytes > 0 && inputBytes > p.cfg.MaxInputBytes {
		return candidate{}, false
	}

	fileCount := (end - start) + targetCount
	if p.cfg.MaxFiles > 0 && fileCount > p.cfg.MaxFiles {
		return candidate{}, false
	}

	inputRangeLo, inputRangeHi := lo, hi
	if targetCount > 0 {
		if target.Files[targetStart].Smallest < inputRangeLo {
			inputRangeLo = target.Files[targetStart].Smallest
		}
		if target.Files[targetEnd-1].Largest > inputRangeHi {
			inputRangeHi = target.Files[targetEnd-1].Largest
		}
	}

	dropped, retained := p.tombstoneBytes(state, targetLevel,
		source.Files[start:end], target.Files[targetStart:targetEnd])
	writeBytes := satSub(inputBytes, dropped)
	if p.cfg.MaxWriteBytes > 0 && writeBytes > p.cfg.MaxWriteBytes {
		return candidate{}, false
	}

	if p.cfg.EnforceTargetSize && target.SizeLimit > 0 {
		projected := targetSize - targetBytes
		projected = satAdd(projected, writeBytes)
		var reserved uint64
		for _, task := range state.Running {
			if task.TargetLevel == targetLevel {
				reserved = satAdd(reserved, task.ReservedBytes)
			}
		}
		projected = satAdd(projected, reserved)
		if projected > target.SizeLimit {
			return candidate{}, false
		}
	}

	plan := Plan{
		SourceLevel:            sourceLevel,
		TargetLevel:            targetLevel,
		SourceFiles:            fileIDs(source.Files[start:end]),
		TargetFiles:            fileIDs(target.Files[targetStart:targetEnd]),
		SourceBytes:            sourceBytes,
		TargetBytes:            targetBytes,
		InputBytes:             inputBytes,
		WriteBytes:             writeBytes,
		OutputBytes:            writeBytes,
		DroppedTombstoneBytes:  dropped,
		RetainedTombstoneBytes: retained,
		DroppedTombstones:      dropped > 0,
		Smallest:               inputRangeLo,
		Largest:                inputRangeHi,
	}
	plan.InputFiles = append(append([]string(nil), plan.SourceFiles...), plan.TargetFiles...)

	if p.conflicts(state, index, plan) {
		return candidate{}, false
	}
	return candidate{plan: plan}, true
}

func (p *Planner) tombstoneBytes(state State, targetLevel int, groups ...[]File) (dropped, retained uint64) {
	canDrop := targetLevel == state.BottomLevel() && !p.cfg.RetainTombstones
	for _, files := range groups {
		for _, file := range files {
			if file.TombstoneBytes == 0 {
				continue
			}
			if canDrop && file.TombstoneSeq <= state.TombstoneWatermark {
				dropped = satAdd(dropped, file.TombstoneBytes)
			} else {
				retained = satAdd(retained, file.TombstoneBytes)
			}
		}
	}
	return dropped, retained
}

func (p *Planner) conflicts(state State, index stateIndex, plan Plan) bool {
	selected := make(map[string]struct{}, len(plan.InputFiles))
	for _, id := range plan.InputFiles {
		selected[id] = struct{}{}
	}

	for _, task := range state.Running {
		for _, id := range task.InputIDs {
			if _, ok := selected[id]; ok {
				return true
			}
		}

		sharesLevel := task.SourceLevel == plan.SourceLevel ||
			task.SourceLevel == plan.TargetLevel ||
			task.TargetLevel == plan.SourceLevel ||
			task.TargetLevel == plan.TargetLevel
		if !sharesLevel {
			continue
		}
		if p.cfg.ExclusiveLevels {
			return true
		}

		taskLo, taskHi, known := index.runningRange(task)
		if !known {
			return true
		}
		if rangesOverlap(plan.Smallest, plan.Largest, taskLo, taskHi) {
			return true
		}
	}
	return false
}

type stateIndex struct {
	filesByID map[string]File
}

func buildIndex(state State) stateIndex {
	index := stateIndex{filesByID: make(map[string]File)}
	for _, level := range state.Levels {
		for _, file := range level.Files {
			index.filesByID[file.ID] = file
		}
	}
	return index
}

func (i stateIndex) runningRange(task RunningTask) (lo, hi Key, known bool) {
	if task.RangeSet {
		lo, hi, known = task.Smallest, task.Largest, true
	}
	missing := false
	for _, id := range task.InputIDs {
		file, ok := i.filesByID[id]
		if !ok {
			missing = true
			continue
		}
		if !known {
			lo, hi, known = file.Smallest, file.Largest, true
			continue
		}
		if file.Smallest < lo {
			lo = file.Smallest
		}
		if file.Largest > hi {
			hi = file.Largest
		}
	}
	if missing && !task.RangeSet {
		return "", "", false
	}
	return lo, hi, known
}

func overlappingFiles(files []File, lo, hi Key) (int, int) {
	start := sort.Search(len(files), func(i int) bool {
		return files[i].Largest >= lo
	})
	end := start
	for end < len(files) && files[end].Smallest <= hi {
		end++
	}
	return start, end
}

func fileIDs(files []File) []string {
	ids := make([]string, len(files))
	for i, file := range files {
		ids[i] = file.ID
	}
	return ids
}

func better(a, b Plan) bool {
	if a.WriteBytes != b.WriteBytes {
		return a.WriteBytes < b.WriteBytes
	}
	if a.InputBytes != b.InputBytes {
		return a.InputBytes < b.InputBytes
	}
	if len(a.InputFiles) != len(b.InputFiles) {
		return len(a.InputFiles) < len(b.InputFiles)
	}
	if a.SourceLevel != b.SourceLevel {
		return a.SourceLevel < b.SourceLevel
	}
	if c := compareIDs(a.SourceFiles, b.SourceFiles); c != 0 {
		return c < 0
	}
	if c := compareIDs(a.TargetFiles, b.TargetFiles); c != 0 {
		return c < 0
	}
	return false
}

func compareIDs(a, b []string) int {
	limit := len(a)
	if len(b) < limit {
		limit = len(b)
	}
	for i := 0; i < limit; i++ {
		if a[i] < b[i] {
			return -1
		}
		if a[i] > b[i] {
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	default:
		return 0
	}
}

func satSub(a, b uint64) uint64 {
	if b > a {
		return 0
	}
	return a - b
}

func (c Config) validate() error {
	if c.MaxFiles < 0 {
		return fmt.Errorf("%w: MaxFiles is negative", ErrInvalidState)
	}
	if c.MaxConcurrentTasks < 0 {
		return fmt.Errorf("%w: MaxConcurrentTasks is negative", ErrInvalidState)
	}
	return nil
}
