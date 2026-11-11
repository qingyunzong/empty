package q216

import (
	"encoding/json"
	"testing"
)

func TestCanonicalJSONRFC8785Vectors(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty object", `{}`, `{}`},
		{"empty array", `[]`, `[]`},
		{"scalars", `[true,false,null]`, `[true,false,null]`},
		{"reorder object", `{"b":2,"a":1}`, `{"a":1,"b":2}`},
		{"nested reorder",
			`{"z":{"y":2,"x":1},"a":[3,2,1]}`,
			`{"a":[3,2,1],"z":{"x":1,"y":2}}`},
		{"string escaping",
			`{"k\"\\":"\u0001\u001f"}`,
			`{"k\"\\":"\u0001\u001f"}`},
		{"integer number", `{"v":1e3}`, `{"v":1000}`},
		{"negative zero", `{"v":-0}`, `{"v":0}`},
		{"small decimal stays plain", `{"v":0.000001}`, `{"v":0.000001}`},
		{"tiny decimal goes scientific", `{"v":0.0000001}`, `{"v":1e-7}`},
		{"large integer stays plain", `{"v":100000000000000000000}`, `{"v":100000000000000000000}`},
		{"huge integer goes scientific", `{"v":1e21}`, `{"v":1e+21}`},
		{"negative scientific", `{"v":-2.5e21}`, `{"v":-2.5e+21}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tree, err := decodeJSONStrict([]byte(tc.in))
			if err != nil {
				t.Fatalf("decode %q: %v", tc.in, err)
			}
			got, err := canonicalJSON(tree)
			if err != nil {
				t.Fatalf("canonicalize %q: %v", tc.in, err)
			}
			if string(got) != tc.want {
				t.Fatalf("canonicalJSON(%s) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestCanonicalNumberBoundaries(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"0.00001", "0.00001"},                             // 1e-5 -> plain
		{"0.000001", "0.000001"},                           // 1e-6 -> plain (boundary)
		{"0.0000001", "1e-7"},                              // 1e-7 -> scientific
		{"100000000000000000000", "100000000000000000000"}, // 1e20 integer literal -> plain (boundary)
		{"1e21", "1e+21"},                                  // exponent literal at n=21 -> scientific
		{"123.456", "123.456"},
		{"-0.0000001", "-1e-7"},
		{"2.5e-7", "2.5e-7"},
		{"1.5e21", "1.5e+21"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, err := canonicalNumber(asNumber(t, tc.in))
			if err != nil {
				t.Fatalf("canonicalNumber(%s): %v", tc.in, err)
			}
			if got != tc.want {
				t.Fatalf("canonicalNumber(%s) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestUTF16KeyOrdering(t *testing.T) {
	// U+0061 ("a") and U+1F600 (outside BMP, encoded as surrogate pair
	// D83D DE00) must order by UTF-16 code units.
	tree, err := decodeJSONStrict([]byte(`{"😀":1,"a":2}`))
	if err != nil {
		t.Fatal(err)
	}
	got, err := canonicalJSON(tree)
	if err != nil {
		t.Fatal(err)
	}
	// 'a' = U+0061 sorts before the high surrogate U+D83D.
	if string(got) != `{"a":2,"😀":1}` {
		t.Fatalf("UTF-16 ordering = %s", got)
	}
}

func TestDuplicateKeyRejectedAtAnyDepth(t *testing.T) {
	cases := []string{
		`{"a":1,"a":2}`,
		`{"outer":{"a":1,"a":2}}`,
		`[{"a":1,"a":2}]`,
	}
	for _, in := range cases {
		if _, err := decodeJSONStrict([]byte(in)); err == nil {
			t.Fatalf("duplicate key accepted in %s", in)
		}
	}
}

func TestTrailingDataRejected(t *testing.T) {
	if _, err := decodeJSONStrict([]byte(`{"a":1} junk`)); err == nil {
		t.Fatal("trailing JSON data was accepted")
	}
}

func asNumber(t *testing.T, s string) json.Number {
	t.Helper()
	tree, err := decodeJSONStrict([]byte(s))
	if err != nil {
		t.Fatalf("decode number %s: %v", s, err)
	}
	n, ok := tree.(json.Number)
	if !ok {
		t.Fatalf("%s decoded as %T, not json.Number", s, tree)
	}
	return n
}
