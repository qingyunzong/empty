package pieceaffine

import "testing"

func TestFloorDiv(t *testing.T) {
	cases := []struct {
		a, b, want int64
	}{
		{7, 2, 3}, {-7, 2, -4}, {7, -2, -4}, {-7, -2, 3},
		{6, 3, 2}, {-6, 3, -2}, {0, 5, 0}, {-1, 2, -1},
		{1, -2, -1}, {-9, -3, 3},
	}
	for _, c := range cases {
		if got := floorDiv(c.a, c.b); got != c.want {
			t.Errorf("floorDiv(%d, %d) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestCeilDiv(t *testing.T) {
	cases := []struct {
		a, b, want int64
	}{
		{7, 2, 4}, {-7, 2, -3}, {7, -2, -3}, {-7, -2, 4},
		{6, 3, 2}, {-6, 3, -2}, {0, 5, 0}, {1, 2, 1},
	}
	for _, c := range cases {
		if got := ceilDiv(c.a, c.b); got != c.want {
			t.Errorf("ceilDiv(%d, %d) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}
