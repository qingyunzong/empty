package dataeng

import (
	"reflect"
	"testing"
)

func TestWindowSpecValidation(t *testing.T) {
	tests := []struct {
		name string
		spec WindowSpec
		ok   bool
	}{
		{"tumbling", Tumbling(10), true},
		{"tumbling zero", Tumbling(0), false},
		{"sliding", Sliding(10, 5), true},
		{"sliding zero size", Sliding(0, 5), false},
		{"sliding zero slide", Sliding(10, 0), false},
		{"session", Session(5), true},
		{"session zero", Session(0), false},
		{"unknown", WindowSpec{Kind: 99}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.spec.Validate()
			if tc.ok && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestAssignTumbling(t *testing.T) {
	tests := []struct {
		ts   int64
		want []Window
	}{
		{0, []Window{{0, 10}}},
		{9, []Window{{0, 10}}},
		{10, []Window{{10, 20}}},
		{-1, []Window{{-10, 0}}},
	}
	spec := Tumbling(10)
	for _, tc := range tests {
		got := spec.Assign(tc.ts)
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("Assign(%d) = %v, want %v", tc.ts, got, tc.want)
		}
	}
}

func TestAssignSliding(t *testing.T) {
	tests := []struct {
		name string
		spec WindowSpec
		ts   int64
		want []Window
	}{
		{"overlapping", Sliding(10, 5), 6, []Window{{0, 10}, {5, 15}}},
		{"boundary", Sliding(10, 5), 5, []Window{{0, 10}, {5, 15}}},
		{"size below slide creates gap", Sliding(5, 10), 7, nil},
		{"negative overlapping", Sliding(10, 5), -1, []Window{{-10, 0}, {-5, 5}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.spec.Assign(tc.ts)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Assign(%d) = %v, want %v", tc.ts, got, tc.want)
			}
		})
	}
}

func TestWindowContains(t *testing.T) {
	w := Window{Start: 10, End: 20}
	if !w.Contains(10) || !w.Contains(19) {
		t.Fatal("window should contain [10,20)")
	}
	if w.Contains(9) || w.Contains(20) {
		t.Fatal("window end must be exclusive")
	}
}
