package dataeng

import (
	"encoding/json"
	"errors"
	"math"
	"math/rand"
	"testing"
)

func TestPriorityStableAndWeightSensitive(t *testing.T) {
	a, err := Priority("record-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Priority("record-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	if math.Float64bits(a) != math.Float64bits(b) {
		t.Fatalf("priority is not stable: %v != %v", a, b)
	}
	if a <= 0 || a >= 1 {
		t.Fatalf("priority %v is outside (0, 1)", a)
	}

	heavy, err := Priority("record-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if heavy <= a {
		t.Fatalf("heavier record should have a larger priority: %v <= %v", heavy, a)
	}
}

func TestRejectsInvalidWeights(t *testing.T) {
	r := New(3)
	for _, weight := range []float64{0, -1, math.NaN()} {
		err := r.Add("x", weight)
		if !errors.Is(err, ErrInvalidWeight) {
			t.Fatalf("weight %v: expected ErrInvalidWeight, got %v", weight, err)
		}
	}
	if r.Len() != 0 {
		t.Fatalf("invalid records changed the reservoir: %v", r.TopK())
	}
}

func TestReplayIsIdempotent(t *testing.T) {
	r := New(3)
	for i := 0; i < 100; i++ {
		if err := r.Add("same", 2.5); err != nil {
			t.Fatal(err)
		}
	}
	if r.Len() != 1 {
		t.Fatalf("expected one retained record, got %d", r.Len())
	}

	if err := r.Add("same", 3.5); !errors.Is(err, ErrConflictingWeight) {
		t.Fatalf("expected ErrConflictingWeight, got %v", err)
	}
	if got := r.TopK()[0].Weight; got != 2.5 {
		t.Fatalf("conflicting replay changed the weight: %v", got)
	}
}

func TestTieBreakByAscendingID(t *testing.T) {
	records := []Record{
		{ID: "d", Weight: math.Inf(1)},
		{ID: "b", Weight: math.Inf(1)},
		{ID: "a", Weight: math.Inf(1)},
		{ID: "c", Weight: math.Inf(1)},
	}
	got, err := Select(3, records)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("got %d records, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i].ID != want[i] {
			t.Fatalf("position %d: got %q, want %q", i, got[i].ID, want[i])
		}
	}

	if !BetterRecord(Record{ID: "a", Priority: 1}, Record{ID: "b", Priority: 1}) {
		t.Fatal("equal priorities must prefer the smaller id")
	}
}

func TestMergeEqualsCentralizedSample(t *testing.T) {
	const (
		k        = 17
		shards   = 7
		numItems = 500
	)
	rng := rand.New(rand.NewSource(42))
	all := make([]Record, 0, numItems)
	for i := 0; i < numItems; i++ {
		all = append(all, Record{
			ID:     "id-" + string(rune('A'+i%26)) + "-" + itoa(i),
			Weight: 0.01 + rng.Float64()*10,
			Value:  i,
		})
	}

	partitioned := make([][]Record, shards)
	for _, rec := range all {
		n := int(StableHash(rec.ID) % shards)
		partitioned[n] = append(partitioned[n], rec)
	}
	// Replay some records and shuffle each shard to prove order independence.
	for i := range partitioned {
		rng.Shuffle(len(partitioned[i]), func(a, b int) {
			partitioned[i][a], partitioned[i][b] = partitioned[i][b], partitioned[i][a]
		})
		if len(partitioned[i]) > 0 {
			partitioned[i] = append(partitioned[i], partitioned[i][0])
		}
	}

	central, err := Select(k, all)
	if err != nil {
		t.Fatal(err)
	}
	sharded, err := SampleShards(k, partitioned)
	if err != nil {
		t.Fatal(err)
	}
	assertSameRecords(t, sharded, central)

	// Merging explicit reservoirs must agree as well.
	reservoirs := make([]*Reservoir, 0, len(partitioned))
	for _, shard := range partitioned {
		r := New(k)
		if err := r.AddAll(shard); err != nil {
			t.Fatal(err)
		}
		reservoirs = append(reservoirs, r)
	}
	merged, err := Merge(reservoirs...)
	if err != nil {
		t.Fatal(err)
	}
	assertSameRecords(t, merged.TopK(), central)
}

func TestMergeRequiresCompatibleCapacity(t *testing.T) {
	a := New(3)
	b := New(4)
	if err := a.Add("a", 1); err != nil {
		t.Fatal(err)
	}
	if err := b.Add("b", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := Merge(a, b); !errors.Is(err, ErrIncompatibleK) {
		t.Fatalf("expected ErrIncompatibleK, got %v", err)
	}
	if _, err := MergeK(5, a); !errors.Is(err, ErrInsufficientShardK) {
		t.Fatalf("expected ErrInsufficientShardK, got %v", err)
	}
}

func TestStateRoundTrip(t *testing.T) {
	r := New(4)
	records := []Record{
		{ID: "a", Weight: 1, Value: map[string]any{"n": 1}},
		{ID: "b", Weight: 2.5, Value: "two"},
		{ID: "c", Weight: 0.5, Value: []int{3}},
		{ID: "d", Weight: 7, Value: nil},
		{ID: "e", Weight: 3, Value: true},
	}
	if err := r.AddAll(records); err != nil {
		t.Fatal(err)
	}

	data, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var restored Reservoir
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatal(err)
	}
	assertSameRecords(t, restored.TopK(), r.TopK())

	binary, err := r.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	var fromBinary Reservoir
	if err := fromBinary.UnmarshalBinary(binary); err != nil {
		t.Fatal(err)
	}
	assertSameRecords(t, fromBinary.TopK(), r.TopK())
}

func TestNewChecked(t *testing.T) {
	if _, err := NewChecked(0); !errors.Is(err, ErrInvalidK) {
		t.Fatalf("expected ErrInvalidK, got %v", err)
	}
	if err := New(0).Add("a", 1); !errors.Is(err, ErrInvalidK) {
		t.Fatalf("expected ErrInvalidK, got %v", err)
	}
}

func assertSameRecords(t *testing.T, got, want []Record) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("record count: got %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i].ID != want[i].ID {
			t.Fatalf("position %d: id %q != %q", i, got[i].ID, want[i].ID)
		}
		if math.Float64bits(got[i].Priority) != math.Float64bits(want[i].Priority) {
			t.Fatalf("position %d: priority %v != %v", i, got[i].Priority, want[i].Priority)
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
