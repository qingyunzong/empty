package pathnorm

import "testing"

func TestInterpretCaseRules(t *testing.T) {
	cases := []struct {
		name string
		rule CaseRule
		in   string
		want string
	}{
		{"preserve", CasePreserve, "AbCΣςİ", "AbCΣςİ"},
		{"lower ascii", CaseLower, "AbC", "abc"},
		{"lower greek", CaseLower, "Σ", "σ"},
		{"lower turkish dotted I", CaseLower, "İ", "i"},
		{"upper ascii", CaseUpper, "AbC", "ABC"},
		{"upper sigma forms", CaseUpper, "σς", "ΣΣ"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Interpret(nil, tc.rule, tc.in); got != tc.want {
				t.Fatalf("Interpret(nil, %v, %q) = %q, want %q", tc.rule, tc.in, got, tc.want)
			}
		})
	}
}

func TestInterpretFoldingMap(t *testing.T) {
	folding := FoldingMap{
		'Ａ': "a",  // fullwidth Latin A
		'é': "e",  // accented e
		'ß': "ss", // sharp s expands
		'·': "",   // middle dot is deleted
		'-': "_",  // ascii rewrite
	}
	cases := []struct {
		in   string
		want string
	}{
		{"Ａbc", "abc"},
		{"café", "cafe"},
		{"straße", "strasse"},
		{"a·b", "ab"},
		{"a-b", "a_b"},
		{"plain", "plain"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := Interpret(folding, CasePreserve, tc.in); got != tc.want {
			t.Errorf("Interpret(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestInterpretCaseBeforeFolding(t *testing.T) {
	// Case rule applies first, then folding: 'Ｋ' lowercases to 'ｋ'
	// (fullwidth k), which the map then folds to "k".
	folding := FoldingMap{'ｋ': "k"}
	if got := Interpret(folding, CaseLower, "Ｋ"); got != "k" {
		t.Fatalf("Interpret = %q, want %q", got, "k")
	}
	// With CasePreserve the map key 'ｋ' never appears.
	if got := Interpret(folding, CasePreserve, "Ｋ"); got != "Ｋ" {
		t.Fatalf("Interpret = %q, want %q", got, "Ｋ")
	}
}

func TestInterpretDeterministicAcrossCalls(t *testing.T) {
	folding := FoldingMap{'a': "x", 'b': "y", 'c': "z", 'é': "e"}
	const in = "abcéabcé"
	first := Interpret(folding, CaseLower, in)
	for i := 0; i < 100; i++ {
		if got := Interpret(folding, CaseLower, in); got != first {
			t.Fatalf("call %d: got %q, want stable %q", i, got, first)
		}
	}
}
