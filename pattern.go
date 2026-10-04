package rulelib

import (
	"fmt"
	"strings"
)

// segKind classifies a single glob path segment.
type segKind int

const (
	segLiteral segKind = iota // exact literal segment
	segStar                   // "*": exactly one arbitrary segment
	segDStar                  // "**": zero or more arbitrary segments
)

// segment is one compiled glob segment.
type segment struct {
	kind segKind
	lit  string // set when kind == segLiteral
}

// Pattern is a compiled path glob.
type Pattern struct {
	Raw  string
	segs []segment
}

// ParsePattern compiles a glob like "src/**" into a Pattern.
// "*" matches exactly one segment, "**" matches zero or more segments,
// anything else is a literal segment.
func ParsePattern(glob string) (Pattern, error) {
	raw := strings.TrimSpace(glob)
	if raw == "" {
		return Pattern{}, fmt.Errorf("rulelib: empty glob")
	}
	parts := strings.Split(raw, "/")
	segs := make([]segment, 0, len(parts))
	for _, part := range parts {
		switch part {
		case "":
			return Pattern{}, fmt.Errorf("rulelib: empty segment in glob %q", glob)
		case "*":
			segs = append(segs, segment{kind: segStar})
		case "**":
			segs = append(segs, segment{kind: segDStar})
		default:
			if strings.Contains(part, "*") {
				return Pattern{}, fmt.Errorf("rulelib: %q must be a whole segment in glob %q", part, glob)
			}
			segs = append(segs, segment{kind: segLiteral, lit: part})
		}
	}
	return Pattern{Raw: raw, segs: segs}, nil
}

// specificity orders rules: more literal segments first, then more total
// segments. Higher is more specific.
type specificity struct {
	literals int
	total    int
}

func (p Pattern) specificity() specificity {
	s := specificity{total: len(p.segs)}
	for _, seg := range p.segs {
		if seg.kind == segLiteral {
			s.literals++
		}
	}
	return s
}

// compare returns +1 if s is more specific, -1 if less, 0 on a tie.
func (s specificity) compare(o specificity) int {
	switch {
	case s.literals != o.literals:
		if s.literals > o.literals {
			return 1
		}
		return -1
	case s.total != o.total:
		if s.total > o.total {
			return 1
		}
		return -1
	}
	return 0
}

// Match reports whether the glob matches the given path segments.
func (p Pattern) Match(path []string) bool {
	return matchSegs(p.segs, path)
}

func matchSegs(pat []segment, path []string) bool {
	if len(pat) == 0 {
		return len(path) == 0
	}
	switch pat[0].kind {
	case segDStar:
		// "**" crosses zero or more segments.
		for i := 0; i <= len(path); i++ {
			if matchSegs(pat[1:], path[i:]) {
				return true
			}
		}
		return false
	case segStar:
		if len(path) == 0 {
			return false
		}
		return matchSegs(pat[1:], path[1:])
	default:
		if len(path) == 0 || path[0] != pat[0].lit {
			return false
		}
		return matchSegs(pat[1:], path[1:])
	}
}

// splitPath normalizes a path into segments, dropping empty parts.
func splitPath(path string) []string {
	parts := strings.Split(path, "/")
	segs := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			segs = append(segs, part)
		}
	}
	return segs
}
