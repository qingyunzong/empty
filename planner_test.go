package formal_test

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"testing"

	formal "example.org/dlks/formal/q10175"
)

func level(number int, limit uint64, files ...formal.File) formal.Level {
	return formal.Level{Number: number, SizeLimit: limit, Files: files}
}

func file(id string, lo, hi formal.Key, size uint64) formal.File {
	return formal.File{ID: id, Smallest: lo, Largest: hi, Size: size}
}

func mustPlan(t *testing.T, state formal.State, cfg ...formal.Config) formal.Plan {
	t.Helper()
	planner := formal.NewPlanner(cfg...)
	plan, err := planner.Plan(state)
	if err != nil {
		t.Fatalf("Plan() error = %v", err)
	}
	effective := formal.Config{}
	if len(cfg) > 0 {
		effective = cfg[0]
	}
	if err := formal.ValidatePlan(state, effective, plan); err != nil {
		t.Fatalf("ValidatePlan() error = %v", err)
	}
	return plan
}

func TestPlanSelectsSmallestRelievingRange(t *testing.T) {
	state := formal.State{Levels: []formal.Level{
		level(0, 50,
			file("f1", "a", "b", 30),
			file("f2", "c", "d", 30),
		),
		level(1, 0, file("g1", "b", "c", 100)),
	}}

	plan := mustPlan(t, state)
	if plan.SourceLevel != 0 || plan.TargetLevel != 1 {
		t.Fatalf("levels = %d->%d, want 0->1", plan.SourceLevel, plan.TargetLevel)
	}
	// Both source files relieve the 10-byte overflow. The lexical tie-break
	// chooses f1, and g1 is mandatory because it overlaps f1 at "b".
	if !reflect.DeepEqual(plan.SourceFiles, []string{"f1"}) {
		t.Fatalf("SourceFiles = %v, want [f1]", plan.SourceFiles)
	}
	if !reflect.DeepEqual(plan.TargetFiles, []string{"g1"}) {
		t.Fatalf("TargetFiles = %v, want [g1]", plan.TargetFiles)
	}
	if !reflect.DeepEqual(plan.InputFiles, []string{"f1", "g1"}) {
		t.Fatalf("InputFiles = %v", plan.InputFiles)
	}
	if plan.SourceBytes != 30 || plan.TargetBytes != 100 || plan.InputBytes != 130 || plan.WriteBytes != 130 {
		t.Fatalf("metrics = source:%d target:%d input:%d write:%d",
			plan.SourceBytes, plan.TargetBytes, plan.InputBytes, plan.WriteBytes)
	}
	if plan.Smallest != "a" || plan.Largest != "c" {
		t.Fatalf("range = [%q,%q], want [a,c]", plan.Smallest, plan.Largest)
	}
}

func TestPlanUsesWholeOverlapClosure(t *testing.T) {
	state := formal.State{Levels: []formal.Level{
		level(0, 1, file("f1", "b", "d", 10)),
		level(1, 0,
			file("g1", "a", "b", 10),
			file("g2", "c", "c", 10),
			file("g3", "d", "e", 10),
		),
	}}
	plan := mustPlan(t, state)
	want := []string{"g1", "g2", "g3"}
	if !reflect.DeepEqual(plan.TargetFiles, want) {
		t.Fatalf("TargetFiles = %v, want %v", plan.TargetFiles, want)
	}
	if plan.Smallest != "a" || plan.Largest != "e" {
		t.Fatalf("input range = [%q,%q], want [a,e]", plan.Smallest, plan.Largest)
	}
}

func TestNoPlanWhenNoLevelExceedsLimit(t *testing.T) {
	state := formal.State{Levels: []formal.Level{
		level(0, 100, file("f1", "a", "b", 10)),
		level(1, 100, file("g1", "a", "b", 10)),
	}}
	_, err := formal.BuildPlan(state)
	if !errors.Is(err, formal.ErrNoPlan) {
		t.Fatalf("Plan() error = %v, want ErrNoPlan", err)
	}

	cfg := formal.Config{PlanWithoutSizePressure: true}
	if _, err := formal.NewPlanner(cfg).Plan(state); err != nil {
		t.Fatalf("Plan() with PlanWithoutSizePressure error = %v", err)
	}
}

func TestTombstoneWatermark(t *testing.T) {
	base := formal.State{
		Levels: []formal.Level{
			level(0, 1, formal.File{
				ID: "f1", Smallest: "a", Largest: "z", Size: 100,
				TombstoneBytes: 20, TombstoneSeq: 5,
			}),
			level(1, 0),
		},
		TombstoneWatermark: 10,
	}
	plan := mustPlan(t, base)
	if plan.DroppedTombstoneBytes != 20 || plan.WriteBytes != 80 || !plan.DroppedTombstones {
		t.Fatalf("safe drop = %+v", plan)
	}

	newer := base
	newer.Levels = append([]formal.Level(nil), base.Levels...)
	newer.Levels[0].Files = []formal.File{{
		ID: "f1", Smallest: "a", Largest: "z", Size: 100,
		TombstoneBytes: 20, TombstoneSeq: 11,
	}}
	plan = mustPlan(t, newer)
	if plan.DroppedTombstoneBytes != 0 || plan.RetainedTombstoneBytes != 20 || plan.WriteBytes != 100 {
		t.Fatalf("unsafe tombstone must be retained: %+v", plan)
	}

	notBottom := formal.State{
		Levels: []formal.Level{
			level(0, 1, base.Levels[0].Files[0]),
			level(1, 0),
			level(2, 0),
		},
		TombstoneWatermark: 10,
	}
	plan = mustPlan(t, notBottom)
	if plan.DroppedTombstoneBytes != 0 || plan.RetainedTombstoneBytes != 20 {
		t.Fatalf("tombstone above the bottom level must be retained: %+v", plan)
	}

	retained := mustPlan(t, base, formal.Config{RetainTombstones: true})
	if retained.DroppedTombstoneBytes != 0 || retained.WriteBytes != 100 {
		t.Fatalf("RetainTombstones ignored: %+v", retained)
	}
}

func TestConcurrentOccupancy(t *testing.T) {
	state := formal.State{
		Levels: []formal.Level{
			level(0, 30, file("f1", "a", "m", 20), file("f2", "n", "z", 20)),
			level(1, 0),
		},
		Running: []formal.RunningTask{{
			ID: "r1", SourceLevel: 0, TargetLevel: 1, InputIDs: []string{"f1"},
		}},
	}
	plan := mustPlan(t, state)
	if !reflect.DeepEqual(plan.SourceFiles, []string{"f2"}) {
		t.Fatalf("reserved file was selected: %v", plan.SourceFiles)
	}

	disjoint := state
	disjoint.Running = []formal.RunningTask{{
		ID: "r1", SourceLevel: 0, TargetLevel: 1,
		Smallest: "n", Largest: "z", RangeSet: true,
	}}
	plan = mustPlan(t, disjoint)
	if !reflect.DeepEqual(plan.SourceFiles, []string{"f1"}) {
		t.Fatalf("disjoint same-level range should leave f1 selectable; got %v", plan.SourceFiles)
	}

	cfg := formal.Config{ExclusiveLevels: true}
	if _, err := formal.NewPlanner(cfg).Plan(disjoint); !errors.Is(err, formal.ErrNoPlan) {
		t.Fatalf("ExclusiveLevels error = %v, want ErrNoPlan", err)
	}

	slots := formal.Config{MaxConcurrentTasks: 1}
	if _, err := formal.NewPlanner(slots).Plan(state); !errors.Is(err, formal.ErrNoPlan) {
		t.Fatalf("MaxConcurrentTasks error = %v, want ErrNoPlan", err)
	}
}

func TestRunningTargetRangeBlocksNewOutput(t *testing.T) {
	state := formal.State{
		Levels: []formal.Level{
			level(0, 1, file("f1", "a", "a", 10)),
			level(1, 0),
			level(2, 0, file("h1", "a", "a", 1)),
		},
		Running: []formal.RunningTask{{
			ID: "r1", SourceLevel: 1, TargetLevel: 2,
			Smallest: "a", Largest: "a", RangeSet: true,
		}},
	}
	if _, err := formal.BuildPlan(state); !errors.Is(err, formal.ErrNoPlan) {
		t.Fatalf("Plan() error = %v, want ErrNoPlan (target range is occupied)", err)
	}
}

func TestUnknownRunningInputIsConservativelyBlocking(t *testing.T) {
	state := formal.State{
		Levels: []formal.Level{
			level(0, 1, file("f1", "a", "a", 10)),
			level(1, 0),
		},
		Running: []formal.RunningTask{{
			ID: "r1", SourceLevel: 0, TargetLevel: 1,
			InputIDs: []string{"already-being-written"},
		}},
	}
	if _, err := formal.BuildPlan(state); !errors.Is(err, formal.ErrNoPlan) {
		t.Fatalf("Plan() error = %v, want ErrNoPlan for unknown occupied range", err)
	}
}

func TestTargetSizeConstraint(t *testing.T) {
	state := formal.State{Levels: []formal.Level{
		level(0, 1, file("f1", "a", "a", 30)),
		level(1, 40, file("g1", "a", "a", 20)),
	}}
	if _, err := formal.NewPlanner(formal.Config{EnforceTargetSize: true}).Plan(state); !errors.Is(err, formal.ErrNoPlan) {
		t.Fatalf("Plan() error = %v, want ErrNoPlan (20+30 > 40)", err)
	}
	plan := mustPlan(t, state)
	if plan.SourceFiles[0] != "f1" {
		t.Fatalf("unexpected plan %+v", plan)
	}
}

func TestDeterministicSourceLevelTieBreak(t *testing.T) {
	state := formal.State{Levels: []formal.Level{
		level(0, 1, file("f1", "a", "a", 10)),
		level(1, 1, file("g1", "m", "m", 10)),
		level(2, 0),
	}}
	plan := mustPlan(t, state)
	if plan.SourceLevel != 0 {
		t.Fatalf("SourceLevel = %d, want 0 by tie-break", plan.SourceLevel)
	}

	// A running task on level 0 leaves the equally-priced level-1 candidate.
	state.Running = []formal.RunningTask{{
		ID: "r1", SourceLevel: 0, TargetLevel: 1,
		Smallest: "a", Largest: "a", RangeSet: true,
	}}
	plan = mustPlan(t, state)
	if plan.SourceLevel != 1 || !reflect.DeepEqual(plan.SourceFiles, []string{"g1"}) {
		t.Fatalf("fallback plan = %+v", plan)
	}
}

func TestOverBudgetHasNoPlan(t *testing.T) {
	state := formal.State{Levels: []formal.Level{
		level(0, 1, file("f1", "a", "a", 30)),
		level(1, 0, file("g1", "a", "a", 50)),
	}}
	cfg := formal.Config{MaxInputBytes: 79}
	if _, err := formal.NewPlanner(cfg).Plan(state); !errors.Is(err, formal.ErrNoPlan) {
		t.Fatalf("Plan() error = %v, want ErrNoPlan", err)
	}
	cfg.MaxInputBytes = 80
	mustPlan(t, state, cfg)
}

func TestRejectsMalformedState(t *testing.T) {
	state := formal.State{Levels: []formal.Level{
		{Number: 1, Files: []formal.File{file("f1", "a", "b", 1)}},
	}}
	if _, err := formal.BuildPlan(state); !errors.Is(err, formal.ErrInvalidState) {
		t.Fatalf("Plan() error = %v, want ErrInvalidState", err)
	}
}

// bruteCandidate is deliberately independent of the planner's pruning. It
// enumerates every contiguous source range and every endpoint.
type bruteCandidate struct {
	sourceLevel int
	sourceFiles []string
	targetFiles []string
	inputFiles  []string
	sourceBytes uint64
	inputBytes  uint64
	writeBytes  uint64
	smallest    formal.Key
	largest     formal.Key
}

func bruteBest(state formal.State, cfg formal.Config) (bruteCandidate, bool) {
	if len(state.Levels) < 2 {
		return bruteCandidate{}, false
	}
	if cfg.MaxConcurrentTasks > 0 && len(state.Running) >= cfg.MaxConcurrentTasks {
		return bruteCandidate{}, false
	}

	fileByID := make(map[string]formal.File)
	for _, level := range state.Levels {
		for _, f := range level.Files {
			fileByID[f.ID] = f
		}
	}

	var best bruteCandidate
	found := false
	for sourceLevel := 0; sourceLevel+1 < len(state.Levels); sourceLevel++ {
		source := state.Levels[sourceLevel]
		target := state.Levels[sourceLevel+1]
		over := source.SizeLimit > 0 && source.Size() > source.SizeLimit
		if !over && !cfg.PlanWithoutSizePressure {
			continue
		}
		minSource := uint64(0)
		if cfg.MinSourceBytes > 0 {
			minSource = cfg.MinSourceBytes
		} else if over && !cfg.AllowPartial {
			minSource = source.Size() - source.SizeLimit
		}

		for start := 0; start < len(source.Files); start++ {
			var sourceBytes uint64
			for end := start; end < len(source.Files); end++ {
				sourceBytes += source.Files[end].Size
				if sourceBytes < minSource {
					continue
				}
				if cfg.MaxSourceBytes > 0 && sourceBytes > cfg.MaxSourceBytes {
					continue
				}

				lo := source.Files[start].Smallest
				hi := source.Files[end].Largest
				var targetFiles []formal.File
				for _, f := range target.Files {
					if f.Overlaps(lo, hi) {
						targetFiles = append(targetFiles, f)
					}
				}
				var targetBytes uint64
				for _, f := range targetFiles {
					targetBytes = satAddTest(targetBytes, f.Size)
				}
				inputBytes := satAddTest(sourceBytes, targetBytes)
				if cfg.MaxInputBytes > 0 && inputBytes > cfg.MaxInputBytes {
					continue
				}
				inputCount := (end - start + 1) + len(targetFiles)
				if cfg.MaxFiles > 0 && inputCount > cfg.MaxFiles {
					continue
				}

				var dropped, retained uint64
				canDrop := sourceLevel+1 == state.BottomLevel() && !cfg.RetainTombstones
				for _, f := range append(append([]formal.File(nil), source.Files[start:end+1]...), targetFiles...) {
					if f.TombstoneBytes == 0 {
						continue
					}
					if canDrop && f.TombstoneSeq <= state.TombstoneWatermark {
						dropped += f.TombstoneBytes
					} else {
						retained += f.TombstoneBytes
					}
				}
				_ = retained
				writeBytes := satSubTest(inputBytes, dropped)
				if cfg.MaxWriteBytes > 0 && writeBytes > cfg.MaxWriteBytes {
					continue
				}

				smallest, largest := lo, hi
				for _, f := range targetFiles {
					if f.Smallest < smallest {
						smallest = f.Smallest
					}
					if f.Largest > largest {
						largest = f.Largest
					}
				}

				if cfg.EnforceTargetSize && target.SizeLimit > 0 {
					var reserved uint64
					for _, task := range state.Running {
						if task.TargetLevel == sourceLevel+1 {
							reserved += task.ReservedBytes
						}
					}
					projected := satSubTest(target.Size(), targetBytes)
					projected = satAddTest(projected, writeBytes)
					projected = satAddTest(projected, reserved)
					if projected > target.SizeLimit {
						continue
					}
				}

				ids := make([]string, 0, inputCount)
				for _, f := range source.Files[start : end+1] {
					ids = append(ids, f.ID)
				}
				sourceIDs := append([]string(nil), ids...)
				for _, f := range targetFiles {
					ids = append(ids, f.ID)
				}
				targetIDs := make([]string, len(targetFiles))
				for i, f := range targetFiles {
					targetIDs[i] = f.ID
				}
				if conflictsTest(makeSelection(ids), state, fileByID, sourceLevel, sourceLevel+1,
					smallest, largest, cfg.ExclusiveLevels) {
					continue
				}

				cand := bruteCandidate{
					sourceLevel: sourceLevel,
					sourceFiles: sourceIDs,
					targetFiles: targetIDs,
					inputFiles:  ids,
					sourceBytes: sourceBytes,
					inputBytes:  inputBytes,
					writeBytes:  writeBytes,
					smallest:    smallest,
					largest:     largest,
				}
				if !found || bruteBetter(cand, best) {
					best = cand
					found = true
				}
			}
		}
	}
	return best, found
}

type idSelection map[string]struct{}

func makeSelection(ids []string) idSelection {
	selected := make(idSelection, len(ids))
	for _, id := range ids {
		selected[id] = struct{}{}
	}
	return selected
}

func conflictsTest(selected idSelection, state formal.State, files map[string]formal.File,
	sourceLevel, targetLevel int, lo, hi formal.Key, exclusive bool) bool {
	for _, task := range state.Running {
		for _, id := range task.InputIDs {
			if _, ok := selected[id]; ok {
				return true
			}
		}
		shares := task.SourceLevel == sourceLevel || task.SourceLevel == targetLevel ||
			task.TargetLevel == sourceLevel || task.TargetLevel == targetLevel
		if !shares {
			continue
		}
		if exclusive {
			return true
		}
		tlo, thi, known := task.Smallest, task.Largest, task.RangeSet
		missing := false
		for _, id := range task.InputIDs {
			f, ok := files[id]
			if !ok {
				missing = true
				continue
			}
			if !known {
				tlo, thi, known = f.Smallest, f.Largest, true
			} else {
				if f.Smallest < tlo {
					tlo = f.Smallest
				}
				if f.Largest > thi {
					thi = f.Largest
				}
			}
		}
		if missing && !task.RangeSet {
			known = false
		}
		if !known {
			return true
		}
		if !(hi < tlo || thi < lo) {
			return true
		}
	}
	return false
}

func bruteBetter(a, b bruteCandidate) bool {
	if a.writeBytes != b.writeBytes {
		return a.writeBytes < b.writeBytes
	}
	if a.inputBytes != b.inputBytes {
		return a.inputBytes < b.inputBytes
	}
	if len(a.inputFiles) != len(b.inputFiles) {
		return len(a.inputFiles) < len(b.inputFiles)
	}
	if a.sourceLevel != b.sourceLevel {
		return a.sourceLevel < b.sourceLevel
	}
	if cmp := compareTest(a.sourceFiles, b.sourceFiles); cmp != 0 {
		return cmp < 0
	}
	return compareTest(a.targetFiles, b.targetFiles) < 0
}

func compareTest(a, b []string) int {
	for i := 0; i < len(a) && i < len(b); i++ {
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

func satAddTest(a, b uint64) uint64 {
	if ^uint64(0)-a < b {
		return ^uint64(0)
	}
	return a + b
}

func satSubTest(a, b uint64) uint64 {
	if b > a {
		return 0
	}
	return a - b
}

// TestExhaustiveSmallScaleOptimality compares the planner against an
// independent exhaustive enumeration. Every generated case is small enough to
// enumerate every contiguous source range and every endpoint.
func TestExhaustiveSmallScaleOptimality(t *testing.T) {
	rng := rand.New(rand.NewSource(10175))
	plans := 0
	for caseIndex := 0; caseIndex < 500; caseIndex++ {
		state := randomState(rng, caseIndex)
		cfg := randomConfig(rng)

		got, err := formal.NewPlanner(cfg).Plan(state)
		want, ok := bruteBest(state, cfg)
		if !ok {
			if !errors.Is(err, formal.ErrNoPlan) {
				t.Fatalf("case %d: Plan() error = %v, want ErrNoPlan; state=%s cfg=%+v",
					caseIndex, err, dumpState(state), cfg)
			}
			continue
		}
		if err != nil {
			t.Fatalf("case %d: Plan() error = %v, want feasible; state=%s cfg=%+v",
				caseIndex, err, dumpState(state), cfg)
		}
		plans++

		if err := formal.ValidatePlan(state, cfg, got); err != nil {
			t.Fatalf("case %d: plan is infeasible: %v\nplan=%+v\nstate=%s\ncfg=%+v",
				caseIndex, err, got, dumpState(state), cfg)
		}
		fileByID := make(map[string]formal.File)
		for _, lvl := range state.Levels {
			for _, f := range lvl.Files {
				fileByID[f.ID] = f
			}
		}
		if conflictsTest(makeSelection(got.InputFiles), state, fileByID,
			got.SourceLevel, got.TargetLevel, got.Smallest, got.Largest, cfg.ExclusiveLevels) {
			t.Fatalf("case %d: plan conflicts with a running task\nplan=%+v\nstate=%s",
				caseIndex, got, dumpState(state))
		}
		if got.WriteBytes != want.writeBytes {
			t.Fatalf("case %d: WriteBytes = %d, optimum = %d\nplan=%+v\nbrute=%+v\nstate=%s\ncfg=%+v",
				caseIndex, got.WriteBytes, want.writeBytes, got, want, dumpState(state), cfg)
		}
		if !reflect.DeepEqual(got.SourceFiles, want.sourceFiles) ||
			!reflect.DeepEqual(got.TargetFiles, want.targetFiles) {
			t.Fatalf("case %d: tie-break mismatch\nplan=%+v\nbrute=%+v\nstate=%s\ncfg=%+v",
				caseIndex, got, want, dumpState(state), cfg)
		}

		again, err := formal.NewPlanner(cfg).Plan(state)
		if err != nil || !reflect.DeepEqual(got, again) {
			t.Fatalf("case %d: planner is not deterministic: err=%v\nfirst=%+v\nsecond=%+v",
				caseIndex, err, got, again)
		}
	}
	if plans < 100 {
		t.Fatalf("only %d feasible plans generated; test is not exercising the optimizer", plans)
	}
}

func randomState(rng *rand.Rand, caseIndex int) formal.State {
	levelCount := 3
	levels := make([]formal.Level, levelCount)
	cursor := 0
	for li := range levels {
		count := rng.Intn(4)
		files := make([]formal.File, 0, count)
		for fi := 0; fi < count; fi++ {
			width := rng.Intn(3)
			lo := keyAt(cursor)
			hi := keyAt(cursor + width)
			cursor += width + 2
			size := uint64(rng.Intn(26))
			tombstones := uint64(0)
			if size > 0 && rng.Intn(4) == 0 {
				tombstones = uint64(rng.Intn(int(size) + 1))
			}
			files = append(files, formal.File{
				ID:             fmt.Sprintf("f%d_%d", li, fi),
				Smallest:       lo,
				Largest:        hi,
				Size:           size,
				TombstoneBytes: tombstones,
				TombstoneSeq:   uint64(rng.Intn(21)),
			})
		}
		limit := uint64(rng.Intn(61))
		if rng.Intn(5) == 0 {
			limit = 0
		}
		levels[li] = level(li, limit, files...)
	}

	state := formal.State{
		Levels:             levels,
		TombstoneWatermark: uint64(rng.Intn(21)),
	}
	for ti := 0; ti < rng.Intn(3); ti++ {
		sourceLevel := rng.Intn(levelCount - 1)
		task := formal.RunningTask{
			ID:          fmt.Sprintf("r%d", ti),
			SourceLevel: sourceLevel,
			TargetLevel: sourceLevel + 1,
		}
		var ids []string
		for li, lvl := range levels {
			if li != sourceLevel && li != sourceLevel+1 {
				continue
			}
			for _, f := range lvl.Files {
				if rng.Intn(3) == 0 {
					ids = append(ids, f.ID)
				}
			}
		}
		task.InputIDs = ids
		if rng.Intn(2) == 0 {
			a := rng.Intn(30)
			b := a + rng.Intn(30-a)
			task.Smallest = keyAt(a)
			task.Largest = keyAt(b)
			task.RangeSet = true
		}
		if rng.Intn(3) == 0 {
			task.ReservedBytes = uint64(rng.Intn(20))
		}
		state.Running = append(state.Running, task)
	}
	return state
}

func randomConfig(rng *rand.Rand) formal.Config {
	cfg := formal.Config{
		AllowPartial:            rng.Intn(5) == 0,
		PlanWithoutSizePressure: rng.Intn(4) == 0,
		ExclusiveLevels:         rng.Intn(6) == 0,
		EnforceTargetSize:       rng.Intn(3) == 0,
		RetainTombstones:        rng.Intn(8) == 0,
	}
	if rng.Intn(2) == 0 {
		cfg.MinSourceBytes = uint64(rng.Intn(40))
	}
	if rng.Intn(3) == 0 {
		cfg.MaxSourceBytes = uint64(rng.Intn(100))
	}
	if rng.Intn(3) == 0 {
		cfg.MaxInputBytes = uint64(rng.Intn(180))
	}
	if rng.Intn(3) == 0 {
		cfg.MaxWriteBytes = uint64(rng.Intn(180))
	}
	if rng.Intn(3) == 0 {
		cfg.MaxFiles = 1 + rng.Intn(4)
	}
	if rng.Intn(5) == 0 {
		cfg.MaxConcurrentTasks = 1 + rng.Intn(3)
	}
	return cfg
}

func keyAt(i int) formal.Key {
	return formal.Key(fmt.Sprintf("k%04d", i))
}

func dumpState(state formal.State) string {
	var out string
	for _, lvl := range state.Levels {
		out += fmt.Sprintf("L%d(limit=%d){", lvl.Number, lvl.SizeLimit)
		for _, f := range lvl.Files {
			out += fmt.Sprintf("%s:[%s,%s]%d/t%d@%d ", f.ID, f.Smallest, f.Largest,
				f.Size, f.TombstoneBytes, f.TombstoneSeq)
		}
		out += "} "
	}
	out += fmt.Sprintf("watermark=%d running=%+v", state.TombstoneWatermark, state.Running)
	return out
}
