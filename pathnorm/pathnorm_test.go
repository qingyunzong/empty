package pathnorm

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

// interpret is an independent, deliberately naive mapping interpreter used
// to cross-check Normalizer.Fold: at every input position it scans the
// rules linearly, applies the first rule whose From matches, and otherwise
// copies a single rune. Case rules are applied afterwards.
func interpret(m Mapping, s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		matched := false
		for _, r := range m.Rules {
			if strings.HasPrefix(s[i:], r.From) {
				b.WriteString(r.To)
				i += len(r.From)
				matched = true
				break
			}
		}
		if !matched {
			_, size := utf8.DecodeRuneInString(s[i:])
			b.WriteString(s[i : i+size])
			i += size
		}
	}
	out := b.String()
	switch m.Case {
	case CaseLower:
		out = strings.ToLower(out)
	case CaseUpper:
		out = strings.ToUpper(out)
	}
	return out
}

func testMapping() Mapping {
	return Mapping{
		Rules: []Rule{
			{From: "ß", To: "ss"},
			{From: "ﬀ", To: "ff"}, // U+FB00 LATIN SMALL LIGATURE FF
			{From: "Ω", To: "ω"},  // Greek capital omega -> small omega
			{From: "ａ", To: "a"},  // fullwidth a
			{From: "１", To: "1"},  // fullwidth digit one
			{From: "ab", To: "x"}, // multi-char rule, ordered before...
			{From: "a", To: "a"},  // ...the single-char rule
		},
		Case: CaseLower,
	}
}

func mustNormalizer(t *testing.T, m Mapping) *Normalizer {
	t.Helper()
	n, err := NewNormalizer(m)
	if err != nil {
		t.Fatalf("NewNormalizer: %v", err)
	}
	return n
}

func TestFoldMatchesInterpreter(t *testing.T) {
	m := testMapping()
	n := mustNormalizer(t, m)
	inputs := []string{
		"Straße",
		"ﬀect",
		"ΩMEGA",
		"ａｂｃ１２３",
		"abABC",
		"cab", // "ab" rule must not match mid-string anchor incorrectly
		"aAbB",
		"MiXeD ß ﬀ Ω ａ １",
		"",
		"日本語",
		"ßßﬀﬀ",
	}
	for _, in := range inputs {
		got := n.Fold(in)
		want := interpret(m, in)
		if got != want {
			t.Errorf("Fold(%q) = %q, interpreter says %q", in, got, want)
		}
	}
}

func TestFoldCaseRules(t *testing.T) {
	cases := []struct {
		name string
		rule CaseRule
		in   string
		want string
	}{
		{"preserve", CasePreserve, "AbCß", "AbCß"},
		{"lower", CaseLower, "AbCΣ", "abcσ"},
		{"upper", CaseUpper, "AbCσ", "ABCΣ"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			n := mustNormalizer(t, Mapping{Case: tc.rule})
			if got := n.Fold(tc.in); got != tc.want {
				t.Errorf("Fold(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestNormalizePathValid(t *testing.T) {
	n := mustNormalizer(t, testMapping())
	got, err := n.NormalizePath("Straße/ﬀile/Ω１")
	if err != nil {
		t.Fatalf("NormalizePath: %v", err)
	}
	if want := "strasse/ffile/ω1"; got != want {
		t.Errorf("NormalizePath = %q, want %q", got, want)
	}
}

func TestNormalizePathRejectsBadSegments(t *testing.T) {
	n := mustNormalizer(t, testMapping())
	bad := []struct {
		path string
		kind SegmentKind
	}{
		{"", SegmentEmpty},
		{"/a", SegmentEmpty},
		{"a/", SegmentEmpty},
		{"a//b", SegmentEmpty},
		{"..", SegmentUpward},
		{"a/../b", SegmentUpward},
		{"../a", SegmentUpward},
	}
	for _, tc := range bad {
		_, err := n.NormalizePath(tc.path)
		var se *SegmentError
		if !errors.As(err, &se) {
			t.Errorf("NormalizePath(%q): got %v, want *SegmentError", tc.path, err)
			continue
		}
		if se.Kind != tc.kind {
			t.Errorf("NormalizePath(%q): kind = %v, want %v", tc.path, se.Kind, tc.kind)
		}
		if se.Path != tc.path {
			t.Errorf("NormalizePath(%q): evidence path = %q", tc.path, se.Path)
		}
	}
}

func TestNormalizeBatchEvidence(t *testing.T) {
	n := mustNormalizer(t, testMapping())
	ev, err := n.NormalizeBatch([]string{"Straße/a", "ﬀ/b", "Ω１"})
	if err != nil {
		t.Fatalf("NormalizeBatch: %v", err)
	}
	want := []Evidence{
		{Original: "Straße/a", Normalized: "strasse/a"},
		{Original: "ﬀ/b", Normalized: "ff/b"},
		{Original: "Ω１", Normalized: "ω1"},
	}
	if !reflect.DeepEqual(ev, want) {
		t.Errorf("evidence = %+v, want %+v", ev, want)
	}
}

func TestNormalizeBatchCollisionRejectsAll(t *testing.T) {
	n := mustNormalizer(t, testMapping())
	// "ß" folds to "ss" and case-lowering maps "SS" -> "ss": three
	// distinct originals collide on "ss". "ok" is unique but the whole
	// batch must still be rejected.
	_, err := n.NormalizeBatch([]string{"ok", "ß", "SS", "ss"})
	var ce *CollisionError
	if !errors.As(err, &ce) {
		t.Fatalf("got %v, want *CollisionError", err)
	}
	got := ce.Groups["ss"]
	want := []string{"ß", "SS", "ss"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("collision originals = %q, want %q", got, want)
	}
}

func TestNormalizeBatchIdenticalRepeatsAreNotCollisions(t *testing.T) {
	n := mustNormalizer(t, testMapping())
	ev, err := n.NormalizeBatch([]string{"a", "a", "b"})
	if err != nil {
		t.Fatalf("NormalizeBatch: %v", err)
	}
	if len(ev) != 3 {
		t.Fatalf("got %d evidence entries, want 3", len(ev))
	}
}

func TestNormalizeBatchInvalidPathRejectsAll(t *testing.T) {
	n := mustNormalizer(t, testMapping())
	_, err := n.NormalizeBatch([]string{"good", "a/../b"})
	var se *SegmentError
	if !errors.As(err, &se) {
		t.Fatalf("got %v, want *SegmentError", err)
	}
}

func TestNewNormalizerRejectsBadMapping(t *testing.T) {
	for name, m := range map[string]Mapping{
		"empty From":  {Rules: []Rule{{From: "", To: "x"}}},
		"duplicate":   {Rules: []Rule{{From: "a", To: "x"}, {From: "a", To: "y"}}},
		"invalid UTF": {Rules: []Rule{{From: "\xff", To: "x"}}},
	} {
		if _, err := NewNormalizer(m); err == nil {
			t.Errorf("%s: expected error, got nil", name)
		}
	}
}

func TestRuleOrderFirstMatchWins(t *testing.T) {
	m := Mapping{Rules: []Rule{{From: "ab", To: "x"}, {From: "a", To: "y"}}}
	n := mustNormalizer(t, m)
	if got := n.Fold("ab"); got != "x" {
		t.Errorf("Fold(ab) = %q, want x", got)
	}
	if got := n.Fold("a"); got != "y" {
		t.Errorf("Fold(a) = %q, want y", got)
	}
	if got := n.Fold("cab"); got != "cx" { // interpreter agrees
		t.Errorf("Fold(cab) = %q, want cx", got)
	}
}
