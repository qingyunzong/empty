package dataeng_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"testing"

	dataeng "example.org/dataeng/q0109"
)

func TestSummaryJSONRoundTripAndMerge(t *testing.T) {
	s := dataeng.NewSampler(2)
	mustAdd(t, s, item("a", 1, 9))
	mustAdd(t, s, item("b", 1<<63, 3))
	mustAdd(t, s, item("c", ^uint64(0), 1))
	original := s.Snapshot()

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	var decoded dataeng.Summary
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.K() != original.K() || decoded.Len() != original.Len() {
		t.Fatalf("decoded header K=%d Len=%d, want K=%d Len=%d",
			decoded.K(), decoded.Len(), original.K(), original.Len())
	}
	if !slices.Equal(decoded.Sample(), original.Sample()) {
		t.Fatalf("decoded sample %v != %v", decoded.Sample(), original.Sample())
	}

	// Round-tripped summaries merge exactly like in-memory snapshots.
	other := dataeng.NewSampler(2)
	mustAdd(t, other, item("d", 2, 4))
	otherData, err := json.Marshal(other.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	var otherDecoded dataeng.Summary
	if err := json.Unmarshal(otherData, &otherDecoded); err != nil {
		t.Fatal(err)
	}
	merged, err := dataeng.Merge(&decoded, &otherDecoded)
	if err != nil {
		t.Fatal(err)
	}

	full := dataeng.NewSampler(2)
	mustAdd(t, full, item("a", 1, 9))
	mustAdd(t, full, item("b", 1<<63, 3))
	mustAdd(t, full, item("c", ^uint64(0), 1))
	mustAdd(t, full, item("d", 2, 4))
	if !slices.Equal(merged.Sample(), full.Items()) {
		t.Fatalf("post-JSON merge %v != %v", merged.Sample(), full.Items())
	}
}

func TestSummaryJSONRejectsInvalidPayloads(t *testing.T) {
	cases := map[string]io.Reader{
		"malformed":   bytes.NewBufferString(`{`),
		"negative k":  bytes.NewBufferString(`{"k":-1,"items":[]}`),
		"zero weight": bytes.NewBufferString(`{"k":1,"items":[{"id":"x","weight":0,"priority":1}]}`),
		"id conflict": bytes.NewBufferString(`{"k":1,"items":[{"id":"x","weight":1,"priority":1},{"id":"x","weight":2,"priority":1}]}`),
	}
	for name, reader := range cases {
		var m dataeng.Summary
		err := json.NewDecoder(reader).Decode(&m)
		if err == nil {
			t.Fatalf("%s: want decode error", name)
		}
	}

	var neg dataeng.Summary
	if err := json.Unmarshal([]byte(`{"k":-1,"items":[]}`), &neg); !errors.Is(err, dataeng.ErrNegativeK) {
		t.Fatalf("negative K: want ErrNegativeK, got %v", err)
	}
	var zero dataeng.Summary
	if err := json.Unmarshal([]byte(`{"k":1,"items":[{"id":"x","weight":0,"priority":1}]}`), &zero); !errors.Is(err, dataeng.ErrZeroWeight) {
		t.Fatalf("zero weight: want ErrZeroWeight, got %v", err)
	}
	var conflict dataeng.Summary
	err := json.Unmarshal([]byte(`{"k":1,"items":[{"id":"x","weight":1,"priority":1},{"id":"x","weight":2,"priority":1}]}`), &conflict)
	var mergeErr *dataeng.MergeError
	if !errors.As(err, &mergeErr) {
		t.Fatalf("duplicate conflicting ID: want MergeError, got %v", err)
	}

	// Identical duplicate entries inside one payload are idempotent.
	var ok dataeng.Summary
	if err := json.Unmarshal([]byte(`{"k":1,"items":[{"id":"x","weight":1,"priority":1},{"id":"x","weight":1,"priority":1}]}`), &ok); err != nil {
		t.Fatalf("identical duplicate entry rejected: %v", err)
	}
	if ok.Len() != 1 {
		t.Fatalf("Len = %d, want 1", ok.Len())
	}
}
