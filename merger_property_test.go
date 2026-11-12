package dataeng

import (
	"context"
	"errors"
	"math/rand"
	"testing"
)

// TestRandomizedMergeAgainstReference builds random multi-source,
// multi-page snapshots, including cross-source duplicates, and verifies that
// batched delivery equals the fully sorted and deduplicated reference.
func TestRandomizedMergeAgainstReference(t *testing.T) {
	ctx := context.Background()
	for seed := int64(0); seed < 40; seed++ {
		rng := rand.New(rand.NewSource(seed))

		sourceCount := 2 + rng.Intn(3)
		idPool := []string{}
		for i := 0; i < 30; i++ {
			idPool = append(idPool, "id-"+itoa(i))
		}

		groups := make([][]Record, sourceCount)
		recordByID := map[string]Record{}
		for source := 0; source < sourceCount; source++ {
			shuffled := append([]string(nil), idPool...)
			rng.Shuffle(len(shuffled), func(i, j int) {
				shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
			})
			chosen := shuffled[:5+rng.Intn(15)]
			records := make([]Record, 0, len(chosen))
			for _, id := range chosen {
				record, ok := recordByID[id]
				if !ok {
					time := int64(rng.Intn(1000) + 1)
					record = rec(time, id, "payload-"+id)
					recordByID[id] = record
				}
				records = append(records, record)
			}
			sortRecords(records)
			// Drop accidental in-source duplicate IDs.
			groups[source] = dedupInSource(records)
		}

		fakes := make([]*fakeSource, sourceCount)
		allGroups := make([][]Record, sourceCount)
		for i, group := range groups {
			pageSize := 1 + rng.Intn(4)
			fakes[i] = buildSource("src-"+itoa(i), group, pageSize)
			allGroups[i] = group
		}
		want := referenceMerge(allGroups...)

		tx := NewMemoryTransaction()
		batchSize := 1 + rng.Intn(5)
		merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), batchSize, tx)
		if err != nil {
			t.Fatalf("seed %d: NewMerger: %v", seed, err)
		}

		got := flatten(drainMerger(t, merger))
		assertRecordsEqual(t, got, want)
		assertStrictlyOrderedUnique(t, got)

		final := tx.Current()
		if final == nil || !final.Complete {
			t.Fatalf("seed %d: missing completion marker", seed)
		}
		if _, err := merger.Next(ctx); !errors.Is(err, ErrComplete) {
			t.Fatalf("seed %d: Next after complete = %v", seed, err)
		}
	}
}

func sortRecords(records []Record) {
	for i := 1; i < len(records); i++ {
		for j := i; j > 0 && records[j-1].Key().Compare(records[j].Key()) > 0; j-- {
			records[j-1], records[j] = records[j], records[j-1]
		}
	}
}

func dedupInSource(records []Record) []Record {
	out := records[:0]
	for _, record := range records {
		if len(out) > 0 && out[len(out)-1].ID == record.ID {
			continue
		}
		out = append(out, record)
	}
	return out
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		index--
		digits[index] = '-'
	}
	return string(digits[index:])
}
