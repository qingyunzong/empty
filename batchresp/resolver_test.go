package batchresp

import (
	"errors"
	"testing"
)

func TestIngestedAndReturnedValuesAreImmutableCopies(t *testing.T) {
	source := map[string]any{
		"nested": map[string]any{"num": float64(1)},
		"list":   []any{float64(1), float64(2)},
	}
	group := NewGroup("immutable")
	mustAdd(t, group, Segment{ContentID: "src", StatusCode: 200, Value: source})
	mustAdd(t, group, Segment{
		ContentID: "user", StatusCode: 200,
		Value: map[string]any{"copy": map[string]any{"$ref": "src#"}}})

	source["nested"].(map[string]any)["num"] = float64(99)
	source["list"].([]any)[0] = float64(99)

	result := group.Resolve()
	if result.Err != nil {
		t.Fatalf("Resolve: %v", result.Err)
	}
	user := result.Values["user"].(map[string]any)
	copy1 := user["copy"].(map[string]any)
	copy1["nested"].(map[string]any)["num"] = float64(7)

	again := group.Resolve()
	copy2 := again.Values["user"].(map[string]any)["copy"].(map[string]any)
	if copy2["nested"].(map[string]any)["num"] != float64(1) {
		t.Fatalf("re-resolution returned mutated state: %#v", copy2)
	}
	if copy2["list"].([]any)[0] != float64(1) {
		t.Fatalf("list element was mutated through a previous result: %#v", copy2["list"])
	}
}

func TestStreamingResolverDeliversOnClosureIncludingLateFailure(t *testing.T) {
	delivered := make(chan Result, 4)
	resolver := NewResolver(func(result Result) {
		delivered <- result
	})

	if err := resolver.Add("tx", Segment{
		ContentID: "top", StatusCode: 200,
		Value: map[string]any{"mid": map[string]any{"$ref": "mid#"}}}); err != nil {
		t.Fatalf("Add top: %v", err)
	}
	if err := resolver.Add("tx", Segment{
		ContentID: "mid", StatusCode: 200,
		Value: map[string]any{"f": map[string]any{"$ref": "failed#"}}}); err != nil {
		t.Fatalf("Add mid: %v", err)
	}

	pending := resolver.PendingGroups()
	if len(pending) != 1 || pending[0] != "tx" {
		t.Fatalf("PendingGroups = %v", pending)
	}

	if err := resolver.Add("tx", Segment{
		ContentID: "failed", StatusCode: 502, Value: map[string]any{}}); err != nil {
		t.Fatalf("Add failed: %v", err)
	}

	result := <-delivered
	if result.GroupID != "tx" {
		t.Fatalf("GroupID = %q", result.GroupID)
	}
	for _, id := range []string{"failed", "mid", "top"} {
		if result.Failed[id] == nil {
			t.Fatalf("%q must be failed after late failure: %#v", id, result.Failed)
		}
	}
	if len(resolver.PendingGroups()) != 0 {
		t.Fatalf("group must be marked delivered")
	}

	assertErrorIs(t, resolver.Add("tx", Segment{
		ContentID: "top", StatusCode: 200, Value: map[string]any{}}), ErrGroupClosed)
}

func TestResolverOptionsApplyToEveryGroup(t *testing.T) {
	results := make(chan Result, 1)
	resolver := NewResolver(func(result Result) { results <- result }, WithNodeBudget(1))
	if err := resolver.Add("g", Segment{
		ContentID: "big", StatusCode: 200,
		Value: mustJSON(t, `{"a":1,"b":2}`)}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	result := <-results
	if !errors.Is(result.Err, ErrBudgetExceeded) {
		t.Fatalf("resolver-level budget not enforced: %v", result.Err)
	}
}

func TestExplicitRefsCloseDependencies(t *testing.T) {
	group := NewGroup("explicit")
	mustAdd(t, group, Segment{
		ContentID: "target", StatusCode: 200, Value: mustJSON(t, `{"k":[1,2]}`)})
	mustAdd(t, group, Segment{
		ContentID: "holder", StatusCode: 200,
		Value: mustJSON(t, `{"note":"uses explicit refs only"}`),
		Refs:  []string{"target#/k/1"}})

	if pending := group.Pending(); len(pending) != 0 {
		t.Fatalf("Pending = %v", pending)
	}
	result := group.Resolve()
	if result.Err != nil || result.Failed != nil {
		t.Fatalf("explicit refs must close the group: %+v", result)
	}
}
