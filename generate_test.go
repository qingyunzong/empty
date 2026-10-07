package ticketlog

import (
	"math/rand"
	"testing"
)

func TestGenerateValidLogs(t *testing.T) {
	for seed := int64(0); seed < 100; seed++ {
		rng := rand.New(rand.NewSource(seed))
		events := Generate(rng, 5, 200)
		if err := Check(events); err != nil {
			t.Fatalf("seed %d: generated log invalid: %s\n%s", seed, err, err.Detail())
		}
	}
}

// Acceptance: corrupt a random valid log at exactly one place; the
// checker must catch it and report the expected error kind.
func TestCorruptionDetected(t *testing.T) {
	seen := map[string]int{}
	for seed := int64(0); seed < 500; seed++ {
		rng := rand.New(rand.NewSource(seed))
		events := Generate(rng, 5, 200)
		corrupted, wantKind := Corrupt(rng, events)
		if wantKind == "" {
			t.Fatalf("seed %d: no corruption strategy applied", seed)
		}
		// Single-point corruption: length changes by at most one.
		if d := len(corrupted) - len(events); d < -1 || d > 1 {
			t.Fatalf("seed %d: corruption changed length by %d", seed, d)
		}
		err := Check(corrupted)
		if err == nil {
			t.Fatalf("seed %d: corrupted log (%s) passed validation", seed, wantKind)
		}
		if err.Kind != wantKind {
			t.Fatalf("seed %d: corruption %q reported as %q\n%s", seed, wantKind, err.Kind, err.Detail())
		}
		if len(err.Chain) == 0 {
			t.Fatalf("seed %d: error %q has no causal chain", seed, wantKind)
		}
		seen[wantKind]++
	}
	// Every corruption family must be exercised across the seeds.
	for _, kind := range []string{
		"duplicate-release", "already-granted", "limit-exceeded",
		"release-ungranted", "cancel-after-grant",
	} {
		if seen[kind] == 0 {
			t.Fatalf("corruption kind %q never exercised", kind)
		}
	}
}
