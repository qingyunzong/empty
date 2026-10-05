package diag

import "testing"

func TestRandomHistoriesMatchDeepCopyModel(t *testing.T) {
	seeds := []int64{1, 2, 3, 42, 1337, 20261005}
	for _, seed := range seeds {
		st, err := Run(Config{
			Seed:        seed,
			Ops:         3000,
			NumPages:    24,
			PageSize:    64,
			MaxBranches: 12,
		})
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		if st.Forks == 0 || st.Deletes == 0 || st.Writes == 0 {
			t.Fatalf("seed %d: degenerate history: %+v", seed, st)
		}
		t.Logf("seed %d: %+v", seed, st)
	}
}

func TestSmallAddressSpaceHeavySharing(t *testing.T) {
	// Few pages and many branches maximize page sharing and refcount churn.
	st, err := Run(Config{Seed: 7, Ops: 5000, NumPages: 4, PageSize: 16, MaxBranches: 24})
	if err != nil {
		t.Fatal(err)
	}
	if st.PeakBranches < 2 {
		t.Fatalf("want concurrent branches, got %+v", st)
	}
}
