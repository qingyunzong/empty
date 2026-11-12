package dataeng_test

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"slices"
	"testing"

	dataeng "example.org/dataeng/q0109"
)

// randomItems builds n items with unique IDs, deliberately exercising extreme
// uint64 weights and priorities so exact rational comparison cannot be
// replaced by floating point or 64-bit products.
func randomItems(rng *rand.Rand, n int) []dataeng.Item {
	seen := make(map[string]bool, n)
	items := make([]dataeng.Item, 0, n)
	for len(items) < n {
		id := randomID(rng)
		if seen[id] {
			continue
		}
		seen[id] = true
		items = append(items, dataeng.Item{
			ID:       id,
			Weight:   randomWeight(rng),
			Priority: rng.Uint64(),
		})
	}
	return items
}

func randomID(rng *rand.Rand) string {
	switch rng.IntN(4) {
	case 0:
		return fmt.Sprintf("id-%016x", rng.Uint64())
	case 1:
		// Short byte-order-sensitive IDs.
		return string(rune('a'+rng.IntN(26))) + string(rune('a'+rng.IntN(26)))
	case 2:
		return fmt.Sprintf("%d", rng.Uint64N(1000))
	default:
		b := make([]byte, 1+rng.IntN(8))
		for i := range b {
			b[i] = byte(rng.IntN(256))
		}
		return string(b)
	}
}

func randomWeight(rng *rand.Rand) uint64 {
	switch rng.IntN(5) {
	case 0:
		return 1
	case 1:
		return rng.Uint64N(1000) + 1
	case 2:
		return 1 << rng.IntN(64) // powers of two up to 2^63
	case 3:
		return ^uint64(0) // maximum weight
	default:
		return rng.Uint64N(^uint64(0)-1) + 1 // high-bit values, never zero
	}
}

func makeShards(t *testing.T, rng *rand.Rand, items []dataeng.Item, k int) []*dataeng.Sampler {
	shardCount := 1 + rng.IntN(5)
	shards := make([]*dataeng.Sampler, shardCount)
	for i := range shards {
		shards[i] = dataeng.NewSampler(k)
	}
	order := rng.Perm(len(items))
	for _, p := range order {
		target := rng.IntN(shardCount)
		mustAdd(t, shards[target], items[p])
	}
	return shards
}

func TestRandomShardingAndMergeOrder(t *testing.T) {
	rng := rand.New(rand.NewPCG(0x01092026, 0xCAFEBABE))
	for trial := 0; trial < 200; trial++ {
		n := 1 + rng.IntN(60)
		k := rng.IntN(n + 2) // covers K=0 and K>n
		items := randomItems(rng, n)

		ref := dataeng.NewSampler(k)
		for _, it := range items {
			mustAdd(t, ref, it)
		}
		want := ref.Items()
		if oracle := oracleTopK(items, k); !slices.Equal(want, oracle) {
			t.Fatalf("trial %d: sampler %v != oracle %v", trial, want, oracle)
		}

		shards := makeShards(t, rng, items, k)
		snaps := make([]*dataeng.Summary, len(shards))
		for i, sh := range shards {
			snaps[i] = sh.Snapshot()
		}

		merged, err := dataeng.Merge(snaps...)
		if err != nil {
			t.Fatalf("trial %d: merge: %v", trial, err)
		}
		if !slices.Equal(merged.Sample(), want) {
			t.Fatalf("trial %d: merged %v != full %v", trial, merged.Sample(), want)
		}

		// Balanced pairwise merge over a random permutation must be identical.
		perm := rng.Perm(len(snaps))
		pending := make([]*dataeng.Summary, len(snaps))
		for i, p := range perm {
			pending[i] = snaps[p]
		}
		for len(pending) > 1 {
			next := make([]*dataeng.Summary, 0, (len(pending)+1)/2)
			for i := 0; i < len(pending); i += 2 {
				if i+1 == len(pending) {
					next = append(next, pending[i])
					continue
				}
				m, err := dataeng.Merge(pending[i], pending[i+1])
				if err != nil {
					t.Fatalf("trial %d: pairwise merge: %v", trial, err)
				}
				next = append(next, m)
			}
			pending = next
		}
		if !slices.Equal(pending[0].Sample(), want) {
			t.Fatalf("trial %d: order-sensitive merge %v != %v", trial, pending[0].Sample(), want)
		}
	}
}

func TestRandomShardingConflicts(t *testing.T) {
	rng := rand.New(rand.NewPCG(0x51512026, 0xBEEF1234))
	for trial := 0; trial < 100; trial++ {
		n := 2 + rng.IntN(40)
		k := rng.IntN(n) // K < n so many IDs stay outside every sample
		items := randomItems(rng, n)

		victim := items[rng.IntN(n)]
		conflicting := victim
		switch rng.IntN(2) {
		case 0:
			conflicting.Weight = randomWeight(rng)
			if conflicting.Weight == victim.Weight {
				if conflicting.Weight == ^uint64(0) {
					conflicting.Weight--
				} else {
					conflicting.Weight++
				}
			}
		case 1:
			conflicting.Priority = rng.Uint64()
			if conflicting.Priority == victim.Priority {
				if conflicting.Priority == ^uint64(0) {
					conflicting.Priority--
				} else {
					conflicting.Priority++
				}
			}
		}

		shards := makeShards(t, rng, items, k)
		rogue := dataeng.NewSampler(k)
		mustAdd(t, rogue, conflicting)
		snaps := make([]*dataeng.Summary, 0, len(shards)+1)
		for _, sh := range shards {
			snaps = append(snaps, sh.Snapshot())
		}
		snaps = append(snaps, rogue.Snapshot())

		var wantIDs []string
		for round := 0; round < 3; round++ {
			order := rng.Perm(len(snaps))
			var merged *dataeng.Summary
			var err error
			for _, p := range order {
				merged, err = dataeng.Merge(merged, snaps[p])
				if err != nil {
					break
				}
			}
			var mergeErr *dataeng.MergeError
			if !errors.As(err, &mergeErr) {
				t.Fatalf("trial %d round %d: want MergeError, got %v", trial, round, err)
			}
			gotIDs := mergeErr.IDs()
			if round == 0 {
				wantIDs = gotIDs
				continue
			}
			if !slices.Equal(gotIDs, wantIDs) {
				t.Fatalf("trial %d: conflict IDs depend on merge order: %v vs %v", trial, gotIDs, wantIDs)
			}
		}
		if len(wantIDs) != 1 || wantIDs[0] != victim.ID {
			t.Fatalf("trial %d: conflict IDs = %v, want [%q]", trial, wantIDs, victim.ID)
		}
	}
}

func TestGiantWeightsDoNotOverflow(t *testing.T) {
	// Cross products here reach roughly 2^127, beyond 64-bit arithmetic.
	items := []dataeng.Item{
		item("max-max", ^uint64(0), ^uint64(0)), // ratio 1
		item("max-pri", 1, ^uint64(0)),          // largest ratio
		item("max-weight", ^uint64(0), 1),       // smallest positive ratio
		item("near", ^uint64(0)-1, ^uint64(0)-2),
		item("mid", 1<<32, 1<<33), // ratio 2
	}
	s := dataeng.NewSampler(len(items))
	for _, it := range items {
		mustAdd(t, s, it)
	}
	got := s.Items()
	want := oracleTopK(items, len(items))
	if !slices.Equal(got, want) {
		t.Fatalf("giant-weight order\ngot  %v\nwant %v", got, want)
	}
}
