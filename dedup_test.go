package dataeng

import (
	"fmt"
	"math"
	"sync"
	"testing"
)

func sample(labels Labels, ts int64, value float64) Sample {
	return Sample{Labels: labels, Timestamp: ts, Value: value}
}

func TestCanonicalLabelKey(t *testing.T) {
	a := Labels{"b": "2", "a": "1"}
	b := Labels{"a": "1", "b": "2"}
	if KeyForLabels(a) != KeyForLabels(b) {
		t.Fatal("label insertion order must not affect the canonical key")
	}
	if KeyForLabels(Labels{"a": "bc"}) == KeyForLabels(Labels{"ab": "c"}) {
		t.Fatal("length-prefixed keys must not collide")
	}

	canonical := CanonicalizeLabels(a)
	if len(canonical) != 2 || canonical[0].Name != "a" || canonical[1].Name != "b" {
		t.Fatalf("unexpected canonical labels: %#v", canonical)
	}
}

func TestExactDuplicateUsesValueBits(t *testing.T) {
	d := NewDeduplicator()
	first := sample(Labels{"__name__": "up"}, 100, 1.25)
	duplicate := sample(Labels{"__name__": "up"}, 100, math.Float64frombits(ValueBits(1.25)))

	result := d.Ingest([]Sample{first, duplicate})
	if len(result.Accepted) != 1 || len(result.Duplicates) != 1 {
		t.Fatalf("expected one accepted and one duplicate, got %#v", result)
	}
	if len(result.Conflicts) != 0 {
		t.Fatalf("exact duplicates must not be conflicts: %#v", result.Conflicts)
	}
}

func TestNaNPayloadsAreDistinct(t *testing.T) {
	d := NewDeduplicator()
	first := sample(Labels{"__name__": "n"}, 1, math.Float64frombits(0x7ff8000000000001))
	second := sample(Labels{"__name__": "n"}, 1, math.Float64frombits(0x7ff8000000000002))

	result := d.Ingest([]Sample{first, second})
	if len(result.Conflicts) != 1 {
		t.Fatalf("different NaN payloads must conflict, got %#v", result)
	}
	if result.Conflicts[0].ExistingBits != 0x7ff8000000000001 ||
		result.Conflicts[0].IncomingBits != 0x7ff8000000000002 {
		t.Fatalf("unexpected value bits: %#v", result.Conflicts[0])
	}
}

func TestSameTimestampConflictKeepsCommittedValue(t *testing.T) {
	d := NewDeduplicator()
	first := sample(Labels{"__name__": "jobs"}, 42, 10)
	conflict := sample(Labels{"__name__": "jobs"}, 42, 11)

	result := d.Ingest([]Sample{first, conflict})
	if len(result.Accepted) != 1 || len(result.Conflicts) != 1 {
		t.Fatalf("expected a conflict, got %#v", result)
	}
	if !d.HasSample(nil, first) {
		t.Fatal("the first committed value must remain visible")
	}
	if d.HasSample(nil, conflict) {
		t.Fatal("a conflicting value must not replace committed data")
	}
}

func TestStaleMarkerIsClassifiedAndDeduplicated(t *testing.T) {
	d := NewDeduplicator()
	stale := sample(Labels{"__name__": "gone"}, 7, StaleNaN)
	if !stale.Stale() || !IsStaleMarker(stale.Value) {
		t.Fatal("stale marker not recognized")
	}

	result := d.Ingest([]Sample{stale, stale})
	if len(result.Accepted) != 1 || len(result.Stale) != 1 {
		t.Fatalf("stale marker was not accepted separately: %#v", result)
	}
	if len(result.Duplicates) != 1 {
		t.Fatalf("duplicate stale marker was not deduplicated: %#v", result)
	}

	valueConflict := d.Ingest([]Sample{sample(Labels{"__name__": "gone"}, 7, 0)})
	if len(valueConflict.Conflicts) != 1 {
		t.Fatalf("stale marker and value at the same timestamp must conflict: %#v", valueConflict)
	}
}

func TestExemplarsUseTheirOwnIdentity(t *testing.T) {
	d := NewDeduplicator()
	series := Labels{"__name__": "request_duration_seconds"}
	exemplar := Exemplar{
		Labels:    Labels{"trace_id": "abc"},
		Timestamp: 100,
		Value:     0.25,
	}
	batch := Batch{
		Series: []TimeSeries{{
			Labels:    series,
			Samples:   []Sample{sample(series, 100, 0.5)},
			Exemplars: []Exemplar{exemplar, exemplar},
		}},
	}

	result := d.IngestBatch(batch)
	if len(result.Accepted) != 1 || len(result.Exemplars) != 1 || len(result.DuplicateExemplars) != 1 {
		t.Fatalf("unexpected exemplar result: %#v", result)
	}

	conflictBatch := Batch{
		Series: []TimeSeries{{
			Labels: series,
			Exemplars: []Exemplar{{
				Labels:    Exemplar{Labels: Labels{"trace_id": "abc"}}.Labels,
				Timestamp: 100,
				Value:     0.75,
			}},
		}},
	}
	conflict := d.IngestBatch(conflictBatch)
	if len(conflict.ExemplarConflicts) != 1 {
		t.Fatalf("different exemplar value bits must conflict: %#v", conflict)
	}
	if len(conflict.Conflicts) != 0 {
		t.Fatalf("exemplar conflicts must not be sample conflicts: %#v", conflict)
	}
}

func TestReplicasSharePartitionButReplicaLabelIsIgnored(t *testing.T) {
	d := NewDeduplicator()
	value := sample(Labels{
		"__name__":    "up",
		"__replica__": "a",
	}, 10, 1)

	first := d.IngestBatch(Batch{
		ExternalLabels: Labels{"cluster": "prod", "__replica__": "a"},
		Replica:        "a",
		Samples:        []Sample{value},
	})
	secondValue := sample(Labels{
		"__name__":    "up",
		"__replica__": "b",
	}, 10, 1)
	second := d.IngestBatch(Batch{
		ExternalLabels: Labels{"cluster": "prod", "__replica__": "b"},
		Replica:        "b",
		Samples:        []Sample{secondValue},
	})

	if len(first.Accepted) != 1 {
		t.Fatalf("first replica sample not accepted: %#v", first)
	}
	if len(second.Duplicates) != 1 || len(second.Accepted) != 0 {
		t.Fatalf("replica sample was not deduplicated: %#v", second)
	}
}

func TestConventionalReplicaLabelsAreGroupedByDefault(t *testing.T) {
	d := NewDeduplicator()
	labels := Labels{"__name__": "up", "replica": "a"}
	first := d.IngestBatch(Batch{
		ExternalLabels: Labels{"cluster": "prod", "replica": "a"},
		Samples:        []Sample{sample(labels, 10, 1)},
	})
	second := d.IngestBatch(Batch{
		ExternalLabels: Labels{"cluster": "prod", "replica": "b"},
		Samples: []Sample{sample(Labels{
			"__name__": "up",
			"replica":  "b",
		}, 10, 1)},
	})
	if len(first.Accepted) != 1 || len(second.Duplicates) != 1 {
		t.Fatalf("conventional replica labels were not deduplicated: %#v %#v", first, second)
	}
}

func TestLateOldLeaderCannotOverwriteNewLeader(t *testing.T) {
	d := NewDeduplicator()
	external := Labels{"cluster": "prod", "__replica__": "new"}
	labels := Labels{"__name__": "requests"}

	newLeader := d.IngestBatch(Batch{
		ExternalLabels: external,
		Replica:        "new",
		Generation:     2,
		Samples:        []Sample{sample(labels, 100, 20)},
	})
	if len(newLeader.Accepted) != 1 {
		t.Fatalf("new leader sample not accepted: %#v", newLeader)
	}

	lateOldLeader := d.IngestBatch(Batch{
		ExternalLabels: Labels{"cluster": "prod", "__replica__": "old"},
		Replica:        "old",
		Generation:     1,
		Samples:        []Sample{sample(labels, 100, 10)},
	})
	if len(lateOldLeader.Rejected) != 1 {
		t.Fatalf("late old-leader sample was not fenced: %#v", lateOldLeader)
	}
	if !d.HasSample(Labels{"cluster": "prod"}, sample(labels, 100, 20)) {
		t.Fatal("late old-leader sample overwrote the committed new-leader value")
	}
	if d.HasSample(Labels{"cluster": "prod"}, sample(labels, 100, 10)) {
		t.Fatal("late old-leader value became visible")
	}
}

func TestNewLeaderMayResolveOldConflict(t *testing.T) {
	d := NewDeduplicator()
	external := Labels{"cluster": "prod"}
	labels := Labels{"__name__": "requests"}

	old := d.IngestBatch(Batch{
		ExternalLabels: external,
		Generation:     1,
		Samples:        []Sample{sample(labels, 100, 10)},
	})
	if len(old.Accepted) != 1 {
		t.Fatalf("old leader sample not accepted: %#v", old)
	}

	newer := d.IngestBatch(Batch{
		ExternalLabels: external,
		Generation:     2,
		Samples:        []Sample{sample(labels, 100, 20)},
	})
	if len(newer.Accepted) != 1 || len(newer.ResolvedConflicts) != 1 {
		t.Fatalf("new generation did not resolve the conflict: %#v", newer)
	}
	if !d.HasSample(external, sample(labels, 100, 20)) {
		t.Fatal("new leader value is not visible")
	}
	if d.HasSample(external, sample(labels, 100, 10)) {
		t.Fatal("old leader value still visible after replacement")
	}
}

func TestZeroValueDeduplicatorIsUsable(t *testing.T) {
	var d Deduplicator
	s := sample(Labels{"__name__": "up"}, 1, 1)
	if decision := d.Add(s); decision.Status != StatusAccepted {
		t.Fatalf("zero value deduplicator failed: %#v", decision)
	}
	if decision := d.Add(s); decision.Status != StatusDuplicate {
		t.Fatalf("zero value deduplicator did not deduplicate: %#v", decision)
	}
}

func TestStrictGenerationFencesUnseenTimestamps(t *testing.T) {
	d := NewDeduplicator(Config{StrictGeneration: true})
	external := Labels{"cluster": "prod"}
	labels := Labels{"__name__": "requests"}

	d.IngestBatch(Batch{
		ExternalLabels: external,
		Generation:     2,
		Samples:        []Sample{sample(labels, 100, 1)},
	})
	result := d.IngestBatch(Batch{
		ExternalLabels: external,
		Generation:     1,
		Samples:        []Sample{sample(labels, 101, 1)},
	})
	if len(result.Rejected) != 1 {
		t.Fatalf("strict generation must reject old generation samples: %#v", result)
	}
}

func TestOldLeaderCanFillUncommittedTimestampByDefault(t *testing.T) {
	d := NewDeduplicator()
	external := Labels{"cluster": "prod"}
	labels := Labels{"__name__": "requests"}

	d.IngestBatch(Batch{
		ExternalLabels: external,
		Generation:     2,
		Samples:        []Sample{sample(labels, 100, 1)},
	})
	result := d.IngestBatch(Batch{
		ExternalLabels: external,
		Generation:     1,
		Samples:        []Sample{sample(labels, 101, 1)},
	})
	if len(result.Accepted) != 1 {
		t.Fatalf("old leader should fill an uncommitted timestamp by default: %#v", result)
	}

	behind := d.IngestBatch(Batch{
		ExternalLabels: external,
		Generation:     1,
		Samples:        []Sample{sample(labels, 99, 1)},
	})
	if len(behind.Rejected) != 1 {
		t.Fatalf("old leader must not fill a timestamp behind the new leader watermark: %#v", behind)
	}
}

func TestPartitionsAreIndependent(t *testing.T) {
	d := NewDeduplicator()
	labels := Labels{"__name__": "requests"}

	prod := d.IngestBatch(Batch{
		ExternalLabels: Labels{"cluster": "prod"},
		Generation:     2,
		Samples:        []Sample{sample(labels, 100, 1)},
	})
	stage := d.IngestBatch(Batch{
		ExternalLabels: Labels{"cluster": "stage"},
		Generation:     1,
		Samples:        []Sample{sample(labels, 100, 1)},
	})
	if len(prod.Accepted) != 1 || len(stage.Accepted) != 1 {
		t.Fatalf("partitions must not share generation state: %#v %#v", prod, stage)
	}
}

func TestAddWithGenerationUsesExternalPartition(t *testing.T) {
	d := NewDeduplicator()
	labels := Labels{"__name__": "requests"}
	external := Labels{"cluster": "prod", "__replica__": "a"}

	decision := d.AddWithGeneration(external, "a", 2, sample(labels, 1, 5))
	if decision.Status != StatusAccepted {
		t.Fatalf("sample not accepted: %#v", decision)
	}
	if d.Generation(external) != 2 {
		t.Fatalf("generation was not advanced: %d", d.Generation(external))
	}
	if d.Generation(Labels{"cluster": "stage"}) != 0 {
		t.Fatal("unrelated partition generation changed")
	}
}

func TestCustomReplicaLabelsAndGroupLabels(t *testing.T) {
	d := NewDeduplicator(
		WithReplicaLabel("replica"),
		WithGroupLabels("cluster"),
	)
	labels := Labels{"__name__": "requests"}
	for _, replica := range []string{"a", "b"} {
		result := d.IngestBatch(Batch{
			ExternalLabels: Labels{"cluster": "prod", "replica": replica, "region": replica},
			Samples:        []Sample{sample(labels, 10, 1)},
		})
		if replica == "a" && len(result.Accepted) != 1 {
			t.Fatalf("first sample not accepted: %#v", result)
		}
		if replica == "b" && len(result.Duplicates) != 1 {
			t.Fatalf("second replica was not deduplicated: %#v", result)
		}
	}
}

func TestPruneAndGenerationRetention(t *testing.T) {
	d := NewDeduplicator()
	external := Labels{"cluster": "prod"}
	labels := Labels{"__name__": "requests"}
	d.IngestBatch(Batch{
		ExternalLabels: external,
		Generation:     3,
		Samples: []Sample{
			sample(labels, 100, 1),
			sample(labels, 200, 2),
		},
	})
	d.PruneBefore(150)
	if d.HasSample(external, sample(labels, 100, 1)) {
		t.Fatal("old sample was not pruned")
	}
	if !d.HasSample(external, sample(labels, 200, 2)) {
		t.Fatal("retained sample was pruned")
	}
	if d.Generation(external) != 3 {
		t.Fatal("pruning must not reset leader fencing state")
	}
}

func TestConcurrentIngest(t *testing.T) {
	d := NewDeduplicator()
	labels := Labels{"__name__": "requests"}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			d.IngestBatch(Batch{
				ExternalLabels: Labels{"cluster": "prod", "__replica__": fmt.Sprint(i)},
				Samples:        []Sample{sample(labels, 10, 1)},
			})
		}()
	}
	wg.Wait()

	if !d.HasSample(Labels{"cluster": "prod"}, sample(labels, 10, 1)) {
		t.Fatal("sample missing after concurrent ingestion")
	}
}
