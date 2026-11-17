package formal

import "fmt"

// ValidatePlan verifies that plan is structurally valid, satisfies cfg, and
// does not conflict with any running task in state. It also recomputes the
// byte and tombstone metrics, so callers can use it as a safety check before
// handing a plan to an executor.
func ValidatePlan(state State, cfg Config, plan Plan) error {
	if err := state.Validate(); err != nil {
		return err
	}
	if err := cfg.validate(); err != nil {
		return err
	}
	if cfg.MaxConcurrentTasks > 0 && len(state.Running) >= cfg.MaxConcurrentTasks {
		return fmt.Errorf("%w: concurrency limit reached", ErrInvalidState)
	}
	if len(state.Levels) < 2 {
		return fmt.Errorf("%w: need at least two levels", ErrInvalidState)
	}
	if plan.SourceLevel < 0 || plan.SourceLevel+1 >= len(state.Levels) {
		return fmt.Errorf("%w: invalid source level %d", ErrInvalidState, plan.SourceLevel)
	}
	if plan.TargetLevel != plan.SourceLevel+1 {
		return fmt.Errorf("%w: target level must be source+1", ErrInvalidState)
	}

	source := state.Levels[plan.SourceLevel]
	target := state.Levels[plan.TargetLevel]
	if len(plan.SourceFiles) == 0 {
		return fmt.Errorf("%w: no source files", ErrInvalidState)
	}

	sourceStart := -1
	sourceEnd := -1
	for i, file := range source.Files {
		if file.ID == plan.SourceFiles[0] {
			sourceStart = i
			break
		}
	}
	if sourceStart < 0 {
		return fmt.Errorf("%w: source file %q not found", ErrInvalidState, plan.SourceFiles[0])
	}
	if len(plan.SourceFiles) > len(source.Files)-sourceStart {
		return fmt.Errorf("%w: source file list is not contiguous", ErrInvalidState)
	}
	for i, id := range plan.SourceFiles {
		if source.Files[sourceStart+i].ID != id {
			return fmt.Errorf("%w: source file list is not contiguous", ErrInvalidState)
		}
	}
	sourceEnd = sourceStart + len(plan.SourceFiles)

	lo := source.Files[sourceStart].Smallest
	hi := source.Files[sourceEnd-1].Largest
	targetStart, targetEnd := overlappingFiles(target.Files, lo, hi)
	expectedTarget := fileIDs(target.Files[targetStart:targetEnd])
	if err := sameIDs(plan.TargetFiles, expectedTarget); err != nil {
		return fmt.Errorf("%w: target overlap closure mismatch: %v", ErrInvalidState, err)
	}

	expectedInputs := append(append([]string(nil), plan.SourceFiles...), expectedTarget...)
	if err := sameIDs(plan.InputFiles, expectedInputs); err != nil {
		return fmt.Errorf("%w: input file list mismatch: %v", ErrInvalidState, err)
	}

	level := state.Levels[plan.SourceLevel]
	overLimit := level.SizeLimit > 0 && level.Size() > level.SizeLimit
	if !overLimit && !cfg.PlanWithoutSizePressure {
		return fmt.Errorf("%w: source level is not over its size limit", ErrInvalidState)
	}

	var sourceBytes uint64
	for _, file := range source.Files[sourceStart:sourceEnd] {
		sourceBytes = satAdd(sourceBytes, file.Size)
	}
	if cfg.MinSourceBytes > 0 {
		if sourceBytes < cfg.MinSourceBytes {
			return fmt.Errorf("%w: source bytes below MinSourceBytes", ErrInvalidState)
		}
	} else if overLimit && !cfg.AllowPartial {
		if sourceBytes < level.Size()-level.SizeLimit {
			return fmt.Errorf("%w: source bytes do not relieve level overflow", ErrInvalidState)
		}
	}
	if plan.SourceBytes != sourceBytes {
		return fmt.Errorf("%w: SourceBytes mismatch", ErrInvalidState)
	}

	var targetBytes, inputBytes uint64
	for _, file := range target.Files[targetStart:targetEnd] {
		targetBytes = satAdd(targetBytes, file.Size)
	}
	inputBytes = satAdd(sourceBytes, targetBytes)
	if plan.TargetBytes != targetBytes || plan.InputBytes != inputBytes {
		return fmt.Errorf("%w: byte metrics mismatch", ErrInvalidState)
	}
	if cfg.MaxSourceBytes > 0 && sourceBytes > cfg.MaxSourceBytes {
		return fmt.Errorf("%w: MaxSourceBytes exceeded", ErrInvalidState)
	}
	if cfg.MaxInputBytes > 0 && inputBytes > cfg.MaxInputBytes {
		return fmt.Errorf("%w: MaxInputBytes exceeded", ErrInvalidState)
	}
	if cfg.MaxFiles > 0 && len(expectedInputs) > cfg.MaxFiles {
		return fmt.Errorf("%w: MaxFiles exceeded", ErrInvalidState)
	}

	planner := NewPlanner(cfg)
	dropped, retained := planner.tombstoneBytes(state, plan.TargetLevel,
		source.Files[sourceStart:sourceEnd], target.Files[targetStart:targetEnd])
	writeBytes := satSub(inputBytes, dropped)
	if plan.DroppedTombstoneBytes != dropped ||
		plan.RetainedTombstoneBytes != retained ||
		plan.DroppedTombstones != (dropped > 0) ||
		plan.WriteBytes != writeBytes ||
		plan.OutputBytes != writeBytes {
		return fmt.Errorf("%w: tombstone or write metrics mismatch", ErrInvalidState)
	}
	if cfg.MaxWriteBytes > 0 && writeBytes > cfg.MaxWriteBytes {
		return fmt.Errorf("%w: MaxWriteBytes exceeded", ErrInvalidState)
	}

	inputRangeLo, inputRangeHi := lo, hi
	if targetStart < targetEnd {
		if target.Files[targetStart].Smallest < inputRangeLo {
			inputRangeLo = target.Files[targetStart].Smallest
		}
		if target.Files[targetEnd-1].Largest > inputRangeHi {
			inputRangeHi = target.Files[targetEnd-1].Largest
		}
	}
	if plan.Smallest != inputRangeLo || plan.Largest != inputRangeHi {
		return fmt.Errorf("%w: input key range mismatch", ErrInvalidState)
	}

	if cfg.EnforceTargetSize && target.SizeLimit > 0 {
		var reserved uint64
		for _, task := range state.Running {
			if task.TargetLevel == plan.TargetLevel {
				reserved = satAdd(reserved, task.ReservedBytes)
			}
		}
		projected := satAdd(satAdd(target.Size()-targetBytes, writeBytes), reserved)
		if projected > target.SizeLimit {
			return fmt.Errorf("%w: projected target size exceeds limit", ErrInvalidState)
		}
	}

	index := buildIndex(state)
	if planner.conflicts(state, index, plan) {
		return fmt.Errorf("%w: plan conflicts with a running task", ErrInvalidState)
	}
	return nil
}

func sameIDs(a, b []string) error {
	if len(a) != len(b) {
		return fmt.Errorf("got %d IDs, want %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			return fmt.Errorf("ID %d is %q, want %q", i, a[i], b[i])
		}
	}
	return nil
}
