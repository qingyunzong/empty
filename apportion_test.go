package formal

import (
	"fmt"
	"math/rand"
	"testing"
)

func TestApportionBasics(t *testing.T) {
	tests := []struct {
		name     string
		capacity int64
		items    []apportionItem
		want     []int64
	}{
		{
			name:     "exact demand",
			capacity: 10,
			items: []apportionItem{
				{demand: 4, max: 4, order: "a"},
				{demand: 6, max: 6, order: "b"},
			},
			want: []int64{4, 6},
		},
		{
			name:     "proportional halves",
			capacity: 10,
			items: []apportionItem{
				{demand: 6, max: 6, order: "a"},
				{demand: 6, max: 6, order: "b"},
			},
			want: []int64{5, 5},
		},
		{
			name:     "largest remainder",
			capacity: 7,
			items: []apportionItem{
				{demand: 4, max: 4, order: "a"},
				{demand: 4, max: 4, order: "b"},
			},
			want: []int64{4, 3},
		},
		{
			name:     "tie by stable order",
			capacity: 7,
			items: []apportionItem{
				{demand: 3, max: 3, order: "b"},
				{demand: 3, max: 3, order: "a"},
				{demand: 3, max: 3, order: "c"},
			},
			want: []int64{2, 3, 2},
		},
		{
			name:     "cap redistributes",
			capacity: 10,
			items: []apportionItem{
				{demand: 10, max: 2, order: "a"},
				{demand: 10, max: 10, order: "b"},
			},
			want: []int64{2, 8},
		},
		{
			name:     "multiple caps",
			capacity: 20,
			items: []apportionItem{
				{demand: 10, max: 1, order: "a"},
				{demand: 10, max: 2, order: "b"},
				{demand: 10, max: 30, order: "c"},
			},
			want: []int64{1, 2, 17},
		},
		{
			name:     "capacity above total",
			capacity: 100,
			items: []apportionItem{
				{demand: 2, max: 2, order: "a"},
				{demand: 3, max: 3, order: "b"},
			},
			want: []int64{2, 3},
		},
		{
			name:     "zero capacity",
			capacity: 0,
			items: []apportionItem{
				{demand: 5, max: 5, order: "a"},
			},
			want: []int64{0},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := apportion(test.capacity, test.items)
			if len(got) != len(test.want) {
				t.Fatalf("apportion returned %v, want %v", got, test.want)
			}
			for i := range got {
				if got[i] != test.want[i] {
					t.Fatalf("apportion returned %v, want %v", got, test.want)
				}
			}
		})
	}
}

func TestApportionRandomProperties(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for round := 0; round < 5000; round++ {
		n := 1 + rng.Intn(5)
		items := make([]apportionItem, n)
		var sumMax int64
		for i := range items {
			demand := int64(rng.Intn(20))
			max := int64(rng.Intn(20))
			if max > demand {
				max = demand
			}
			items[i] = apportionItem{
				demand:   demand,
				max:      max,
				priority: int64(rng.Intn(3)),
				order:    fmt.Sprintf("%02d", rng.Intn(100)),
			}
			sumMax += max
		}
		capacity := int64(rng.Intn(40))
		grants := apportion(capacity, items)

		wantSum := capacity
		if sumMax < wantSum {
			wantSum = sumMax
		}
		var gotSum int64
		for i, grant := range grants {
			if grant < 0 {
				t.Fatalf("round %d: negative grant %d", round, grant)
			}
			if grant > items[i].max {
				t.Fatalf("round %d: grant %d exceeds max %d", round, grant, items[i].max)
			}
			if grant > items[i].demand {
				t.Fatalf("round %d: grant %d exceeds demand %d", round, grant, items[i].demand)
			}
			gotSum += grant
		}
		if gotSum != wantSum {
			t.Fatalf("round %d: grant sum %d, want %d (capacity %d, sumMax %d, items %+v)",
				round, gotSum, wantSum, capacity, sumMax, items)
		}
	}
}

func TestApportionDeterministic(t *testing.T) {
	items := []apportionItem{
		{demand: 7, max: 7, order: "c"},
		{demand: 7, max: 7, order: "a"},
		{demand: 7, max: 7, order: "b"},
	}
	first := apportion(10, items)
	for i := 0; i < 100; i++ {
		got := apportion(10, items)
		for j := range first {
			if got[j] != first[j] {
				t.Fatalf("non-deterministic apportion: %v vs %v", got, first)
			}
		}
	}
}
