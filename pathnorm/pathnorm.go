// Package pathnorm normalizes path segments using caller-supplied Unicode
// folding rules and case rules. Normalization is fully determined by the
// input mapping and never by platform- or locale-specific behavior.
package pathnorm

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// CaseRule selects how letter case is treated after folding rules apply.
type CaseRule int

const (
	// CasePreserve leaves case untouched.
	CasePreserve CaseRule = iota
	// CaseLower applies Unicode simple lowercasing (strings.ToLower).
	CaseLower
	// CaseUpper applies Unicode simple uppercasing (strings.ToUpper).
	CaseUpper
)

// Rule maps the exact substring From to To. Rules are consulted in slice
// order; at each input position the first matching rule wins.
type Rule struct {
	From string
	To   string
}

// Mapping is the complete, platform-independent normalization specification:
// an ordered list of folding rules plus a case rule.
type Mapping struct {
	Rules []Rule
	Case  CaseRule
}

// Normalizer applies a Mapping. Construct it with NewNormalizer.
type Normalizer struct {
	caseRule CaseRule
	// byFirst groups rule indexes by the first rune of From, preserving
	// rule order within each group. Semantics are identical to scanning
	// Mapping.Rules linearly; this is only a lookup accelerator.
	byFirst map[rune][]int
	rules   []Rule
}

// NewNormalizer validates m and returns a Normalizer ready for use.
func NewNormalizer(m Mapping) (*Normalizer, error) {
	n := &Normalizer{
		caseRule: m.Case,
		byFirst:  make(map[rune][]int),
	}
	seen := make(map[string]struct{}, len(m.Rules))
	for i, r := range m.Rules {
		if r.From == "" {
			return nil, fmt.Errorf("pathnorm: rule %d has empty From", i)
		}
		if !utf8.ValidString(r.From) || !utf8.ValidString(r.To) {
			return nil, fmt.Errorf("pathnorm: rule %d is not valid UTF-8", i)
		}
		if _, dup := seen[r.From]; dup {
			return nil, fmt.Errorf("pathnorm: duplicate rule for %q", r.From)
		}
		seen[r.From] = struct{}{}
		n.rules = append(n.rules, r)
		first, _ := utf8.DecodeRuneInString(r.From)
		n.byFirst[first] = append(n.byFirst[first], i)
	}
	return n, nil
}

// Fold applies the folding rules and case rule to s. It contains no path
// validation; use NormalizePath for full path handling.
func (n *Normalizer) Fold(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		first, size := utf8.DecodeRuneInString(s[i:])
		matched := false
		for _, ri := range n.byFirst[first] {
			r := n.rules[ri]
			if strings.HasPrefix(s[i:], r.From) {
				b.WriteString(r.To)
				i += len(r.From)
				matched = true
				break
			}
		}
		if !matched {
			b.WriteString(s[i : i+size])
			i += size
		}
	}
	out := b.String()
	switch n.caseRule {
	case CaseLower:
		out = strings.ToLower(out)
	case CaseUpper:
		out = strings.ToUpper(out)
	}
	return out
}

// SegmentError reports a rejected path segment.
type SegmentError struct {
	Path    string // original path as supplied
	Segment string // offending segment ("" for empty segments)
	Kind    SegmentKind
}

type SegmentKind int

const (
	SegmentEmpty SegmentKind = iota
	SegmentUpward
)

func (e *SegmentError) Error() string {
	if e.Kind == SegmentUpward {
		return fmt.Sprintf("pathnorm: path %q contains upward segment %q", e.Path, e.Segment)
	}
	return fmt.Sprintf("pathnorm: path %q contains an empty segment", e.Path)
}

// NormalizePath validates and normalizes a "/" separated path. Empty
// segments and upward ("..") segments are rejected. Each remaining segment
// is folded independently; separators are preserved.
func (n *Normalizer) NormalizePath(p string) (string, error) {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		if s == "" {
			return "", &SegmentError{Path: p, Segment: s, Kind: SegmentEmpty}
		}
		if s == ".." {
			return "", &SegmentError{Path: p, Segment: s, Kind: SegmentUpward}
		}
		segs[i] = n.Fold(s)
	}
	return strings.Join(segs, "/"), nil
}

// Evidence records one original path and its normalized form, providing
// provenance from every normalized name back to its original.
type Evidence struct {
	Original   string
	Normalized string
}

// CollisionError reports that distinct original paths normalized to the
// same name. The whole batch is rejected when this occurs.
type CollisionError struct {
	// Groups maps each colliding normalized name to the distinct original
	// paths that produced it.
	Groups map[string][]string
}

func (e *CollisionError) Error() string {
	var b strings.Builder
	b.WriteString("pathnorm: batch rejected, normalized-name collisions:")
	for norm, originals := range e.Groups {
		fmt.Fprintf(&b, " %q <= %q", norm, originals)
	}
	return b.String()
}

// NormalizeBatch normalizes every path and returns one Evidence per input,
// in input order. If any path is invalid, or if two distinct original paths
// collide on the same normalized name, the entire batch is rejected and a
// nil slice is returned alongside the error. Repeats of the identical
// original path are not collisions.
func (n *Normalizer) NormalizeBatch(paths []string) ([]Evidence, error) {
	out := make([]Evidence, len(paths))
	owners := make(map[string]string, len(paths)) // normalized -> first original
	collisions := make(map[string][]string)
	for i, p := range paths {
		norm, err := n.NormalizePath(p)
		if err != nil {
			return nil, err
		}
		out[i] = Evidence{Original: p, Normalized: norm}
		if first, ok := owners[norm]; ok {
			if first != p {
				if _, reported := collisions[norm]; !reported {
					collisions[norm] = []string{first, p}
				} else {
					collisions[norm] = append(collisions[norm], p)
				}
			}
		} else {
			owners[norm] = p
		}
	}
	if len(collisions) > 0 {
		return nil, &CollisionError{Groups: collisions}
	}
	return out, nil
}
