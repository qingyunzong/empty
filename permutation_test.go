package dataeng

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// TestEventPermutationsNoLossNoDuplication exhaustively permutes a small set
// of cooperative-rebalance lifecycle events. Whatever the order, the final
// owner must consume every source offset, and the sink must apply every
// offset exactly once.
func TestEventPermutationsNoLossNoDuplication(t *testing.T) {
	const recordsPerPartition = 4
	events := []string{"assign0", "assign1", "revoke0", "lost0", "revoke1"}
	for i, order := range permutations(events) {
		order := order
		t.Run(fmt.Sprintf("%03d_%s", i, strings.Join(order, "_")), func(t *testing.T) {
			source := newTestSource(map[PartitionID][]Record{
				0: recordsFor(0, recordsPerPartition),
				1: recordsFor(1, recordsPerPartition),
			})
			sink := newRecordingSink()
			committer := newRecordingCommitter()
			c := mustNew(t, Config{
				Reader: source, Sink: sink, Committer: committer,
				BatchSize: 2, PollInterval: time.Millisecond,
			})

			generation := map[PartitionID]int64{0: 1, 1: 1}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			for _, event := range order {
				switch event {
				case "assign0":
					if err := c.Assign(ctx, Assignment{Partition: 0, Generation: generation[0], NextOffset: committer.offset(0)}); err != nil {
						t.Fatalf("%s: Assign: %v", event, err)
					}
				case "assign1":
					if err := c.Assign(ctx, Assignment{Partition: 1, Generation: generation[1], NextOffset: committer.offset(1)}); err != nil {
						t.Fatalf("%s: Assign: %v", event, err)
					}
				case "revoke0":
					if err := c.Revoke(ctx, 0); err != nil {
						t.Fatalf("%s: Revoke: %v", event, err)
					}
				case "revoke1":
					if err := c.Revoke(ctx, 1); err != nil {
						t.Fatalf("%s: Revoke: %v", event, err)
					}
				case "lost0":
					c.Lost(0)
				}
			}

			// Give both partitions a final owner, starting from Kafka's
			// committed offset, then let them drain.
			for _, partition := range []PartitionID{0, 1} {
				status, ok := c.Status(partition)
				if !ok || !status.Active {
					generation[partition]++
					if err := c.Assign(ctx, Assignment{
						Partition:  partition,
						Generation: generation[partition],
						NextOffset: committer.offset(partition),
					}); err != nil {
						t.Fatalf("final Assign partition %d: %v", partition, err)
					}
				}
			}
			waitWatermark(t, c, 0, recordsPerPartition)
			waitWatermark(t, c, 1, recordsPerPartition)

			sink.assertCoverage(t, 0, recordsPerPartition)
			sink.assertCoverage(t, 1, recordsPerPartition)
			if got := committer.offset(0); got != recordsPerPartition {
				t.Fatalf("partition 0 committed offset = %d, want %d", got, recordsPerPartition)
			}
			if got := committer.offset(1); got != recordsPerPartition {
				t.Fatalf("partition 1 committed offset = %d, want %d", got, recordsPerPartition)
			}
			closeCoordinator(t, c)
		})
	}
}

func permutations(values []string) [][]string {
	var out [][]string
	var walk func(prefix, rest []string)
	walk = func(prefix, rest []string) {
		if len(rest) == 0 {
			out = append(out, append([]string(nil), prefix...))
			return
		}
		for i := range rest {
			nextRest := make([]string, 0, len(rest)-1)
			nextRest = append(nextRest, rest[:i]...)
			nextRest = append(nextRest, rest[i+1:]...)
			walk(append(prefix, rest[i]), nextRest)
		}
	}
	walk(nil, values)
	return out
}
