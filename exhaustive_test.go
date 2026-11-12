package dataeng

import "testing"

func TestAllShortVectors(t *testing.T) {
	params := []struct{ b, s int }{
		{1, 1},
		{1, 3},
		{2, 1},
		{3, 1},
		{3, 2},
		{4, 3},
		{5, 2},
		{7, 4},
		{8, 7},
		{9, 4096},
	}
	for _, p := range params {
		for n := 0; n <= 10; n++ {
			allBitVectors(n, func(bits []byte) {
				checkAgainstReference(t, bits, p.b, p.s)
			})
		}
	}
}

func TestLongerPatterns(t *testing.T) {
	patterns := [][]byte{
		makePattern(300, func(i int) byte { return 0 }),
		makePattern(300, func(i int) byte { return 1 }),
		makePattern(301, func(i int) byte { return byte(i & 1) }),
		makePattern(257, func(i int) byte {
			if i < 90 || i >= 210 {
				return 0
			}
			return 1
		}),
		makePattern(333, func(i int) byte {
			if i >= 120 && i < 240 {
				return 1
			}
			return 0
		}),
	}
	params := []struct{ b, s int }{
		{1, 1},
		{1, 4096},
		{5, 3},
		{13, 7},
		{32, 16},
		{63, 1},
		{63, 2},
		{63, 63},
		{63, 4096},
	}
	for _, bits := range patterns {
		for _, p := range params {
			checkAgainstReference(t, bits, p.b, p.s)
		}
	}
}

func makePattern(n int, f func(int) byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = f(i)
	}
	return out
}
