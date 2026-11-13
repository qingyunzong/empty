package dataeng

import (
	"errors"
	"testing"
)

func TestEnumeratePartitionsCounts(t *testing.T) {
	tests := []struct {
		name   string
		ids    []string
		must   []Pair
		cannot []Pair
		want   int
	}{
		{name: "three unconstrained", ids: []string{"a", "b", "c"}, want: 5},
		{name: "four unconstrained", ids: []string{"a", "b", "c", "d"}, want: 15},
		{
			name: "must chain",
			ids:  []string{"a", "b", "c"},
			must: []Pair{{"a", "b"}, {"b", "c"}},
			want: 1,
		},
		{
			name:   "one cannot pair",
			ids:    []string{"a", "b", "c"},
			cannot: []Pair{{"a", "b"}},
			want:   3,
		},
		{
			name:   "must and cannot",
			ids:    []string{"a", "b", "c"},
			must:   []Pair{{"a", "b"}},
			cannot: []Pair{{"a", "c"}},
			want:   1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			g, err := New(tc.must, tc.cannot)
			if err != nil {
				t.Fatal(err)
			}
			g.Register(tc.ids...)
			parts, err := g.EnumeratePartitions()
			if err != nil {
				t.Fatal(err)
			}
			if len(parts) != tc.want {
				t.Fatalf("got %d partitions, want %d: %v", len(parts), tc.want, parts)
			}
			for _, p := range parts {
				if !satisfiesHard(p, g.must, g.cannot) {
					t.Fatalf("partition %v violates hard constraints", p)
				}
			}
		})
	}
}

func TestEnumeratePartitionsLimit(t *testing.T) {
	g, err := New(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.Register("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k")
	_, err = g.EnumeratePartitions()
	if !errors.Is(err, ErrEnumerationTooLarge) {
		t.Fatalf("got %v, want ErrEnumerationTooLarge", err)
	}
}

func TestPartitionCanonical(t *testing.T) {
	p := Partition{{"c", "a"}, {}, {"b"}}
	got := p.Canonical()
	want := Partition{{"a", "c"}, {"b"}}
	if got.String() != want.String() {
		t.Fatalf("canonical partition = %v, want %v", got, want)
	}
}

func satisfiesHard(p Partition, must, cannot []Pair) bool {
	for _, pair := range must {
		if !coLocates(p, pair.Left, pair.Right) {
			return false
		}
	}
	for _, pair := range cannot {
		if pair.Left == pair.Right {
			return false
		}
		if coLocates(p, pair.Left, pair.Right) {
			return false
		}
	}
	return true
}
