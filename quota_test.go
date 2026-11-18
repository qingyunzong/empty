package formal

import (
	"errors"
	"reflect"
	"testing"
)

func testTree(t *testing.T) *Calculator {
	t.Helper()
	calc, err := NewCalculator(Config{Nodes: []Node{
		{ID: "root", Limit: Resources{"cpu": 10}},
		{ID: "a", Parent: "root", Limit: Resources{"cpu": 8}, Priority: 2},
		{ID: "a1", Parent: "a", Priority: 1},
		{ID: "a2", Parent: "a", Priority: 1},
		{ID: "b", Parent: "root", Limit: Resources{"cpu": 8}, Priority: 1},
		{ID: "b1", Parent: "b", Priority: 1},
	}})
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}
	return calc
}

func TestHierarchicalFairShare(t *testing.T) {
	calc := testTree(t)
	got, err := calc.FairShareFresh([]Demand{
		{Node: "a1", Resources: Resources{"cpu": 5}},
		{Node: "a2", Resources: Resources{"cpu": 5}},
		{Node: "b1", Resources: Resources{"cpu": 2}},
	})
	if err != nil {
		t.Fatalf("FairShareFresh: %v", err)
	}
	want := map[string]Resources{
		"root": {"cpu": 10},
		"a":    {"cpu": 8},
		"a1":   {"cpu": 4},
		"a2":   {"cpu": 4},
		"b":    {"cpu": 2},
		"b1":   {"cpu": 2},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("FairShareFresh = %#v, want %#v", got, want)
	}
}

func TestFairShareIntegerRemaindersAtEveryLevel(t *testing.T) {
	calc, err := NewCalculator(Config{Nodes: []Node{
		{ID: "root", Limit: Resources{"cpu": 7}},
		{ID: "a", Parent: "root"},
		{ID: "b", Parent: "root"},
	}})
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}
	got, err := calc.FairShareFresh([]Demand{
		{Node: "a", Resources: Resources{"cpu": 4}},
		{Node: "b", Resources: Resources{"cpu": 4}},
	})
	if err != nil {
		t.Fatalf("FairShareFresh: %v", err)
	}
	if got["a"]["cpu"] != 4 || got["b"]["cpu"] != 3 {
		t.Fatalf("remainder split = %v/%v, want 4/3", got["a"]["cpu"], got["b"]["cpu"])
	}
	if got["root"]["cpu"] != 7 {
		t.Fatalf("root grant = %d, want 7", got["root"]["cpu"])
	}
}

func TestFairShareRespectsOverlappingLimits(t *testing.T) {
	calc, err := NewCalculator(Config{Nodes: []Node{
		{ID: "root", Limit: Resources{"gpu": 10}},
		{ID: "team", Parent: "root", Limit: Resources{"gpu": 2}},
		{ID: "job", Parent: "team"},
	}})
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}
	got, err := calc.FairShareFresh([]Demand{
		{Node: "job", Resources: Resources{"gpu": 100}},
	})
	if err != nil {
		t.Fatalf("FairShareFresh: %v", err)
	}
	for _, node := range []string{"root", "team", "job"} {
		if got[node]["gpu"] != 2 {
			t.Fatalf("%s grant = %d, want 2", node, got[node]["gpu"])
		}
	}
}

func TestFairShareUsesFreeCapacity(t *testing.T) {
	calc := testTree(t)
	if _, err := calc.Reserve(Request{
		ID:        "existing",
		Node:      "a1",
		Resources: Resources{"cpu": 6},
	}); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	fresh, err := calc.FairShareFresh([]Demand{{Node: "a1", Resources: Resources{"cpu": 5}}})
	if err != nil {
		t.Fatalf("FairShareFresh: %v", err)
	}
	if fresh["a1"]["cpu"] != 5 {
		t.Fatalf("fresh grant = %d, want 5", fresh["a1"]["cpu"])
	}
	free, err := calc.FairShare([]Demand{{Node: "a1", Resources: Resources{"cpu": 5}}})
	if err != nil {
		t.Fatalf("FairShare: %v", err)
	}
	if free["a1"]["cpu"] != 2 {
		t.Fatalf("free grant = %d, want 2", free["a1"]["cpu"])
	}
	if free["root"]["cpu"] != 2 || free["a"]["cpu"] != 2 {
		t.Fatalf("ancestor grants = root %d a %d, want 2/2", free["root"]["cpu"], free["a"]["cpu"])
	}
}

func TestFairShareAggregatesDuplicateDemands(t *testing.T) {
	calc := testTree(t)
	got, err := calc.FairShareFresh([]Demand{
		{Node: "a1", Resources: Resources{"cpu": 1}},
		{Node: "a1", Resources: Resources{"cpu": 2}},
	})
	if err != nil {
		t.Fatalf("FairShareFresh: %v", err)
	}
	if got["a1"]["cpu"] != 3 {
		t.Fatalf("aggregated grant = %d, want 3", got["a1"]["cpu"])
	}
}

func TestFairShareRejectsUnknownNode(t *testing.T) {
	calc := testTree(t)
	_, err := calc.FairShareFresh([]Demand{{Node: "missing", Resources: Resources{"cpu": 1}}})
	if !errors.Is(err, ErrUnknownNode) {
		t.Fatalf("error = %v, want ErrUnknownNode", err)
	}
}

func TestFairShareZeroDemand(t *testing.T) {
	calc := testTree(t)
	got, err := calc.FairShareFresh(nil)
	if err != nil {
		t.Fatalf("FairShareFresh: %v", err)
	}
	for id, vector := range got {
		if !vector.IsZero() {
			t.Fatalf("node %q got non-zero vector %v", id, vector)
		}
	}
}

func TestFairShareHardZero(t *testing.T) {
	calc, err := NewCalculator(Config{Nodes: []Node{
		{ID: "root", Limit: Resources{"cpu": 5}},
		{ID: "blocked", Parent: "root", Limit: Resources{"cpu": 0}},
	}})
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}
	got, err := calc.FairShareFresh([]Demand{{Node: "blocked", Resources: Resources{"cpu": 3}}})
	if err != nil {
		t.Fatalf("FairShareFresh: %v", err)
	}
	if got["blocked"]["cpu"] != 0 || got["root"]["cpu"] != 0 {
		t.Fatalf("zero-limit grants = %v", got)
	}
}

func TestFairShareMultipleResources(t *testing.T) {
	calc, err := NewCalculator(Config{Nodes: []Node{
		{ID: "root", Limit: Resources{"cpu": 10, "mem": 5}},
		{ID: "a", Parent: "root"},
		{ID: "b", Parent: "root"},
	}})
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}
	got, err := calc.FairShareFresh([]Demand{
		{Node: "a", Resources: Resources{"cpu": 5, "mem": 1}},
		{Node: "b", Resources: Resources{"cpu": 5, "mem": 3}},
	})
	if err != nil {
		t.Fatalf("FairShareFresh: %v", err)
	}
	if got["a"]["cpu"] != 5 || got["b"]["cpu"] != 5 {
		t.Fatalf("cpu split = %v", got)
	}
	if got["a"]["mem"] != 1 || got["b"]["mem"] != 3 {
		t.Fatalf("mem split = %v", got)
	}
	if got["root"]["cpu"] != 10 || got["root"]["mem"] != 4 {
		t.Fatalf("root totals = %v", got["root"])
	}
}

func TestNewCalculatorValidation(t *testing.T) {
	tests := []struct {
		name  string
		nodes []Node
	}{
		{"empty", nil},
		{"no root", []Node{{ID: "a", Parent: "b"}, {ID: "b", Parent: "a"}}},
		{"multiple roots", []Node{{ID: "a"}, {ID: "b"}}},
		{"missing parent", []Node{{ID: "a", Parent: "missing"}}},
		{"duplicate id", []Node{{ID: "a"}, {ID: "a"}}},
		{"negative limit", []Node{{ID: "a", Limit: Resources{"cpu": -1}}}},
		{"unreachable cycle", []Node{{ID: "a"}, {ID: "b", Parent: "c"}, {ID: "c", Parent: "b"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewCalculator(Config{Nodes: test.nodes}); !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("error = %v, want ErrInvalidConfig", err)
			}
		})
	}
}
