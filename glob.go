package rulecheck

import (
	"fmt"
	"strings"
)

// segKind classifies a single pattern segment.
type segKind int

const (
	segLiteral  segKind = iota // exact path segment
	segStar                    // "*": exactly one arbitrary segment
	segGlobstar                // "**": zero or more arbitrary segments
)

type segment struct {
	kind segKind
	lit  string
}

// glob is a parsed path pattern.
type glob struct {
	raw  string
	segs []segment
}

// parseGlob parses a "/" separated pattern. Supported segments are literals,
// "*" (one segment) and "**" (zero or more segments). Partial wildcards such
// as "ab*" and empty segments are rejected.
func parseGlob(pat string) (glob, error) {
	if pat == "" {
		return glob{}, fmt.Errorf("empty pattern")
	}
	g := glob{raw: pat}
	for _, p := range strings.Split(pat, "/") {
		switch p {
		case "":
			return glob{}, fmt.Errorf("pattern %q: empty segment", pat)
		case "*":
			g.segs = append(g.segs, segment{kind: segStar})
		case "**":
			g.segs = append(g.segs, segment{kind: segGlobstar})
		default:
			if strings.Contains(p, "*") {
				return glob{}, fmt.Errorf("pattern %q: partial wildcard %q is not supported", pat, p)
			}
			g.segs = append(g.segs, segment{kind: segLiteral, lit: p})
		}
	}
	return g, nil
}

// specificity ranks patterns: number of literal segments first, then total
// segment count. Higher means more specific.
type specificity struct {
	literals int
	total    int
}

func (g glob) specificity() specificity {
	s := specificity{total: len(g.segs)}
	for _, seg := range g.segs {
		if seg.kind == segLiteral {
			s.literals++
		}
	}
	return s
}

// higher reports whether s is strictly more specific than o.
func (s specificity) higher(o specificity) bool {
	return s.literals > o.literals || (s.literals == o.literals && s.total > o.total)
}

// match reports whether the glob matches the given path segments. It is a
// plain recursive matcher with no caching and no automaton state; it serves
// as the independent reference implementation.
func (g glob) match(segs []string) bool {
	memo := make(map[[2]int]bool)
	var rec func(i, j int) bool
	rec = func(i, j int) bool {
		key := [2]int{i, j}
		if v, ok := memo[key]; ok {
			return v
		}
		var res bool
		switch {
		case i == len(g.segs):
			res = j == len(segs)
		default:
			switch g.segs[i].kind {
			case segLiteral:
				res = j < len(segs) && segs[j] == g.segs[i].lit && rec(i+1, j+1)
			case segStar:
				res = j < len(segs) && rec(i+1, j+1)
			case segGlobstar:
				// "**" consumes zero segments, or one segment and stays.
				res = rec(i+1, j) || (j < len(segs) && rec(i, j+1))
			}
		}
		memo[key] = res
		return res
	}
	return rec(0, 0)
}

// splitPath splits a concrete path into segments. The empty string is the
// empty (zero-segment) path. Empty segments are rejected.
func splitPath(p string) ([]string, error) {
	if p == "" {
		return nil, nil
	}
	segs := strings.Split(p, "/")
	for _, s := range segs {
		if s == "" {
			return nil, fmt.Errorf("path %q: empty segment", p)
		}
	}
	return segs, nil
}
