package batchresp

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
)

func mustJSON(t *testing.T, raw string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatalf("invalid fixture JSON %q: %v", raw, err)
	}
	return v
}

func permutations(items []Segment) [][]Segment {
	var out [][]Segment
	var walk func(int)
	walk = func(start int) {
		if start == len(items) {
			out = append(out, append([]Segment(nil), items...))
			return
		}
		for i := start; i < len(items); i++ {
			items[start], items[i] = items[i], items[start]
			walk(start + 1)
			items[start], items[i] = items[i], items[start]
		}
	}
	walk(0)
	return out
}

func assertErrorIs(t *testing.T, err error, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("expected error wrapping %v, got %v", target, err)
	}
}

func canonical(v any) string {
	switch node := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(node))
		for key := range node {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			parts = append(parts, strconvQuote(key)+":"+canonical(node[key]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := make([]string, len(node))
		for i, child := range node {
			parts[i] = canonical(child)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case nil:
		return "null"
	default:
		return fmt.Sprintf("%T:%v", node, node)
	}
}

func strconvQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func resultDigest(r Result) string {
	failed := make([]string, 0, len(r.Failed))
	for id, err := range r.Failed {
		failed = append(failed, id+"="+err.Error())
	}
	sort.Strings(failed)

	cycles := make([]string, 0, len(r.Cycles))
	for _, cycle := range r.Cycles {
		cycles = append(cycles, strings.Join(cycle.Members, "->"))
	}
	sort.Strings(cycles)

	values := make([]string, 0, len(r.Values))
	for id, value := range r.Values {
		values = append(values, id+"="+canonical(value))
	}
	sort.Strings(values)

	return fmt.Sprintf("err=%v|failed=%s|cycles=%s|values=%s",
		r.Err, strings.Join(failed, ";"), strings.Join(cycles, ";"),
		strings.Join(values, ";"))
}
