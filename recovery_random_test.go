package dataeng

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

type randomOp struct {
	kind      byte // 'e' event, 'w' watermark, 'i' idle
	partition string
	source    string
	key       string
	ts        int64
}

func makeRandomOps(seed int64, n int) []randomOp {
	rng := rand.New(rand.NewSource(seed))
	partitions := []string{"p0", "p1"}
	sources := []string{"s0", "s1", "s2"}
	keys := []string{"k0", "k1", "k2"}
	ops := make([]randomOp, 0, n)
	for i := 0; i < n; i++ {
		op := randomOp{
			partition: partitions[rng.Intn(len(partitions))],
			source:    sources[rng.Intn(len(sources))],
			key:       keys[rng.Intn(len(keys))],
			ts:        rng.Int63n(220),
		}
		switch r := rng.Intn(10); {
		case r < 6:
			op.kind = 'e'
			if rng.Intn(4) == 0 {
				op.ts -= rng.Int63n(40) // create late records
				if op.ts < 0 {
					op.ts = 0
				}
			}
		case r < 9:
			op.kind = 'w'
		default:
			op.kind = 'i'
			op.ts = 0
		}
		ops = append(ops, op)
	}
	return ops
}

func applyRandomOp(t *testing.T, op *Operator, r randomOp) ([]WindowResult, []SideOutput) {
	t.Helper()
	switch r.kind {
	case 'e':
		return processEvent(t, op, Event{
			Partition: r.partition,
			Source:    r.source,
			Key:       r.key,
			Timestamp: r.ts,
			Value:     fmt.Sprintf("%s/%d", r.key, r.ts),
		})
	case 'w':
		return advance(t, op, r.partition, r.source, r.ts), nil
	case 'i':
		results, err := op.MarkIdle(r.partition, r.source)
		if err != nil {
			t.Fatal(err)
		}
		return results, nil
	default:
		t.Fatalf("bad op kind %q", r.kind)
		return nil, nil
	}
}

func applyRandomRange(t *testing.T, op *Operator, ops []randomOp) ([]string, []string) {
	t.Helper()
	var results, sides []string
	for _, r := range ops {
		rs, ss := applyRandomOp(t, op, r)
		results = append(results, summarizeResults(rs)...)
		sides = append(sides, summarizeSides(ss)...)
	}
	return results, sides
}

func TestRandomizedSnapshotRecovery(t *testing.T) {
	specs := []struct {
		name string
		cfg  Config
	}{
		{"tumbling", Config{Window: Tumbling(10), AllowedLateness: 5}},
		{"sliding", Config{Window: Sliding(10, 5), AllowedLateness: 5}},
		{"session", Config{Window: Session(5), AllowedLateness: 10}},
	}
	for _, tc := range specs {
		t.Run(tc.name, func(t *testing.T) {
			cfg := tc.cfg
			cfg.Aggregate = func(_ WindowContext, events []Event) any { return len(events) }

			all := makeRandomOps(42, 360)
			baseline, err := NewOperator(cfg)
			if err != nil {
				t.Fatal(err)
			}
			want, wantSides := applyRandomRange(t, baseline, all)

			op, _ := NewOperator(cfg)
			var got, gotSides []string
			checkpoints := []int{90, 180, 270, len(all)}
			start := 0
			for _, end := range checkpoints {
				r, s := applyRandomRange(t, op, all[start:end])
				got = append(got, r...)
				gotSides = append(gotSides, s...)
				if end == len(all) {
					break
				}
				snap, err := op.Snapshot()
				if err != nil {
					t.Fatalf("snapshot at %d: %v", end, err)
				}
				next, _ := NewOperator(cfg)
				if err := next.Restore(snap); err != nil {
					t.Fatalf("restore at %d: %v", end, err)
				}
				op = next
				start = end
			}

			if !reflect.DeepEqual(got, want) {
				for i := range got {
					if i >= len(want) || got[i] != want[i] {
						t.Fatalf("result mismatch at index %d:\n got: %s\nwant: %s", i, got[i], valueAt(want, i))
					}
				}
				t.Fatalf("result length mismatch: got %d want %d", len(got), len(want))
			}
			if !reflect.DeepEqual(gotSides, wantSides) {
				t.Fatalf("side output mismatch:\n got: %v\nwant: %v", gotSides, wantSides)
			}
		})
	}
}

func valueAt(values []string, i int) string {
	if i < 0 || i >= len(values) {
		return "<missing>"
	}
	return values[i]
}
