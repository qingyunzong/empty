package brackdiag

import "testing"

func TestScanBasics(t *testing.T) {
	cases := []struct {
		name      string
		text      string
		pairs     []Pair
		unmatched []Unmatched
		errOff    int
	}{
		{"empty", "", nil, nil, -1},
		{"simple", "()", []Pair{{0, 1}}, nil, -1},
		{"nested", "{[()]}", []Pair{{2, 3}, {1, 4}, {0, 5}}, nil, -1},
		{"in string", `"(["`, nil, nil, -1},
		{"in char", `'('`, nil, nil, -1},
		{"in line comment", "a // ( [\nx()", []Pair{{10, 11}}, nil, -1},
		{"in block comment", "/* ( */ ()", []Pair{{8, 9}}, nil, -1},
		{"block comment multiline", "/* (\n) */ ()", []Pair{{10, 11}}, nil, -1},
		{"raw string", "`(\n)` ()", []Pair{{6, 7}}, nil, -1},
		{"escaped quote", `"\"" ()`, []Pair{{5, 6}}, nil, -1},
		{"unmatched close", ")", nil, []Unmatched{{0, ')'}}, 0},
		{"unmatched open", "(", nil, []Unmatched{{0, '('}}, 0},
		{"mismatch", "(]", nil, []Unmatched{{0, '('}, {1, ']'}}, 1},
		{"close before open", ")(", nil, []Unmatched{{0, ')'}, {1, '('}}, 0},
		{"string after comment", "// \" \n\"(\"", nil, nil, -1},
		{"unterminated string", `"(`, nil, nil, -1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := Scan(c.text)
			if !pairsEqual(d.Pairs, c.pairs) {
				t.Errorf("pairs: got %v want %v", d.Pairs, c.pairs)
			}
			if !unmatchedEqual(d.Unmatched, c.unmatched) {
				t.Errorf("unmatched: got %v want %v", d.Unmatched, c.unmatched)
			}
			if d.ErrOff != c.errOff {
				t.Errorf("errOff: got %d want %d", d.ErrOff, c.errOff)
			}
		})
	}
}

func pairsEqual(a, b []Pair) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func unmatchedEqual(a, b []Unmatched) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
