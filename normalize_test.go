package pathnorm

import (
	"errors"
	"math/rand"
	"strings"
	"testing"
)

// testFolding folds a few non-ASCII and compatibility runes so tests can
// build distinct originals that collide after normalization.
var testFolding = FoldingMap{
	'Ａ': "a", // fullwidth Latin capital A
	'ａ': "a", // fullwidth Latin small a
	'é': "e",
	'ß': "ss",
	'·': "", // deleted
}

func TestNormalizePathFoldingAndCase(t *testing.T) {
	n := New(testFolding, CaseLower)
	cases := []struct {
		in   string
		want string
	}{
		{"a/b/c", "a/b/c"},
		{"A/B", "a/b"},
		{"Ａ/ａ", "a/a"}, // fullwidth forms fold onto ascii
		{"café/straße", "cafe/strasse"},
		{"a·b", "ab"},    // folding may delete a rune
		{"./ok", "./ok"}, // "." is neither empty nor upward
		{"MiXeD/Case", "mixed/case"},
	}
	for _, tc := range cases {
		got, err := n.NormalizePath(tc.in)
		if err != nil {
			t.Errorf("NormalizePath(%q) unexpected error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("NormalizePath(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestNormalizePathCasePreserveAndUpper(t *testing.T) {
	preserve := New(testFolding, CasePreserve)
	if got, err := preserve.NormalizePath("AbC/Ａ"); err != nil || got != "AbC/a" {
		t.Errorf("preserve: got %q, %v; want %q, nil", got, err, "AbC/a")
	}
	upper := New(testFolding, CaseUpper)
	// Case applies before folding: 'é' uppercases to 'É', which is not a
	// folding key, so it stays 'É'.
	if got, err := upper.NormalizePath("abc/déf"); err != nil || got != "ABC/DÉF" {
		t.Errorf("upper: got %q, %v; want %q, nil", got, err, "ABC/DÉF")
	}
}

func TestNormalizePathRejectsEmptySegments(t *testing.T) {
	n := New(nil, CasePreserve)
	for _, in := range []string{"", "/a", "a/", "a//b", "//", "a///b"} {
		_, err := n.NormalizePath(in)
		if !errors.Is(err, ErrEmptySegment) {
			t.Errorf("NormalizePath(%q): err = %v, want ErrEmptySegment", in, err)
			continue
		}
		var pe *PathError
		if !errors.As(err, &pe) {
			t.Fatalf("NormalizePath(%q): error %T is not *PathError", in, err)
		}
		if pe.Path != in {
			t.Errorf("NormalizePath(%q): PathError.Path = %q, want original preserved", in, pe.Path)
		}
	}
}

func TestNormalizePathRejectsUpwardSegments(t *testing.T) {
	n := New(nil, CasePreserve)
	for _, in := range []string{"..", "../a", "a/..", "a/../b", "a/../../b"} {
		_, err := n.NormalizePath(in)
		if !errors.Is(err, ErrUpwardSegment) {
			t.Errorf("NormalizePath(%q): err = %v, want ErrUpwardSegment", in, err)
		}
	}
	// Lookalikes that are not exactly ".." must be accepted.
	for _, in := range []string{"...", "a/..b", "..a/b", "a/."} {
		if _, err := n.NormalizePath(in); err != nil {
			t.Errorf("NormalizePath(%q): unexpected rejection: %v", in, err)
		}
	}
}

func TestNormalizeBatchCollisionRejectsWholeBatch(t *testing.T) {
	n := New(testFolding, CaseLower)
	// "Ａ" folds to "a" and "A" lowercases to "a": different originals,
	// same normalized name.
	res, err := n.NormalizeBatch([]string{"ok/path", "Ａ", "A", "trailing/entry"})
	if res != nil {
		t.Errorf("expected nil result on collision, got %+v", res)
	}
	var ce *CollisionError
	if !errors.As(err, &ce) {
		t.Fatalf("err = %v (%T), want *CollisionError", err, err)
	}
	if ce.Normalized != "a" || ce.First != "Ａ" || ce.Second != "A" {
		t.Errorf("collision evidence = %+v, want Normalized=%q First=%q Second=%q",
			ce, "a", "Ａ", "A")
	}
}

func TestNormalizeBatchCaseOnlyCollision(t *testing.T) {
	n := New(nil, CaseLower)
	_, err := n.NormalizeBatch([]string{"ReadMe", "readme"})
	var ce *CollisionError
	if !errors.As(err, &ce) {
		t.Fatalf("err = %v, want *CollisionError", err)
	}
	if ce.Normalized != "readme" {
		t.Errorf("ce.Normalized = %q, want %q", ce.Normalized, "readme")
	}
}

func TestNormalizeBatchExactDuplicateIsNotCollision(t *testing.T) {
	n := New(testFolding, CaseLower)
	res, err := n.NormalizeBatch([]string{"a/b", "a/b", "c"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.Records) != 3 {
		t.Errorf("len(Records) = %d, want 3 (input order and duplicates kept)", len(res.Records))
	}
	if len(res.Evidence) != 2 {
		t.Errorf("len(Evidence) = %d, want 2 distinct normalized names", len(res.Evidence))
	}
}

func TestNormalizeBatchEvidence(t *testing.T) {
	n := New(testFolding, CaseLower)
	inputs := []string{"Ａ/b", "Café", "x/y/z"}
	res, err := n.NormalizeBatch(inputs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Records preserve input order and pair original with normalized.
	wantNorm := []string{"a/b", "cafe", "x/y/z"}
	for i, rec := range res.Records {
		if rec.Original != inputs[i] || rec.Normalized != wantNorm[i] {
			t.Errorf("Records[%d] = %+v, want {%q %q}", i, rec, inputs[i], wantNorm[i])
		}
	}
	// Evidence maps every normalized name back to its original.
	for i, original := range inputs {
		if got := res.Evidence[wantNorm[i]]; got != original {
			t.Errorf("Evidence[%q] = %q, want %q", wantNorm[i], got, original)
		}
	}
}

func TestNormalizeBatchInvalidPathRejectsWholeBatch(t *testing.T) {
	n := New(nil, CasePreserve)
	res, err := n.NormalizeBatch([]string{"good", "a//b", "also-good"})
	if res != nil {
		t.Errorf("expected nil result, got %+v", res)
	}
	if !errors.Is(err, ErrEmptySegment) {
		t.Errorf("err = %v, want ErrEmptySegment", err)
	}
	res, err = n.NormalizeBatch([]string{"good", "a/../b"})
	if res != nil || !errors.Is(err, ErrUpwardSegment) {
		t.Errorf("got (%+v, %v), want (nil, ErrUpwardSegment)", res, err)
	}
}

// TestNormalizeAgainstInterpreter cross-checks NormalizePath against the
// mapping interpreter on generated inputs: every normalized segment must
// equal Interpret applied to the original segment, and joining the
// interpreted segments must equal NormalizePath's output.
func TestNormalizeAgainstInterpreter(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	runes := []rune("abABéßＡａ·.zZ09")
	for trial := 0; trial < 2000; trial++ {
		var rule CaseRule
		switch rng.Intn(3) {
		case 1:
			rule = CaseLower
		case 2:
			rule = CaseUpper
		}
		n := New(testFolding, rule)

		numSegs := 1 + rng.Intn(4)
		segs := make([]string, numSegs)
		for i := range segs {
			var b strings.Builder
			for j, ln := 0, 1+rng.Intn(6); j < ln; j++ {
				b.WriteRune(runes[rng.Intn(len(runes))])
			}
			seg := b.String()
			// Keep generated paths valid: no empty segments, no "..".
			if seg == "" || seg == ".." {
				seg = "x"
			}
			segs[i] = seg
		}
		path := strings.Join(segs, "/")

		got, err := n.NormalizePath(path)
		if err != nil {
			t.Fatalf("NormalizePath(%q) unexpected error: %v", path, err)
		}
		wantSegs := make([]string, numSegs)
		for i, seg := range segs {
			wantSegs[i] = Interpret(testFolding, rule, seg)
		}
		if want := strings.Join(wantSegs, "/"); got != want {
			t.Fatalf("NormalizePath(%q) = %q, interpreter says %q", path, got, want)
		}
	}
}

// TestNormalizeDeterministic verifies normalization does not depend on map
// iteration order or call history.
func TestNormalizeDeterministic(t *testing.T) {
	n := New(testFolding, CaseLower)
	const path = "Ａ/ａ/é/ß/·/plain"
	first, err := n.NormalizePath(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for i := 0; i < 100; i++ {
		got, err := n.NormalizePath(path)
		if err != nil || got != first {
			t.Fatalf("call %d: got (%q, %v), want stable (%q, nil)", i, got, err, first)
		}
	}
}
