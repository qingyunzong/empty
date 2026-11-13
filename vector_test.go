package dataeng

import "testing"

func TestVersionVectorCompare(t *testing.T) {
	cases := []struct {
		name string
		a, b VersionVector
		want Ordering
	}{
		{"both empty", nil, nil, Equal},
		{"equal", VersionVector{"us": 1, "eu": 2}, VersionVector{"us": 1, "eu": 2}, Equal},
		{"causal before", VersionVector{"us": 1}, VersionVector{"us": 2, "eu": 1}, Before},
		{"causal after", VersionVector{"us": 2, "eu": 1}, VersionVector{"us": 1}, After},
		{"concurrent forks", VersionVector{"us": 2}, VersionVector{"eu": 2}, Concurrent},
		{"concurrent shared history", VersionVector{"us": 2, "eu": 1}, VersionVector{"us": 1, "eu": 2}, Concurrent},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.a.Compare(tc.b); got != tc.want {
				t.Fatalf("Compare = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestVersionVectorIncAndMerge(t *testing.T) {
	base := VersionVector{"us": 1}
	inc := base.Inc("eu")

	if got := inc.String(); got != "eu:1,us:1" {
		t.Fatalf("Inc rendered %q", got)
	}
	if _, mutated := base["eu"]; mutated {
		t.Fatal("Inc must not mutate the receiver")
	}

	merged := inc.Merge(VersionVector{"us": 3, "ap": 1})
	if merged.String() != "ap:1,eu:1,us:3" {
		t.Fatalf("Merge rendered %q", merged.String())
	}

	if !inc.Dominates(base) || base.Dominates(inc) {
		t.Fatal("Dominates relation incorrect")
	}
}

func TestIncPanicsOnEmptyRegion(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on empty region")
		}
	}()
	NewVersionVector().Inc("")
}
