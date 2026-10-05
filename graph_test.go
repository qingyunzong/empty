package licchk

import (
	"reflect"
	"testing"
)

func TestReachableSimple(t *testing.T) {
	g := Graph{
		"app":  {"liba", "libb"},
		"liba": {"libb"},
		"libb": {},
	}
	got := Reachable(g, "app")
	want := []string{"app", "liba", "libb"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Reachable = %v, want %v", got, want)
	}
}

func TestReachableCycle(t *testing.T) {
	g := Graph{
		"a": {"b"},
		"b": {"c"},
		"c": {"a", "d"},
		"d": {"d"}, // self-loop
		"z": {"a"}, // unreachable from "a"
	}
	got := Reachable(g, "a")
	want := []string{"a", "b", "c", "d"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Reachable with cycle = %v, want %v", got, want)
	}
}

func TestReachableEdgeToUnknown(t *testing.T) {
	g := Graph{"app": {"ext"}}
	got := Reachable(g, "app")
	want := []string{"app", "ext"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Reachable = %v, want %v", got, want)
	}
}
