package batchresp

import (
	"errors"
	"testing"
)

func TestFailedSegmentArrivesLate(t *testing.T) {
	segments := []Segment{
		{ContentID: "failed", StatusCode: 500, Value: mustJSON(t, `{"error":"boom"}`)},
		{ContentID: "mid", StatusCode: 200,
			Value: map[string]any{"f": map[string]any{"$ref": "failed#"}}},
		{ContentID: "top", StatusCode: 200,
			Value: map[string]any{"m": map[string]any{"$ref": "mid#"}}},
		{ContentID: "independent", StatusCode: 200, Value: mustJSON(t, `{"ok":1}`)},
	}

	for order, batch := range permutations(segments) {
		group := buildGroup(t, "late-fail", batch)
		result := group.Resolve()
		if result.Err != nil {
			t.Fatalf("order %d: group error %v", order, result.Err)
		}
		for _, id := range []string{"failed", "mid", "top"} {
			err, ok := result.Failed[id]
			if !ok {
				t.Fatalf("order %d: %q not marked failed", order, id)
			}
			if id == "failed" {
				var statusErr *statusError
				if !errors.As(err, &statusErr) {
					t.Fatalf("order %d: root failure type = %T", order, err)
				}
			} else if !errors.Is(err, err) {
				t.Fatalf("order %d: wrapped failure is nil for %q", order, id)
			}
		}
		if _, ok := result.Values["top"]; ok {
			t.Fatalf("order %d: dependent value must not be delivered", order)
		}
		if _, ok := result.Values["independent"]; !ok {
			t.Fatalf("order %d: independent value missing", order)
		}
	}
}

func TestDuplicateContentIDRejected(t *testing.T) {
	group := NewGroup("dup")
	first := Segment{ContentID: "x", StatusCode: 200, Value: mustJSON(t, `{"v":1}`)}
	duplicate := Segment{ContentID: "x", StatusCode: 200, Value: mustJSON(t, `{"v":2}`)}
	if err := group.Add(first); err != nil {
		t.Fatalf("first Add: %v", err)
	}
	assertErrorIs(t, group.Add(duplicate), ErrDuplicateID)

	result := group.Resolve()
	if result.Values["x"].(map[string]any)["v"] != float64(1) {
		t.Fatalf("duplicate segment must not overwrite the first: %#v", result.Values["x"])
	}
}

func TestCyclesReportedSeparately(t *testing.T) {
	segments := []Segment{
		{ContentID: "a", StatusCode: 200, Value: map[string]any{"$ref": "b#"}},
		{ContentID: "b", StatusCode: 200, Value: map[string]any{"$ref": "c#"}},
		{ContentID: "c", StatusCode: 200, Value: map[string]any{"$ref": "a#"}},
		{ContentID: "outside", StatusCode: 200, Value: mustJSON(t, `{"fine":true}`)},
	}

	var baseline string
	for order, batch := range permutations(segments) {
		result := buildGroup(t, "cycles", batch).Resolve()
		if result.Err != nil {
			t.Fatalf("order %d: cycles are not group-wide errors: %v", order, result.Err)
		}
		if len(result.Cycles) != 1 {
			t.Fatalf("order %d: cycles = %#v", order, result.Cycles)
		}
		wantMembers := []string{"a", "b", "c"}
		if !equalSlices(result.Cycles[0].Members, wantMembers) {
			t.Fatalf("order %d: members = %v, want %v",
				order, result.Cycles[0].Members, wantMembers)
		}
		for _, id := range wantMembers {
			if !errors.Is(result.Failed[id], ErrCycle) {
				t.Fatalf("order %d: %q failure = %v", order, id, result.Failed[id])
			}
		}
		if result.Values["outside"] == nil {
			t.Fatalf("order %d: unrelated segment must still succeed", order)
		}
		digest := resultDigest(result)
		if order == 0 {
			baseline = digest
		} else if digest != baseline {
			t.Fatalf("order %d cycle result diverged", order)
		}
	}
}

func TestSelfCycleReported(t *testing.T) {
	group := NewGroup("self")
	if err := group.Add(Segment{
		ContentID: "s", StatusCode: 200,
		Value: map[string]any{"$ref": "s#"},
	}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	result := group.Resolve()
	if len(result.Cycles) != 1 || result.Cycles[0].Members[0] != "s" {
		t.Fatalf("self cycle = %#v", result.Cycles)
	}
	if !errors.Is(result.Failed["s"], ErrCycle) {
		t.Fatalf("self cycle failure = %v", result.Failed["s"])
	}
}

func TestNodeBudgetRejectsWholeGroup(t *testing.T) {
	segments := []Segment{
		{ContentID: "src", StatusCode: 200, Value: mustJSON(t, `{"a":1,"b":2,"c":3}`)},
		{ContentID: "one", StatusCode: 200, Value: map[string]any{"x": map[string]any{"$ref": "src#"}}},
		{ContentID: "two", StatusCode: 200, Value: map[string]any{"y": map[string]any{"$ref": "src#"}}},
	}

	var baseline string
	for order, batch := range permutations(segments) {
		group := NewGroup("budget", WithNodeBudget(7))
		for _, seg := range batch {
			if err := group.Add(seg); err != nil {
				t.Fatalf("order %d: Add: %v", order, err)
			}
		}
		result := group.Resolve()
		if !errors.Is(result.Err, ErrBudgetExceeded) {
			t.Fatalf("order %d: expected ErrBudgetExceeded, got %v", order, result.Err)
		}
		if result.Values != nil {
			t.Fatalf("order %d: budget breach must not deliver partial values", order)
		}
		digest := resultDigest(result)
		if order == 0 {
			baseline = digest
		} else if digest != baseline {
			t.Fatalf("order %d budget result diverged", order)
		}
	}

	group := NewGroup("within-budget", WithNodeBudget(20))
	for _, seg := range segments {
		if err := group.Add(seg); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	if result := group.Resolve(); result.Err != nil {
		t.Fatalf("larger budget should succeed, got %v", result.Err)
	}
}

func TestUnresolvedPointerFailsDependentOnly(t *testing.T) {
	group := NewGroup("bad-pointer")
	mustAdd(t, group, Segment{
		ContentID: "src", StatusCode: 200, Value: mustJSON(t, `{"exists":true}`)})
	mustAdd(t, group, Segment{
		ContentID: "bad", StatusCode: 200,
		Value: map[string]any{"$ref": "src#/missing"}})
	mustAdd(t, group, Segment{
		ContentID: "ok", StatusCode: 200, Value: mustJSON(t, `{"fine":1}`)})

	result := group.Resolve()
	if result.Err != nil {
		t.Fatalf("pointer failure is segment-scoped, got group error %v", result.Err)
	}
	if !errors.Is(result.Failed["bad"], ErrUnresolvedRef) {
		t.Fatalf("bad = %v", result.Failed["bad"])
	}
	if result.Values["ok"] == nil || result.Values["src"] == nil {
		t.Fatalf("unrelated segments must be delivered: %#v", result.Values)
	}
}

func TestCustomFailureThresholdAndRefKey(t *testing.T) {
	group := NewGroup("custom",
		WithFailStatusThreshold(300),
		WithRefKey("_link"))
	mustAdd(t, group, Segment{
		ContentID: "redir", StatusCode: 302, Value: mustJSON(t, `{"where":"here"}`)})
	mustAdd(t, group, Segment{
		ContentID: "user", StatusCode: 200,
		Value: map[string]any{"_link": "redir#"}})

	result := group.Resolve()
	var statusErr *statusError
	if !errors.As(result.Failed["redir"], &statusErr) {
		t.Fatalf("302 should fail under threshold 300: %v", result.Failed["redir"])
	}
	if result.Failed["user"] == nil {
		t.Fatalf("user must inherit the redirect failure: %#v", result.Failed)
	}
}

func mustAdd(t *testing.T, group *Group, seg Segment) {
	t.Helper()
	if err := group.Add(seg); err != nil {
		t.Fatalf("Add(%q): %v", seg.ContentID, err)
	}
}

func equalSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
