package offsetcoord_test

import (
	"context"
	"testing"

	"example.org/dlks/formal/q10052/offsetcoord"
)

// naivePosition is the plain map-backed reference implementation. It mirrors
// the production rules without any of the concurrency machinery, giving an
// independent oracle to recompute every partition's committed value and
// generation after each event in an exhaustive sequence.
type naivePosition struct {
	generation offsetcoord.Generation
	offset     offsetcoord.Offset
}

type naiveTable struct {
	positions map[offsetcoord.Partition]naivePosition
}

func newNaiveTable() *naiveTable {
	return &naiveTable{positions: make(map[offsetcoord.Partition]naivePosition)}
}

func (t *naiveTable) clone() *naiveTable {
	duplicate := make(map[offsetcoord.Partition]naivePosition, len(t.positions))
	for partition, position := range t.positions {
		duplicate[partition] = position
	}
	return &naiveTable{positions: duplicate}
}

func (t *naiveTable) commit(partition offsetcoord.Partition, generation offsetcoord.Generation, offset offsetcoord.Offset) (offsetcoord.CommitStatus, naivePosition) {
	current, seen := t.positions[partition]
	if seen && generation != current.generation {
		return offsetcoord.CommitStaleGeneration, current
	}
	if seen && offset < current.offset {
		return offsetcoord.CommitRegressed, current
	}
	next := naivePosition{generation: generation, offset: offset}
	t.positions[partition] = next
	return offsetcoord.CommitAccepted, next
}

func (t *naiveTable) reset(partition offsetcoord.Partition, offset offsetcoord.Offset) naivePosition {
	next := naivePosition{generation: t.positions[partition].generation + 1, offset: offset}
	t.positions[partition] = next
	return next
}

func (t *naiveTable) get(partition offsetcoord.Partition) (naivePosition, bool) {
	position, ok := t.positions[partition]
	return position, ok
}

// exhaustiveOp is one event in the enumerated event alphabet.
type exhaustiveOp struct {
	name       string
	commit     bool
	partition  offsetcoord.Partition
	generation offsetcoord.Generation
	offset     offsetcoord.Offset
	timestamp  offsetcoord.TimestampMs
}

// exhaustiveResolver maps timestamps to offsets deterministically. Smaller
// timestamps can resolve past the current offset and larger ones ahead of it,
// exercising both rollback-looking and forward resets behind the generation
// fence.
type exhaustiveResolver struct{}

func (exhaustiveResolver) ResolveOffset(_ context.Context, partition offsetcoord.Partition, timestamp offsetcoord.TimestampMs) (offsetcoord.Offset, error) {
	return offsetcoord.Offset(int64(partition[1])*100 + int64(timestamp)), nil
}

// TestExhaustiveEventSequences enumerates every sequence of operations up to
// maxDepth over a fixed alphabet and, after every prefix, replays the same
// prefix against both the production coordinator and the naive table. Any
// divergence in commit decision, committed offset, generation, visibility or
// monotonicity fails the test with the exact event prefix that produced it.
func TestExhaustiveEventSequences(t *testing.T) {
	const maxDepth = 5

	partitions := []offsetcoord.Partition{"p0", "p1"}
	// Generations deliberately cover 0..3 while real resets only reach 1..5 at
	// depth five, so future and stale generation receipts are both exercised.
	alphabet := make([]exhaustiveOp, 0, 8)
	for _, partition := range partitions {
		for _, generation := range []offsetcoord.Generation{0, 1, 2, 3} {
			alphabet = append(alphabet, exhaustiveOp{
				name:       "commit",
				commit:     true,
				partition:  partition,
				generation: generation,
				offset:     offsetcoord.Offset(5 + generation),
			})
		}
	}
	for _, partition := range partitions {
		for _, timestamp := range []offsetcoord.TimestampMs{0, 7} {
			alphabet = append(alphabet, exhaustiveOp{
				name:      "reset",
				commit:    false,
				partition: partition,
				timestamp: timestamp,
			})
		}
	}

	resolver := exhaustiveResolver{}
	sequences := 0

	var enumerate func(depth int, prefix []exhaustiveOp)
	enumerate = func(depth int, prefix []exhaustiveOp) {
		for _, op := range alphabet {
			nextPrefix := make([]exhaustiveOp, 0, len(prefix)+1)
			nextPrefix = append(nextPrefix, prefix...)
			nextPrefix = append(nextPrefix, op)

			replayAndCompare(t, nextPrefix, resolver)
			sequences++

			if depth > 1 {
				enumerate(depth-1, nextPrefix)
			}
		}
	}

	enumerate(maxDepth, nil)
	t.Logf("exhausted %d event sequences (depth <= %d)", sequences, maxDepth)
}

// replayAndCompare rebuilds both implementations from scratch by replaying the
// given prefix, asserting agreement after every single event.
func replayAndCompare(t *testing.T, prefix []exhaustiveOp, resolver offsetcoord.OffsetResolver) {
	t.Helper()

	coordinator := offsetcoord.New()
	naive := newNaiveTable()
	previous := make(map[offsetcoord.Partition]naivePosition)

	for index, op := range prefix {
		switch op.commit {
		case true:
			got := coordinator.Commit(op.partition, op.generation, op.offset)
			wantStatus, wantPosition := naive.commit(op.partition, op.generation, op.offset)

			if got.Status != wantStatus {
				t.Fatalf("prefix %v event %d: commit status = %s, want %s", prefix, index, got.Status, wantStatus)
			}
			if got.Status == offsetcoord.CommitAccepted {
				if got.Position.Offset != op.offset || got.Position.Generation != op.generation {
					t.Fatalf("prefix %v event %d: accepted result = %+v, want gen %d offset %d",
						prefix, index, got.Position, op.generation, op.offset)
				}
			} else if got.Position.Offset != wantPosition.offset || got.Position.Generation != wantPosition.generation {
				t.Fatalf("prefix %v event %d: rejected result = %+v, want %+v",
					prefix, index, got.Position, wantPosition)
			}
		case false:
			got, err := coordinator.Reset(context.Background(), op.partition, op.timestamp, resolver)
			if err != nil {
				t.Fatalf("prefix %v event %d: unexpected reset error: %v", prefix, index, err)
			}
			wantOffset, err := resolver.ResolveOffset(context.Background(), op.partition, op.timestamp)
			if err != nil {
				t.Fatalf("prefix %v event %d: resolver error: %v", prefix, index, err)
			}
			wantPosition := naive.reset(op.partition, wantOffset)
			if got.Generation != wantPosition.generation || got.Offset != wantPosition.offset {
				t.Fatalf("prefix %v event %d: reset result = %+v, want %+v",
					prefix, index, got, wantPosition)
			}
		}

		assertAgreesWithNaive(t, prefix, index, coordinator, naive)
		assertMonotonicAndNoRollback(t, prefix, index, coordinator, previous)

		snapshot := coordinator.Snapshot()
		for partition, position := range snapshot {
			previous[partition] = naivePosition{generation: position.Generation, offset: position.Offset}
		}
	}
}

func assertAgreesWithNaive(t *testing.T, prefix []exhaustiveOp, index int, coordinator *offsetcoord.Coordinator, naive *naiveTable) {
	t.Helper()

	snapshot := coordinator.Snapshot()
	if len(snapshot) != len(naive.positions) {
		t.Fatalf("prefix %v event %d: tracked partition count = %d, want %d",
			prefix, index, len(snapshot), len(naive.positions))
	}
	for partition, want := range naive.positions {
		got, ok := coordinator.PositionOf(partition)
		if !ok {
			t.Fatalf("prefix %v event %d: partition %s missing in coordinator", prefix, index, partition)
		}
		if got.Generation != want.generation || got.Offset != want.offset {
			t.Fatalf("prefix %v event %d: partition %s = (gen %d, offset %d), want (gen %d, offset %d)",
				prefix, index, partition, got.Generation, got.Offset, want.generation, want.offset)
		}
		if snapshot[partition] != got {
			t.Fatalf("prefix %v event %d: snapshot and PositionOf disagree for %s", prefix, index, partition)
		}
	}

	for partition := range snapshot {
		if _, ok := naive.positions[partition]; !ok {
			t.Fatalf("prefix %v event %d: coordinator tracks unexpected partition %s", prefix, index, partition)
		}
	}
}

// assertMonotonicAndNoRollback proves the key safety property: across a reset
// the visible (generation, offset) pair moves lexicographically forward even
// when the resolved offset is numerically smaller, and within a generation the
// offset never decreases. In-flight receipts from the old generation therefore
// cannot cause a rollback when resets and commits interleave.
func assertMonotonicAndNoRollback(t *testing.T, prefix []exhaustiveOp, index int, coordinator *offsetcoord.Coordinator, previous map[offsetcoord.Partition]naivePosition) {
	t.Helper()

	for partition, current := range coordinator.Snapshot() {
		old, ok := previous[partition]
		if !ok {
			continue
		}
		switch {
		case current.Generation < old.generation:
			t.Fatalf("prefix %v event %d: generation rolled back on %s: %d -> %d",
				prefix, index, partition, old.generation, current.Generation)
		case current.Generation == old.generation && current.Offset < old.offset:
			t.Fatalf("prefix %v event %d: offset rolled back within generation %d on %s: %d -> %d",
				prefix, index, old.generation, partition, old.offset, current.Offset)
		}
	}
}
