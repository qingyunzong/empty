package dataeng

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

func TestUniqueConstraintTieBreak(t *testing.T) {
	records := []Record{
		{ID: "r2", Fields: map[string]any{"email": "a@x"}},
		{ID: "r1", Fields: map[string]any{"email": "a@x"}},
		{ID: "r3", Fields: map[string]any{"email": "b@x"}},
	}
	res, err := MinRemovalSet(records, []Constraint{Unique("email")})
	if err != nil {
		t.Fatal(err)
	}
	// Removing either r1 or r2 fixes the batch; the ascending ID list
	// ["r1"] is byte-wise smaller than ["r2"].
	if want := []string{"r1"}; !reflect.DeepEqual(res.RemovedIDs, want) {
		t.Fatalf("RemovedIDs = %v, want %v", res.RemovedIDs, want)
	}
	if want := []string{"r2", "r3"}; !reflect.DeepEqual(res.KeptIDs, want) {
		t.Fatalf("KeptIDs = %v, want %v", res.KeptIDs, want)
	}
	if len(res.Removals) != 1 || res.Removals[0].RecordID != "r1" {
		t.Fatalf("Removals = %+v", res.Removals)
	}
	ev := res.Removals[0].Conflicts
	if len(ev) != 1 {
		t.Fatalf("evidence count = %d, want 1", len(ev))
	}
	if ev[0].Key != `"a@x"` {
		t.Fatalf("evidence key = %q", ev[0].Key)
	}
	if want := []string{"r1", "r2"}; !reflect.DeepEqual(ev[0].RecordIDs, want) {
		t.Fatalf("evidence ids = %v, want %v", ev[0].RecordIDs, want)
	}
}

func TestFunctionalDependency(t *testing.T) {
	records := []Record{
		{ID: "a", Fields: map[string]any{"zip": "100", "city": "X"}},
		{ID: "b", Fields: map[string]any{"zip": "100", "city": "Y"}},
		{ID: "c", Fields: map[string]any{"zip": "200", "city": "X"}},
	}
	res, err := MinRemovalSet(records, []Constraint{Determines([]string{"zip"}, "city")})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"a"}; !reflect.DeepEqual(res.RemovedIDs, want) {
		t.Fatalf("RemovedIDs = %v, want %v", res.RemovedIDs, want)
	}
	ev := res.Removals[0].Conflicts
	if len(ev) != 1 || ev[0].Constraint.Kind != KindFunctionalDependency {
		t.Fatalf("evidence = %+v", ev)
	}
	if ev[0].Key != `["100"]` {
		t.Fatalf("evidence key = %q", ev[0].Key)
	}
}

func TestNullIsOrdinaryValue(t *testing.T) {
	records := []Record{
		{ID: "n1", Fields: map[string]any{"tag": nil}}, // explicit null
		{ID: "n2", Fields: map[string]any{}},           // missing field == null
		{ID: "n3", Fields: map[string]any{"tag": "v"}},
	}
	res, err := MinRemovalSet(records, []Constraint{Unique("tag")})
	if err != nil {
		t.Fatal(err)
	}
	// null == null, so n1 and n2 collide under the unique constraint.
	if want := []string{"n1"}; !reflect.DeepEqual(res.RemovedIDs, want) {
		t.Fatalf("RemovedIDs = %v, want %v", res.RemovedIDs, want)
	}
	if got := res.Removals[0].Conflicts[0].Key; got != "null" {
		t.Fatalf("evidence key = %q, want null", got)
	}
}

// TestGreedyIsNotOptimal builds a conflict graph where repeatedly removing
// the record involved in the most conflicts (a greedy maximum
// independent-set style heuristic) removes 4 records, while the optimum
// removes 3.
//
// Pairwise unique collisions: A-B, A-C, A-D, B-E, C-F, D-G.
// Greedy picks A (3 conflicts) and then needs one removal per remaining
// edge (B-E, C-F, D-G): 4 total. The optimum is {B, C, D}.
func TestGreedyIsNotOptimal(t *testing.T) {
	pairs := [][2]string{{"A", "B"}, {"A", "C"}, {"A", "D"}, {"B", "E"}, {"C", "F"}, {"D", "G"}}
	ids := []string{"A", "B", "C", "D", "E", "F", "G"}
	fields := make(map[string]map[string]any)
	for _, id := range ids {
		fields[id] = make(map[string]any)
	}
	for i, p := range pairs {
		f := fmt.Sprintf("f%d", i)
		// Every record not in the pair gets a distinct sentinel, because a
		// missing field would compare equal to every other null.
		for _, id := range ids {
			fields[id][f] = id
		}
		fields[p[0]][f] = "dup"
		fields[p[1]][f] = "dup"
	}
	var records []Record
	for _, id := range ids {
		records = append(records, Record{ID: id, Fields: fields[id]})
	}
	var constraints []Constraint
	for i := range pairs {
		constraints = append(constraints, Unique(fmt.Sprintf("f%d", i)))
	}
	res, err := MinRemovalSet(records, constraints)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"B", "C", "D"}; !reflect.DeepEqual(res.RemovedIDs, want) {
		t.Fatalf("RemovedIDs = %v, want optimal %v (greedy would remove 4)", res.RemovedIDs, want)
	}
}

func TestTieBreakByteWiseLexicographic(t *testing.T) {
	// Two disjoint collisions force exactly two removals, one per pair.
	// Byte-wise comparison puts 'Z' (0x5A) before 'a' (0x61), so the
	// winner is ["Z","a"], not a set picked by length, numeric, or
	// case-insensitive ordering.
	records := []Record{
		{ID: "m", Fields: map[string]any{"u": "1", "v": "v2"}},
		{ID: "Z", Fields: map[string]any{"u": "1", "v": "v1"}},
		{ID: "a", Fields: map[string]any{"u": "u1", "v": "1"}},
		{ID: "b", Fields: map[string]any{"u": "u2", "v": "1"}},
	}
	res, err := MinRemovalSet(records, []Constraint{Unique("u"), Unique("v")})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"Z", "a"}; !reflect.DeepEqual(res.RemovedIDs, want) {
		t.Fatalf("RemovedIDs = %v, want %v", res.RemovedIDs, want)
	}
}

func TestValidationErrors(t *testing.T) {
	if _, err := MinRemovalSet(make([]Record, MaxRecords+1), nil); !errors.Is(err, ErrTooManyRecords) {
		t.Fatalf("err = %v, want ErrTooManyRecords", err)
	}
	dup := []Record{{ID: "x"}, {ID: "x"}}
	if _, err := MinRemovalSet(dup, nil); !errors.Is(err, ErrDuplicateRecordID) {
		t.Fatalf("err = %v, want ErrDuplicateRecordID", err)
	}
	if _, err := MinRemovalSet([]Record{{ID: ""}}, nil); !errors.Is(err, ErrEmptyRecordID) {
		t.Fatalf("err = %v, want ErrEmptyRecordID", err)
	}
	if _, err := MinRemovalSet(nil, []Constraint{Unique("")}); !errors.Is(err, ErrInvalidConstraint) {
		t.Fatalf("err = %v, want ErrInvalidConstraint", err)
	}
	if _, err := MinRemovalSet(nil, []Constraint{Determines(nil, "y")}); !errors.Is(err, ErrInvalidConstraint) {
		t.Fatalf("err = %v, want ErrInvalidConstraint", err)
	}
}

func TestNoConflicts(t *testing.T) {
	records := []Record{{ID: "a", Fields: map[string]any{"u": "1"}}, {ID: "b", Fields: map[string]any{"u": "2"}}}
	res, err := MinRemovalSet(records, []Constraint{Unique("u")})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.RemovedIDs) != 0 || len(res.KeptIDs) != 2 {
		t.Fatalf("got %+v", res)
	}
}

// TestExhaustiveVerification cross-checks MinRemovalSet against an
// independent brute force that validates every one of the 2^n subsets and
// applies the same optimality and tie-break rules.
func TestExhaustiveVerification(t *testing.T) {
	rng := rand.New(rand.NewSource(77))
	pool := []any{nil, "x", "y", float64(1), float64(2), true}
	fields := []string{"a", "b", "c"}
	for trial := 0; trial < 300; trial++ {
		n := 1 + rng.Intn(9)
		records := make([]Record, n)
		for i := range records {
			m := make(map[string]any)
			for _, f := range fields {
				if rng.Intn(5) > 0 { // sometimes leave missing (null)
					m[f] = pool[rng.Intn(len(pool))]
				}
			}
			records[i] = Record{ID: fmt.Sprintf("id%d", i), Fields: m}
		}
		var constraints []Constraint
		if rng.Intn(2) == 0 {
			constraints = append(constraints, Unique(fields[rng.Intn(len(fields))]))
		}
		if rng.Intn(2) == 0 {
			constraints = append(constraints, Determines([]string{"a"}, "b"))
		}
		if rng.Intn(2) == 0 {
			constraints = append(constraints, Determines([]string{"a", "b"}, "c"))
		}
		got, err := MinRemovalSet(records, constraints)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		want := bruteForceMinRemoval(t, records, constraints)
		if !reflect.DeepEqual(got.RemovedIDs, want) {
			t.Fatalf("trial %d: RemovedIDs = %v, want %v\nrecords=%v\nconstraints=%+v",
				trial, got.RemovedIDs, want, records, constraints)
		}
	}
}

// bruteForceMinRemoval is an independent reference implementation: it
// enumerates all 2^n subsets, validates each with pairwise record
// comparisons, and keeps the smallest, tie-broken by byte-wise
// lexicographic order of the ascending ID list.
func bruteForceMinRemoval(t *testing.T, records []Record, constraints []Constraint) []string {
	t.Helper()
	n := len(records)
	var best []string
	for mask := 0; mask < 1<<n; mask++ {
		var removed, kept []Record
		for i, r := range records {
			if mask&(1<<i) != 0 {
				removed = append(removed, r)
			} else {
				kept = append(kept, r)
			}
		}
		if best != nil && len(removed) > len(best) {
			continue
		}
		if !pairwiseValid(kept, constraints) {
			continue
		}
		ids := make([]string, len(removed))
		for i, r := range removed {
			ids[i] = r.ID
		}
		sort.Strings(ids)
		if best == nil || len(ids) < len(best) || (len(ids) == len(best) && lessIDs(ids, best)) {
			best = ids
		}
	}
	if best == nil {
		t.Fatal("reference found no solution")
	}
	return best
}

// pairwiseValid checks constraints with direct O(n^2) record-pair
// comparisons, independent of the grouping logic in the package.
func pairwiseValid(kept []Record, constraints []Constraint) bool {
	key := func(v any) string { return fmt.Sprintf("%#v", v) }
	for i := 0; i < len(kept); i++ {
		for j := i + 1; j < len(kept); j++ {
			for _, c := range constraints {
				switch c.Kind {
				case KindUnique:
					if key(kept[i].Fields[c.Field]) == key(kept[j].Fields[c.Field]) {
						return false
					}
				case KindFunctionalDependency:
					same := true
					for _, d := range c.Determinants {
						if key(kept[i].Fields[d]) != key(kept[j].Fields[d]) {
							same = false
							break
						}
					}
					if same && key(kept[i].Fields[c.Dependent]) != key(kept[j].Fields[c.Dependent]) {
						return false
					}
				}
			}
		}
	}
	return true
}

// TestMaxRecords exercises the 20-record cap: 20 rows sharing one unique
// value force 19 removals, and the tie-break keeps the lexicographically
// smallest ascending ID list, i.e. drops the largest IDs.
func TestMaxRecords(t *testing.T) {
	var records []Record
	for i := 0; i < MaxRecords; i++ {
		records = append(records, Record{ID: fmt.Sprintf("r%02d", i), Fields: map[string]any{"u": "same"}})
	}
	res, err := MinRemovalSet(records, []Constraint{Unique("u")})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.RemovedIDs) != MaxRecords-1 {
		t.Fatalf("removed %d, want %d", len(res.RemovedIDs), MaxRecords-1)
	}
	// The tie-break minimizes the removal list, so the kept record is the
	// largest ID: ["r00",...,"r18"] < ["r01",...,"r19"] byte-wise.
	if want := []string{"r19"}; !reflect.DeepEqual(res.KeptIDs, want) {
		t.Fatalf("KeptIDs = %v, want %v", res.KeptIDs, want)
	}
	if res.RemovedIDs[0] != "r00" || res.RemovedIDs[len(res.RemovedIDs)-1] != "r18" {
		t.Fatalf("RemovedIDs = %v", res.RemovedIDs)
	}
	// Every removed record carries the same original 20-way conflict.
	for _, rm := range res.Removals {
		if len(rm.Conflicts) != 1 || len(rm.Conflicts[0].RecordIDs) != MaxRecords {
			t.Fatalf("removal %s evidence = %+v", rm.RecordID, rm.Conflicts)
		}
	}
}
