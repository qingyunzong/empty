package q255

import "testing"

func TestCmpRational(t *testing.T) {
	cases := []struct {
		name             string
		aNum, aDen       int64
		bNum, bDen       int64
		want             int
		sameMilliseconds bool
	}{
		{
			name: "just past one second in 48kHz vs 1s in 90kHz",
			aNum: 48001, aDen: 48000, // 1.0000208...s
			bNum: 90000, bDen: 90000, // exactly 1s
			want:             1,
			sameMilliseconds: true, // truncation to ms would call both 1000ms
		},
		{
			name: "exact boundary equality across time bases",
			aNum: 48000, aDen: 48000,
			bNum: 90000, bDen: 90000,
			want: 0,
		},
		{
			name: "adjacent 90kHz ticks collapse to one millisecond",
			aNum: 90000, aDen: 90000, // exactly 1s (the cut point)
			bNum: 90001, bDen: 90000, // one tick later, a different interval
			want:             -1,
			sameMilliseconds: true,
		},
		{
			name:             "large ticks would overflow int64 products",
			aNum:             9_000_000_000,
			aDen:             90_000,
			bNum:             4_800_000_000,
			bDen:             48_000,
			want:             0,
			sameMilliseconds: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cmpRational(tc.aNum, tc.aDen, tc.bNum, tc.bDen); got != tc.want {
				t.Fatalf("cmpRational = %d, want %d", got, tc.want)
			}
			if tc.sameMilliseconds && tc.want != 0 {
				// Demonstrate why millisecond conversion is unsafe: the two
				// instants share the same truncated millisecond value yet the
				// exact comparison must keep them ordered.
				msA := tc.aNum * 1000 / tc.aDen
				msB := tc.bNum * 1000 / tc.bDen
				if msA != msB {
					t.Fatalf("test premise broken: ms values differ (%d vs %d)", msA, msB)
				}
			}
		})
	}
}
