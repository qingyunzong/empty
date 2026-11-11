package batchresp

import (
	"errors"
	"reflect"
	"testing"
)

func buildGroup(t *testing.T, id string, segments []Segment) *Group {
	t.Helper()
	group := NewGroup(id)
	for _, seg := range segments {
		if err := group.Add(seg); err != nil {
			t.Fatalf("Add(%q): %v", seg.ContentID, err)
		}
	}
	return group
}

func TestResolveBasicOutOfOrder(t *testing.T) {
	segments := []Segment{
		{ContentID: "root", StatusCode: 200,
			Value: mustJSON(t, `{"child":{"$ref":"child#/payload"},"n":1}`)},
		{ContentID: "child", StatusCode: 201,
			Value: mustJSON(t, `{"payload":{"k":"v"}}`)},
		{ContentID: "leaf", StatusCode: 200,
			Value: mustJSON(t, `{"x":true}`),
			Refs:  []string{"child#/payload"}},
	}

	wantRoot := map[string]any{
		"child": map[string]any{"k": "v"},
		"n":     float64(1),
	}
	for order, batch := range permutations(segments) {
		group := buildGroup(t, "g", batch)
		if pending := group.Pending(); len(pending) != 0 {
			t.Fatalf("order %d: pending = %v", order, pending)
		}
		result := group.Resolve()
		if result.Err != nil || len(result.Failed) != 0 || len(result.Cycles) != 0 {
			t.Fatalf("order %d: unexpected result %+v", order, result)
		}
		if !reflect.DeepEqual(result.Values["root"], wantRoot) {
			t.Fatalf("order %d: root = %#v, want %#v", order, result.Values["root"], wantRoot)
		}
		if !reflect.DeepEqual(result.Values["leaf"], mustJSON(t, `{"x":true}`)) {
			t.Fatalf("order %d: leaf = %#v", order, result.Values["leaf"])
		}
	}
}

func TestDiamondSharesIndependentDeepCopies(t *testing.T) {
	segments := []Segment{
		{ContentID: "c", StatusCode: 200, Value: mustJSON(t, `{"v":1}`)},
		{ContentID: "a", StatusCode: 200, Value: map[string]any{
			"shared": map[string]any{"$ref": "c#"}}},
		{ContentID: "b", StatusCode: 200, Value: map[string]any{
			"shared": map[string]any{"$ref": "c#"}}},
		{ContentID: "d", StatusCode: 200, Value: map[string]any{
			"left":  map[string]any{"$ref": "a#"},
			"right": map[string]any{"$ref": "b#"}}},
	}

	for order, batch := range permutations(segments) {
		group := buildGroup(t, "diamond", batch)
		result := group.Resolve()
		if result.Err != nil {
			t.Fatalf("order %d: %v", order, result.Err)
		}
		root := result.Values["d"].(map[string]any)
		left := root["left"].(map[string]any)["shared"].(map[string]any)
		right := root["right"].(map[string]any)["shared"].(map[string]any)
		if !reflect.DeepEqual(left, right) {
			t.Fatalf("order %d: branches differ: %#v vs %#v", order, left, right)
		}
		left["v"] = float64(99)
		if right["v"] != float64(1) {
			t.Fatalf("order %d: diamond branches share mutable memory", order)
		}
		if group.segments["c"].value.(map[string]any)["v"] != float64(1) {
			t.Fatalf("order %d: stored source segment was mutated", order)
		}
	}
}

func TestEscapedPointerPaths(t *testing.T) {
	segments := []Segment{
		{ContentID: "src", StatusCode: 200,
			Value: mustJSON(t, `{"a/b":{"c~d":[10,20]},"plain":{"ok":true}}`)},
		{ContentID: "esc", StatusCode: 200, Value: map[string]any{
			"slash": map[string]any{"$ref": "src#/a~1b/c~0d/1"},
			"tilde": map[string]any{"$ref": "src#/a~1b/c~0d/0"},
			"plain": map[string]any{"$ref": "src#/plain/ok"},
			"whole": map[string]any{"$ref": "src#"}}},
	}

	for order, batch := range permutations(segments) {
		group := buildGroup(t, "esc", batch)
		result := group.Resolve()
		if result.Err != nil {
			t.Fatalf("order %d: %v", order, result.Err)
		}
		got := result.Values["esc"].(map[string]any)
		if got["slash"] != float64(20) || got["tilde"] != float64(10) || got["plain"] != true {
			t.Fatalf("order %d: escaped resolution = %#v", order, got)
		}
		source := mustJSON(t, `{"a/b":{"c~d":[10,20]},"plain":{"ok":true}}`)
		if canonical(got["whole"]) != canonical(source) {
			t.Fatalf("order %d: whole-document ref = %#v", order, got["whole"])
		}
	}
}

func TestResultIndependentOfArrivalOrder(t *testing.T) {
	segments := []Segment{
		{ContentID: "c", StatusCode: 200, Value: mustJSON(t, `{"v":1}`)},
		{ContentID: "a", StatusCode: 200, Value: map[string]any{
			"c": map[string]any{"$ref": "c#"}}},
		{ContentID: "b", StatusCode: 503, Value: mustJSON(t, `{"err":"down"}`)},
		{ContentID: "d", StatusCode: 200, Value: map[string]any{
			"a": map[string]any{"$ref": "a#"},
			"b": map[string]any{"$ref": "b#"}}},
	}

	var baseline string
	for order, batch := range permutations(segments) {
		result := buildGroup(t, "order", batch).Resolve()
		digest := resultDigest(result)
		if order == 0 {
			baseline = digest
			continue
		}
		if digest != baseline {
			t.Fatalf("order %d diverged:\n got %s\nwant %s", order, digest, baseline)
		}
	}

	result := buildGroup(t, "order", segments).Resolve()
	if _, ok := result.Values["d"]; ok {
		t.Fatalf("segment depending on failed b must not be delivered")
	}
	if result.Failed["b"] == nil || result.Failed["d"] == nil {
		t.Fatalf("b and d must be failed: %#v", result.Failed)
	}
	if result.Values["a"] == nil || result.Values["c"] == nil {
		t.Fatalf("independent success chain must be delivered: %#v", result.Values)
	}
}

func TestPendingGroupRejectsResolve(t *testing.T) {
	group := NewGroup("open")
	if err := group.Add(Segment{
		ContentID: "a", StatusCode: 200,
		Value: map[string]any{"$ref": "missing#/x"},
	}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	pending := group.Pending()
	if len(pending) != 1 || pending[0] != "missing" {
		t.Fatalf("Pending = %v", pending)
	}
	result := group.Resolve()
	if !errors.Is(result.Err, ErrPending) {
		t.Fatalf("expected ErrPending, got %v", result.Err)
	}
	if result.Values != nil {
		t.Fatalf("pending result must not deliver values")
	}
}
