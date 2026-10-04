// Package pathnorm normalizes slash-separated paths using a caller-supplied
// Unicode folding map and an explicit case rule. Normalization is fully
// deterministic and never depends on platform-local behavior (no OS case
// sensitivity, no locale, no filesystem quirks).
package pathnorm

import (
	"strings"
	"unicode"
)

// FoldingMap maps a single rune to its folded replacement. A rune absent
// from the map is kept as-is. Replacements may be any string, including
// empty (which deletes the rune) and multi-rune expansions.
type FoldingMap map[rune]string

// CaseRule selects the case transform applied before folding.
type CaseRule int

const (
	// CasePreserve leaves runes untouched.
	CasePreserve CaseRule = iota
	// CaseLower applies Unicode simple lowercase mapping to every rune.
	CaseLower
	// CaseUpper applies Unicode simple uppercase mapping to every rune.
	CaseUpper
)

// applyCase maps one rune under the given case rule using Unicode simple
// case mapping (unicode.ToLower / unicode.ToUpper), which is a fixed
// per-rune table and does not depend on locale or platform.
func applyCase(rule CaseRule, r rune) rune {
	switch rule {
	case CaseLower:
		return unicode.ToLower(r)
	case CaseUpper:
		return unicode.ToUpper(r)
	default:
		return r
	}
}

// Interpret is the mapping interpreter: the reference implementation of the
// normalization pipeline. It applies the case rule rune by rune, then
// substitutes each resulting rune through the folding map. It is
// deliberately simple and obviously correct; Normalizer cross-checks its
// own output against this interpreter.
func Interpret(folding FoldingMap, rule CaseRule, s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		r = applyCase(rule, r)
		if repl, ok := folding[r]; ok {
			b.WriteString(repl)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}
