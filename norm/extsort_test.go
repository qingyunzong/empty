package norm

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

// buildWideObject renders an object with n members whose keys are in
// random (non-sorted) order, including multi-byte UTF-8 keys.
func buildWideObject(rng *rand.Rand, n int) string {
	var sb strings.Builder
	sb.WriteString("{")
	perm := rng.Perm(n)
	for i, idx := range perm {
		if i > 0 {
			sb.WriteString(",")
		}
		fmt.Fprintf(&sb, "%q:%d", fmt.Sprintf("key-%s-%04d", []string{"a", "é", "中", "Z"}[idx%4], idx), idx)
	}
	sb.WriteString("}")
	return sb.String()
}

func TestLowBudgetMatchesFullMemory(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	src := buildWideObject(rng, 500)
	full := mustNormalize(t, src, 1<<30)
	for _, budget := range []int64{4096, 512, 128, 40} {
		got := mustNormalize(t, src, budget)
		if got != full {
			t.Fatalf("budget %d: output differs from full-memory normalization", budget)
		}
	}
}

func TestNestedObjectsLowBudget(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	// Nested objects: inner objects must also spill and sort correctly.
	var sb strings.Builder
	sb.WriteString("{")
	for i := 0; i < 30; i++ {
		if i > 0 {
			sb.WriteString(",")
		}
		fmt.Fprintf(&sb, `"outer%02d":`, 29-i)
		sb.WriteString(buildWideObject(rng, 20))
	}
	sb.WriteString("}")
	src := sb.String()
	full := mustNormalize(t, src, 1<<30)
	got := mustNormalize(t, src, 300)
	if got != full {
		t.Fatal("nested low-budget output differs")
	}
}

func TestDuplicateKeyAcrossSegments(t *testing.T) {
	// With a tiny budget every member lands in its own segment, so the
	// duplicate keys are guaranteed to live in different temp segments.
	var sb strings.Builder
	sb.WriteString(`{"first":1,`)
	for i := 0; i < 60; i++ {
		fmt.Fprintf(&sb, `"k%02d":%d,`, i, i)
	}
	sb.WriteString(`"first":2}`)
	_, err := normalizeToString(t, sb.String(), 32)
	if err == nil || !strings.Contains(err.Error(), `duplicate key "first"`) {
		t.Fatalf("want cross-segment duplicate key error, got %v", err)
	}
}

func TestManySegmentsMultiPassMerge(t *testing.T) {
	// Force more segments than maxMergeWay to exercise multi-pass merging.
	rng := rand.New(rand.NewSource(1234))
	src := buildWideObject(rng, 200)
	full := mustNormalize(t, src, 1<<30)
	got := mustNormalize(t, src, 24)
	if got != full {
		t.Fatal("multi-pass merge output differs from full-memory normalization")
	}
	// Keys must come out in UTF-8 byte order.
	if !strings.HasPrefix(got, `{"key-Z-`) {
		t.Errorf("unexpected key order in merged output prefix: %.40s", got)
	}
}

func TestHugeValueSpillsToTempFile(t *testing.T) {
	// A single member value larger than the budget must spill to a temp
	// file and still be emitted correctly.
	big := strings.Repeat("x", 10000)
	src := `{"b":"` + big + `","a":"` + big + `"}`
	full := mustNormalize(t, src, 1<<30)
	got := mustNormalize(t, src, 100)
	if got != full {
		t.Fatal("spilled value output differs")
	}
	if !strings.HasPrefix(got, `{"a":"xxxx`) {
		t.Errorf("unexpected output prefix: %.20s", got)
	}
}
