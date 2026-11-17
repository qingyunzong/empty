package formal

import (
	"errors"
	"fmt"
	"math"
)

// Key is a user key. Keys are ordered lexicographically, as in most LSM
// storage engines.
type Key string

// File is one immutable table in an LSM level.
//
// TombstoneBytes is the portion of Size occupied by deletion markers.
// TombstoneSeq is the newest sequence number among those markers. It is used
// together with State.TombstoneWatermark to decide whether a tombstone may be
// elided at the bottom level. A zero TombstoneSeq is treated as an old
// tombstone (and is therefore droppable when the watermark is zero).
type File struct {
	ID             string
	Smallest       Key
	Largest        Key
	Size           uint64
	TombstoneBytes uint64
	TombstoneSeq   uint64
}

// HasTombstones reports whether the file contains deletion markers.
func (f File) HasTombstones() bool {
	return f.TombstoneBytes > 0
}

// Overlaps reports whether the inclusive key range of f intersects [lo, hi].
func (f File) Overlaps(lo, hi Key) bool {
	return !(f.Largest < lo || f.Smallest > hi)
}

// Level is one level of a log-structured merge tree. Files must be sorted by
// Smallest and must not overlap each other.
//
// SizeLimit is the target size used to decide whether a level needs
// compaction. Zero means unlimited. Number must equal the level's index in
// State.Levels.
type Level struct {
	Number    int
	SizeLimit uint64
	Files     []File
}

// Size returns the sum of the file sizes in the level.
func (l Level) Size() uint64 {
	var total uint64
	for _, f := range l.Files {
		total = satAdd(total, f.Size)
	}
	return total
}

// RunningTask describes a compaction that is already executing. The planner
// treats its input files and key range as reserved.
//
// RangeSet makes Smallest/Largest authoritative. If RangeSet is false, the
// range is derived from InputIDs. If neither is available, the whole key space
// is treated as reserved. ReservedBytes optionally accounts for bytes that the
// running task will add to TargetLevel; it is used only when
// Config.EnforceTargetSize is enabled.
type RunningTask struct {
	ID            string
	SourceLevel   int
	TargetLevel   int
	InputIDs      []string
	Smallest      Key
	Largest       Key
	RangeSet      bool
	ReservedBytes uint64
}

// State is the immutable snapshot passed to the planner.
type State struct {
	Levels []Level
	// Running contains compactions that currently occupy files or key ranges.
	Running []RunningTask
	// TombstoneWatermark is the oldest live snapshot sequence number. A
	// tombstone whose sequence is <= the watermark is visible to every live
	// snapshot and may be elided when compaction reaches the bottom level.
	TombstoneWatermark uint64
}

// BottomLevel returns the index of the bottom level, or -1 for an empty state.
func (s State) BottomLevel() int {
	return len(s.Levels) - 1
}

// Validate checks the structural invariants required by the planner.
func (s State) Validate() error {
	if len(s.Levels) == 0 {
		return fmt.Errorf("%w: no levels", ErrInvalidState)
	}

	seenFiles := make(map[string]struct{})
	for levelIndex := range s.Levels {
		level := &s.Levels[levelIndex]
		if level.Number != levelIndex {
			return fmt.Errorf("%w: level at index %d has Number %d", ErrInvalidState, levelIndex, level.Number)
		}
		for fileIndex := range level.Files {
			file := &level.Files[fileIndex]
			if file.ID == "" {
				return fmt.Errorf("%w: level %d file %d has an empty ID", ErrInvalidState, levelIndex, fileIndex)
			}
			if _, exists := seenFiles[file.ID]; exists {
				return fmt.Errorf("%w: duplicate file ID %q", ErrInvalidState, file.ID)
			}
			seenFiles[file.ID] = struct{}{}
			if file.Smallest > file.Largest {
				return fmt.Errorf("%w: file %q has Smallest > Largest", ErrInvalidState, file.ID)
			}
			if file.TombstoneBytes > file.Size {
				return fmt.Errorf("%w: file %q has TombstoneBytes > Size", ErrInvalidState, file.ID)
			}
			if fileIndex > 0 && !(level.Files[fileIndex-1].Largest < file.Smallest) {
				return fmt.Errorf("%w: files %q and %q overlap or are unsorted in level %d",
					ErrInvalidState, level.Files[fileIndex-1].ID, file.ID, levelIndex)
			}
		}
	}

	seenTasks := make(map[string]struct{})
	for taskIndex := range s.Running {
		task := &s.Running[taskIndex]
		if task.ID == "" {
			return fmt.Errorf("%w: running task %d has an empty ID", ErrInvalidState, taskIndex)
		}
		if _, exists := seenTasks[task.ID]; exists {
			return fmt.Errorf("%w: duplicate running task ID %q", ErrInvalidState, task.ID)
		}
		seenTasks[task.ID] = struct{}{}
		if task.SourceLevel < 0 || task.SourceLevel >= len(s.Levels) {
			return fmt.Errorf("%w: running task %q has invalid source level %d", ErrInvalidState, task.ID, task.SourceLevel)
		}
		if task.TargetLevel < 0 || task.TargetLevel >= len(s.Levels) {
			return fmt.Errorf("%w: running task %q has invalid target level %d", ErrInvalidState, task.ID, task.TargetLevel)
		}
		if task.SourceLevel == task.TargetLevel {
			return fmt.Errorf("%w: running task %q has identical source and target levels", ErrInvalidState, task.ID)
		}
		if task.RangeSet && task.Smallest > task.Largest {
			return fmt.Errorf("%w: running task %q has Smallest > Largest", ErrInvalidState, task.ID)
		}
	}
	return nil
}

// ErrInvalidState indicates malformed planner input.
var ErrInvalidState = errors.New("compaction: invalid state")

// ErrNoPlan indicates that no compaction satisfies the supplied constraints.
var ErrNoPlan = errors.New("compaction: no feasible plan")

func satAdd(a, b uint64) uint64 {
	if math.MaxUint64-a < b {
		return math.MaxUint64
	}
	return a + b
}

func rangesOverlap(aLo, aHi, bLo, bHi Key) bool {
	return !(aHi < bLo || bHi < aLo)
}
