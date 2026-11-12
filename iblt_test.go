package dataeng

import (
	"errors"
	"math/big"
	"testing"
)

func testCheck(id uint64) uint64 {
	return id*0x9e3779b97f4a7c15 + 0x7f4a7c15
}

func mappedHash(indices map[uint64][]int, checks map[uint64]uint64) HashFunc {
	return func(id uint64, _ []uint64, _ int) ([]int, uint64) {
		mapped, ok := indices[id]
		if !ok {
			return nil, 0
		}
		check, ok := checks[id]
		if !ok {
			check = testCheck(id)
		}
		return append([]int(nil), mapped...), check
	}
}

func mustConfig(t *testing.T, cells int, seeds []uint64, scheme string, hash HashFunc) Config {
	t.Helper()
	cfg := Config{Cells: cells, Seeds: seeds, SchemeID: scheme, Hash: hash}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("invalid test configuration: %v", err)
	}
	return cfg
}

func mustBuild(t *testing.T, cfg Config, ids []uint64) *Table {
	t.Helper()
	table, err := BuildTable(cfg, ids)
	if err != nil {
		t.Fatalf("BuildTable(%v): %v", ids, err)
	}
	return table
}

func mustDiff(t *testing.T, a, b *Table) *Table {
	t.Helper()
	diff, err := Subtract(a, b)
	if err != nil {
		t.Fatalf("Subtract: %v", err)
	}
	return diff
}

func mustPeel(t *testing.T, diff *Table, budget int) *PeelResult {
	t.Helper()
	result, err := Peel(diff, budget)
	if err != nil {
		t.Fatalf("Peel: %v", err)
	}
	return result
}

func resultKeys(result *PeelResult) []PeeledKey {
	return result.Keys
}

func assertUniqueKeys(t *testing.T, keys []PeeledKey) {
	t.Helper()
	seen := make(map[uint64]struct{}, len(keys))
	for _, key := range keys {
		if _, ok := seen[key.Key]; ok {
			t.Fatalf("key %d emitted more than once: %+v", key.Key, keys)
		}
		seen[key.Key] = struct{}{}
	}
}

func TestConfigValidation(t *testing.T) {
	validHash := func(uint64, []uint64, int) ([]int, uint64) { return []int{0}, 1 }
	cases := []struct {
		name string
		cfg  Config
	}{
		{"zero cells", Config{Cells: 0, Seeds: []uint64{1}, SchemeID: "x", Hash: validHash}},
		{"no seeds", Config{Cells: 3, SchemeID: "x", Hash: validHash}},
		{"too many seeds", Config{Cells: 2, Seeds: []uint64{1, 2, 3}, SchemeID: "x", Hash: validHash}},
		{"duplicate seeds", Config{Cells: 3, Seeds: []uint64{1, 1}, SchemeID: "x", Hash: validHash}},
		{"empty scheme", Config{Cells: 3, Seeds: []uint64{1}, Hash: validHash}},
		{"nil hash", Config{Cells: 3, Seeds: []uint64{1}, SchemeID: "x"}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if err := test.cfg.Validate(); !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("Validate() error = %v, want ErrInvalidConfig", err)
			}
		})
	}

	edge := Config{Cells: 3, Seeds: []uint64{1, 2, 3}, SchemeID: "x", Hash: func(uint64, []uint64, int) ([]int, uint64) {
		return []int{0, 1, 2}, 0
	}}
	if err := edge.Validate(); err != nil {
		t.Fatalf("k == m should be valid: %v", err)
	}
}

func TestBuildTableRejectsDuplicateIDs(t *testing.T) {
	cfg := mustConfig(t, 4, []uint64{1}, "dup-id", func(id uint64, _ []uint64, _ int) ([]int, uint64) {
		return []int{int(id % 4)}, testCheck(id)
	})
	if _, err := BuildTable(cfg, []uint64{1, 2, 1}); !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("BuildTable duplicate error = %v, want ErrDuplicateID", err)
	}
}

func TestInvalidHostHashOutputIsRejectedAtomically(t *testing.T) {
	t.Run("duplicate index", func(t *testing.T) {
		cfg := mustConfig(t, 4, []uint64{1, 2}, "bad-duplicate", func(uint64, []uint64, int) ([]int, uint64) {
			return []int{1, 1}, 0
		})
		if _, err := BuildTable(cfg, []uint64{1}); !errors.Is(err, ErrInvalidHashOutput) {
			t.Fatalf("BuildTable error = %v, want ErrInvalidHashOutput", err)
		}
	})

	t.Run("out of range", func(t *testing.T) {
		cfg := mustConfig(t, 4, []uint64{1}, "bad-range", func(uint64, []uint64, int) ([]int, uint64) {
			return []int{4}, 0
		})
		if _, err := BuildTable(cfg, []uint64{1}); !errors.Is(err, ErrInvalidHashOutput) {
			t.Fatalf("BuildTable error = %v, want ErrInvalidHashOutput", err)
		}
	})

	t.Run("wrong index count", func(t *testing.T) {
		cfg := mustConfig(t, 4, []uint64{1, 2}, "bad-count", func(uint64, []uint64, int) ([]int, uint64) {
			return []int{0}, 0
		})
		if _, err := BuildTable(cfg, []uint64{1}); !errors.Is(err, ErrInvalidHashOutput) {
			t.Fatalf("BuildTable error = %v, want ErrInvalidHashOutput", err)
		}
	})

	t.Run("insert leaves table unchanged", func(t *testing.T) {
		cfg := mustConfig(t, 4, []uint64{1}, "bad-insert", func(id uint64, _ []uint64, _ int) ([]int, uint64) {
			if id == 99 {
				return []int{7}, 0
			}
			return []int{int(id % 4)}, testCheck(id)
		})
		table, err := NewTable(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if err := table.Insert(1); err != nil {
			t.Fatal(err)
		}
		before := table.Fingerprint()
		if err := table.Insert(99); !errors.Is(err, ErrInvalidHashOutput) {
			t.Fatalf("Insert error = %v, want ErrInvalidHashOutput", err)
		}
		if after := table.Fingerprint(); after != before {
			t.Fatal("invalid insertion changed the table")
		}
	})

	t.Run("peel rejects invalid mapping of a candidate key", func(t *testing.T) {
		all := map[uint64][]int{
			10: {0}, 20: {0}, 30: {0}, 7: {0}, 9: {0},
			// 14 is the XOR-combined candidate key. Its host mapping is
			// deliberately invalid.
			14: {5},
		}
		cfg := mustConfig(t, 1, []uint64{3}, "bad-candidate", mappedHash(all, nil))
		a := mustBuild(t, cfg, []uint64{10, 20, 30})
		b := mustBuild(t, cfg, []uint64{7, 9})
		diff := mustDiff(t, a, b)
		if _, err := Peel(diff, 10); !errors.Is(err, ErrInvalidHashOutput) {
			t.Fatalf("Peel error = %v, want ErrInvalidHashOutput", err)
		}
	})
}

func TestSubtractRequiresIdenticalConfiguration(t *testing.T) {
	hash := func(id uint64, _ []uint64, _ int) ([]int, uint64) { return []int{0, 1}, testCheck(id) }
	a := mustBuild(t, mustConfig(t, 4, []uint64{1, 2}, "scheme-a", hash), []uint64{1})
	b := mustBuild(t, mustConfig(t, 5, []uint64{1, 2}, "scheme-b", hash), []uint64{2})
	if _, err := Subtract(a, b); !errors.Is(err, ErrConfigMismatch) {
		t.Fatalf("Subtract error = %v, want ErrConfigMismatch", err)
	}
}

func TestInsertDeleteAndNegativeCount(t *testing.T) {
	cfg := mustConfig(t, 1, []uint64{1}, "insert-delete", mappedHash(map[uint64][]int{
		5: {0},
	}, nil))
	table, err := NewTable(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := table.Insert(5); err != nil {
		t.Fatal(err)
	}
	cell := table.Cells()[0]
	if cell.CountString() != "1" || cell.KeyXor != 5 || cell.CheckXor != testCheck(5) {
		t.Fatalf("after insert: %+v", cell)
	}
	if err := table.Delete(5); err != nil {
		t.Fatal(err)
	}
	if cell := table.Cells()[0]; !cell.isZero() {
		t.Fatalf("after insert/delete: %+v", cell)
	}
	if err := table.Delete(5); err != nil {
		t.Fatal(err)
	}
	cell = table.Cells()[0]
	if cell.CountString() != "-1" || cell.KeyXor != 5 || cell.CheckXor != testCheck(5) {
		t.Fatalf("after second delete: %+v", cell)
	}
}

func TestCountsAreArbitraryPrecision(t *testing.T) {
	cfg := mustConfig(t, 1, []uint64{1}, "big-count", mappedHash(map[uint64][]int{
		5: {0},
	}, nil))
	table, err := NewTable(cfg)
	if err != nil {
		t.Fatal(err)
	}
	huge := new(big.Int).Lsh(big.NewInt(1), 100)
	table.cells[0].count.Set(huge)
	if err := table.Delete(5); err != nil {
		t.Fatal(err)
	}
	want := new(big.Int).Sub(huge, bigOne)
	if got := table.Cells()[0].Count; got.Cmp(want) != 0 {
		t.Fatalf("count = %s, want %s", got, want)
	}
}

func TestPeelSuccessfulDifferenceAndOriginalUnchanged(t *testing.T) {
	cfg := mustConfig(t, 8, []uint64{10, 20}, "success", mappedHash(map[uint64][]int{
		1: {0, 1},
		2: {2, 3},
		3: {4, 5},
		4: {6, 7},
	}, nil))
	a := mustBuild(t, cfg, []uint64{1, 2, 3})
	b := mustBuild(t, cfg, []uint64{3, 4})
	diff := mustDiff(t, a, b)

	beforeFingerprint := diff.Fingerprint()
	beforeConfigFingerprint := diff.ConfigFingerprint()
	result := mustPeel(t, diff, 10)

	if result.Status != PeelStatusPeeled {
		t.Fatalf("status = %s, want peeled; residual=%+v", result.Status, result.Residual)
	}
	if result.Steps != 3 || result.StepsThisRun != 3 {
		t.Fatalf("steps = %d/%d, want 3/3", result.Steps, result.StepsThisRun)
	}
	if !peeledKeysEqual(result.NewKeys, result.Keys) {
		t.Fatalf("NewKeys = %+v, Keys = %+v", result.NewKeys, result.Keys)
	}
	if len(result.Residual) != 0 {
		t.Fatalf("peeled result has residual cells: %+v", result.Residual)
	}
	want := []PeeledKey{
		{Key: 1, Direction: DirectionPositive, Cell: 0, Step: 1},
		{Key: 2, Direction: DirectionPositive, Cell: 2, Step: 2},
		{Key: 4, Direction: DirectionNegative, Cell: 6, Step: 3},
	}
	if got := resultKeys(result); !peeledKeysEqual(got, want) {
		t.Fatalf("keys = %+v, want %+v", got, want)
	}
	if diff.Fingerprint() != beforeFingerprint || diff.ConfigFingerprint() != beforeConfigFingerprint {
		t.Fatal("peeling mutated the original difference table")
	}

	verification, err := result.Verify([]uint64{1, 2, 3}, []uint64{3, 4})
	if err != nil {
		t.Fatal(err)
	}
	if !verification.IsVerified() {
		t.Fatalf("verification = %+v, want verified", verification)
	}
}

func peeledKeysEqual(a, b []PeeledKey) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestPeelNegativeCell(t *testing.T) {
	cfg := mustConfig(t, 4, []uint64{5}, "negative", mappedHash(map[uint64][]int{
		10: {2},
	}, nil))
	a := mustBuild(t, cfg, nil)
	b := mustBuild(t, cfg, []uint64{10})
	diff := mustDiff(t, a, b)

	cell := diff.Cells()[2]
	if cell.CountString() != "-1" {
		t.Fatalf("negative cell count = %s, want -1", cell.CountString())
	}
	if cell.KeyXor != 10 {
		t.Fatalf("negative cell keyXor = %d, want 10", cell.KeyXor)
	}

	result := mustPeel(t, diff, 10)
	if result.Status != PeelStatusPeeled {
		t.Fatalf("status = %s, want peeled", result.Status)
	}
	if len(result.Keys) != 1 || result.Keys[0].Key != 10 || result.Keys[0].Direction != DirectionNegative {
		t.Fatalf("keys = %+v, want 10 negative", result.Keys)
	}
}

func TestPeelZeroKey(t *testing.T) {
	cfg := mustConfig(t, 4, []uint64{7}, "zero-key", mappedHash(
		map[uint64][]int{0: {1}},
		map[uint64]uint64{0: 0xdeadbeef},
	))
	a := mustBuild(t, cfg, []uint64{0})
	b := mustBuild(t, cfg, nil)
	diff := mustDiff(t, a, b)

	cell := diff.Cells()[1]
	if cell.CountString() != "1" || cell.KeyXor != 0 || cell.CheckXor != 0xdeadbeef {
		t.Fatalf("zero-key cell = %+v", cell)
	}

	result := mustPeel(t, diff, 10)
	if result.Status != PeelStatusPeeled {
		t.Fatalf("status = %s, want peeled", result.Status)
	}
	if len(result.Keys) != 1 || result.Keys[0].Key != 0 || result.Keys[0].Direction != DirectionPositive {
		t.Fatalf("keys = %+v, want 0 positive", result.Keys)
	}
	verification, err := result.Verify([]uint64{0}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !verification.IsVerified() {
		t.Fatalf("verification = %+v, want verified", verification)
	}
}

func TestTwoCellsExposeSameKey(t *testing.T) {
	cfg := mustConfig(t, 4, []uint64{1, 2}, "two-cells", mappedHash(map[uint64][]int{
		7: {0, 2},
	}, nil))
	diff := mustDiff(t, mustBuild(t, cfg, []uint64{7}), mustBuild(t, cfg, nil))

	for _, index := range []int{0, 2} {
		if diff.Cells()[index].CountString() != "1" || diff.Cells()[index].KeyXor != 7 {
			t.Fatalf("cell %d = %+v, want a candidate for key 7", index, diff.Cells()[index])
		}
	}

	result := mustPeel(t, diff, 10)
	if result.Status != PeelStatusPeeled {
		t.Fatalf("status = %s, want peeled; residual=%+v", result.Status, result.Residual)
	}
	if result.Steps != 1 {
		t.Fatalf("steps = %d, want 1; a key exposed in two cells is one step", result.Steps)
	}
	if len(result.Keys) != 1 || result.Keys[0].Key != 7 {
		t.Fatalf("keys = %+v, want key 7 once", result.Keys)
	}
}

func TestNonPeelableCycleReturnsIncompleteResidual(t *testing.T) {
	cfg := mustConfig(t, 2, []uint64{0, 1}, "cycle", mappedHash(map[uint64][]int{
		1: {0, 1},
		2: {0, 1},
	}, nil))
	diff := mustDiff(t, mustBuild(t, cfg, []uint64{1, 2}), mustBuild(t, cfg, nil))

	for _, index := range []int{0, 1} {
		if diff.Cells()[index].CountString() != "2" {
			t.Fatalf("cell %d count = %s, want 2", index, diff.Cells()[index].CountString())
		}
	}

	result := mustPeel(t, diff, 10)
	if result.Status != PeelStatusIncomplete {
		t.Fatalf("status = %s, want incomplete", result.Status)
	}
	if result.Steps != 0 || len(result.Keys) != 0 {
		t.Fatalf("incomplete result produced output: steps=%d keys=%+v", result.Steps, result.Keys)
	}
	if len(result.Residual) != 2 {
		t.Fatalf("residual = %+v, want two cells", result.Residual)
	}

	verification, err := result.Verify([]uint64{1, 2}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if verification.IsVerified() {
		t.Fatal("incomplete digest must not verify as a complete set difference")
	}
}

func TestCheckCollisionCanProduceFakeCandidate(t *testing.T) {
	// All checks are zero, so a cell count of 1 with keyXor == 14 passes the
	// finite check test even though 14 is not an input. 10^20^30^7^9 == 14.
	cfg := mustConfig(t, 1, []uint64{3}, "check-collision", mappedHash(map[uint64][]int{
		10: {0}, 20: {0}, 30: {0}, 7: {0}, 9: {0}, 14: {0},
	}, map[uint64]uint64{
		10: 0, 20: 0, 30: 0, 7: 0, 9: 0, 14: 0,
	}))
	a := mustBuild(t, cfg, []uint64{10, 20, 30})
	b := mustBuild(t, cfg, []uint64{7, 9})
	diff := mustDiff(t, a, b)

	if diff.Cells()[0].CountString() != "1" || diff.Cells()[0].KeyXor != 14 {
		t.Fatalf("collision cell = %+v", diff.Cells()[0])
	}

	result := mustPeel(t, diff, 10)
	if result.Status != PeelStatusPeeled {
		t.Fatalf("status = %s, want peeled", result.Status)
	}
	if len(result.Keys) != 1 || result.Keys[0].Key != 14 || result.Keys[0].Direction != DirectionPositive {
		t.Fatalf("keys = %+v, want colliding key 14", result.Keys)
	}

	verification, err := result.Verify([]uint64{10, 20, 30}, []uint64{7, 9})
	if err != nil {
		t.Fatal(err)
	}
	if verification.IsVerified() {
		t.Fatal("check collision must not verify against complete snapshots")
	}
	if got, want := verification.UnexpectedPositive, []uint64{14}; !stringSlicesEqualUint64(got, want) {
		t.Fatalf("unexpected positive = %v, want %v", got, want)
	}
}

func TestFakePureDigestIsNotSetEquality(t *testing.T) {
	// Both sets have two IDs, their key XORs cancel, and all checks are zero.
	// The complete digest is all zero although A and B differ.
	cfg := mustConfig(t, 1, []uint64{3}, "fake-pure", mappedHash(map[uint64][]int{
		0: {0}, 1: {0}, 2: {0}, 3: {0},
	}, map[uint64]uint64{
		0: 0, 1: 0, 2: 0, 3: 0,
	}))
	a := mustBuild(t, cfg, []uint64{1, 2})
	b := mustBuild(t, cfg, []uint64{0, 3})
	diff := mustDiff(t, a, b)

	if !diff.allZero() {
		t.Fatalf("test setup digest is not all zero: %+v", diff.Cells())
	}
	result := mustPeel(t, diff, 10)
	if result.Status != PeelStatusPeeled {
		t.Fatalf("status = %s, want peeled", result.Status)
	}
	if len(result.Keys) != 0 || len(result.Residual) != 0 {
		t.Fatalf("fake-pure result keys=%+v residual=%+v", result.Keys, result.Residual)
	}

	verification, err := result.Verify([]uint64{1, 2}, []uint64{0, 3})
	if err != nil {
		t.Fatal(err)
	}
	if verification.IsVerified() {
		t.Fatal("all-zero digest was incorrectly treated as unconditional set equality")
	}
	if got, want := verification.ExpectedPositive, []uint64{1, 2}; !stringSlicesEqualUint64(got, want) {
		t.Fatalf("expected positive = %v, want %v", got, want)
	}
	if got, want := verification.ExpectedNegative, []uint64{0, 3}; !stringSlicesEqualUint64(got, want) {
		t.Fatalf("expected negative = %v, want %v", got, want)
	}
}

func stringSlicesEqualUint64(a, b []uint64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestPeelPauseAtEveryPointAndResume(t *testing.T) {
	cfg := mustConfig(t, 8, []uint64{10, 20}, "pause", mappedHash(map[uint64][]int{
		1: {0, 1},
		2: {2, 3},
		3: {4, 5},
		4: {6, 7},
	}, nil))
	a := mustBuild(t, cfg, []uint64{1, 2, 3})
	b := mustBuild(t, cfg, []uint64{3, 4})
	diff := mustDiff(t, a, b)
	before := diff.Fingerprint()

	for cut := 1; cut < 3; cut++ {
		t.Run("pause-at-"+big.NewInt(int64(cut)).String(), func(t *testing.T) {
			result := mustPeel(t, diff, cut)
			if result.Status != PeelStatusPaused {
				t.Fatalf("cut %d status = %s, want paused", cut, result.Status)
			}
			if result.State == nil {
				t.Fatal("paused result has no state")
			}
			if result.Steps != cut || len(result.Keys) != cut || result.StepsThisRun != cut {
				t.Fatalf("paused at cut %d: steps=%d keys=%d run=%d",
					cut, result.Steps, len(result.Keys), result.StepsThisRun)
			}
			if len(result.NewKeys) != cut {
				t.Fatalf("paused at cut %d: NewKeys=%+v", cut, result.NewKeys)
			}
			if result.State.ConfigFingerprint() != diff.ConfigFingerprint() ||
				result.State.DiffFingerprint() != result.DiffFingerprint {
				t.Fatal("paused state is not bound to the difference/config fingerprint")
			}
			assertUniqueKeys(t, result.Keys)

			previousLast := uint64(0)
			if cut > 0 {
				previousLast = result.Keys[cut-1].Key
			}
			for result.Status == PeelStatusPaused {
				next, err := ResumePeel(diff, result.State, 1)
				if err != nil {
					t.Fatalf("ResumePeel: %v", err)
				}
				if len(next.Keys) < len(result.Keys) || next.Steps < result.Steps {
					t.Fatalf("resume lost cumulative output: before=%+v after=%+v", result.Keys, next.Keys)
				}
				assertUniqueKeys(t, next.Keys)
				if next.Steps != len(next.Keys) {
					t.Fatalf("steps=%d keys=%d", next.Steps, len(next.Keys))
				}
				if len(next.NewKeys) != next.StepsThisRun {
					t.Fatalf("run steps=%d NewKeys=%d", next.StepsThisRun, len(next.NewKeys))
				}
				if len(next.Keys) > len(result.Keys) && next.Keys[len(result.Keys)].Key == previousLast {
					t.Fatalf("resume repeated key %d", previousLast)
				}
				for i := range result.Keys {
					if next.Keys[i] != result.Keys[i] {
						t.Fatalf("resume changed previously emitted key %d: %+v vs %+v",
							i, result.Keys[i], next.Keys[i])
					}
				}
				previousLast = next.Keys[len(next.Keys)-1].Key
				result = next
			}

			if result.Status != PeelStatusPeeled {
				t.Fatalf("final status = %s, want peeled; residual=%+v", result.Status, result.Residual)
			}
			if result.Steps != 3 || len(result.Keys) != 3 {
				t.Fatalf("final steps=%d keys=%d, want 3/3", result.Steps, len(result.Keys))
			}
			verification, err := result.Verify([]uint64{1, 2, 3}, []uint64{3, 4})
			if err != nil {
				t.Fatal(err)
			}
			if !verification.IsVerified() {
				t.Fatalf("verification = %+v", verification)
			}
		})
	}

	exact := mustPeel(t, diff, 3)
	if exact.Status != PeelStatusPeeled || exact.State != nil {
		t.Fatalf("exact-budget result = %+v, want terminal peeled with no state", exact)
	}
	if diff.Fingerprint() != before {
		t.Fatal("peeling mutated the original difference table")
	}

	if _, err := Peel(diff, 0); !errors.Is(err, ErrInvalidBudget) {
		t.Fatalf("Peel zero budget error = %v, want ErrInvalidBudget", err)
	}
	if _, err := Peel(diff, -1); !errors.Is(err, ErrInvalidBudget) {
		t.Fatalf("Peel negative budget error = %v, want ErrInvalidBudget", err)
	}
	if _, err := ResumePeel(diff, exact.State, 0); !errors.Is(err, ErrInvalidBudget) {
		t.Fatalf("ResumePeel zero budget error = %v, want ErrInvalidBudget", err)
	}
}

func TestResumeRejectsWrongBoundState(t *testing.T) {
	cfg := mustConfig(t, 8, []uint64{10, 20}, "resume-binding", mappedHash(map[uint64][]int{
		1: {0, 1},
		2: {2, 3},
		3: {4, 5},
		4: {6, 7},
		9: {0, 1},
	}, nil))
	diff := mustDiff(t, mustBuild(t, cfg, []uint64{1, 2, 3}), mustBuild(t, cfg, []uint64{3, 4}))
	paused := mustPeel(t, diff, 1)
	if paused.Status != PeelStatusPaused {
		t.Fatalf("setup status = %s, want paused", paused.Status)
	}

	t.Run("wrong difference table", func(t *testing.T) {
		other := mustDiff(t, mustBuild(t, cfg, []uint64{9}), mustBuild(t, cfg, nil))
		if _, err := ResumePeel(other, paused.State, 10); !errors.Is(err, ErrResumeMismatch) {
			t.Fatalf("ResumePeel error = %v, want ErrResumeMismatch", err)
		}
	})

	t.Run("wrong configuration", func(t *testing.T) {
		otherCfg := mustConfig(t, 9, []uint64{10, 20}, "other-scheme", mappedHash(map[uint64][]int{
			1: {0, 1},
		}, nil))
		other := mustDiff(t, mustBuild(t, otherCfg, []uint64{1}), mustBuild(t, otherCfg, nil))
		if _, err := ResumePeel(other, paused.State, 10); !errors.Is(err, ErrResumeMismatch) {
			t.Fatalf("ResumePeel error = %v, want ErrResumeMismatch", err)
		}
	})

	t.Run("tampered state checksum", func(t *testing.T) {
		tampered := paused.State.clone()
		tampered.cells[1].cell.keyXor ^= 0xfeed
		if _, err := ResumePeel(diff, tampered, 10); !errors.Is(err, ErrResumeMismatch) {
			t.Fatalf("ResumePeel error = %v, want ErrResumeMismatch", err)
		}
	})

	t.Run("repeated resume does not mutate paused state", func(t *testing.T) {
		first, err := ResumePeel(diff, paused.State, 10)
		if err != nil {
			t.Fatal(err)
		}
		second, err := ResumePeel(diff, paused.State, 10)
		if err != nil {
			t.Fatal(err)
		}
		if !peeledKeysEqual(first.Keys, second.Keys) {
			t.Fatalf("resume from the same paused state differed: %+v vs %+v", first.Keys, second.Keys)
		}
	})
}

func TestContradictionLeavesResidualAndDoesNotLoop(t *testing.T) {
	cfg := mustConfig(t, 3, []uint64{1, 2}, "conflict", mappedHash(
		map[uint64][]int{0: {0, 1}},
		map[uint64]uint64{0: 0},
	))
	diff, err := NewTable(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// Synthetic digest: one zero-key unit at cell 0, and two zero-key units
	// at cell 1. After key 0 is eliminated, cell 1 exposes key 0 again.
	diff.cells[0] = tableCell{count: big.NewInt(1), keyXor: 0, checkXor: 0}
	diff.cells[1] = tableCell{count: big.NewInt(2), keyXor: 0, checkXor: 0}

	result := mustPeel(t, diff, 100)
	if result.Status != PeelStatusContradiction {
		t.Fatalf("status = %s, want contradiction; residual=%+v", result.Status, result.Residual)
	}
	if result.Steps != 1 || len(result.Keys) != 1 || result.Keys[0].Key != 0 {
		t.Fatalf("steps=%d keys=%+v", result.Steps, result.Keys)
	}
	if len(result.NewKeys) != 1 || result.NewKeys[0] != result.Keys[0] {
		t.Fatalf("NewKeys=%+v, Keys=%+v", result.NewKeys, result.Keys)
	}
	if result.Conflict == nil {
		t.Fatal("contradiction has no conflict details")
	}
	if result.Conflict.Key != 0 || result.Conflict.Direction != DirectionPositive ||
		result.Conflict.PreviousDirection != DirectionPositive || result.Conflict.PreviousStep != 1 {
		t.Fatalf("conflict = %+v", result.Conflict)
	}
	if len(result.Residual) == 0 || result.Residual[0].CountString() != "1" {
		t.Fatalf("residual = %+v, want preserved cell with count 1", result.Residual)
	}
}

func TestVerificationRejectsDuplicateSnapshots(t *testing.T) {
	cfg := mustConfig(t, 1, []uint64{1}, "verify-dup", mappedHash(map[uint64][]int{1: {0}}, nil))
	result := mustPeel(t, mustDiff(t, mustBuild(t, cfg, []uint64{1}), mustBuild(t, cfg, nil)), 10)
	if _, err := VerifySets(result, []uint64{1, 1}, nil); !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("VerifySets error = %v, want ErrDuplicateID", err)
	}
}
