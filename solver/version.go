package solver

import (
	"fmt"
	"strconv"
	"strings"
)

// Version is a dotted-numeric version like "1.2.3".
type Version struct {
	Parts []int
	Raw   string
}

func ParseVersion(s string) (Version, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return Version{}, fmt.Errorf("empty version")
	}
	segs := strings.Split(s, ".")
	parts := make([]int, len(segs))
	for i, seg := range segs {
		n, err := strconv.Atoi(seg)
		if err != nil || n < 0 {
			return Version{}, fmt.Errorf("invalid version %q", s)
		}
		parts[i] = n
	}
	return Version{Parts: parts, Raw: s}, nil
}

// CompareVersion returns -1, 0 or 1. Missing segments count as 0.
func CompareVersion(a, b Version) int {
	n := len(a.Parts)
	if len(b.Parts) > n {
		n = len(b.Parts)
	}
	for i := 0; i < n; i++ {
		x, y := 0, 0
		if i < len(a.Parts) {
			x = a.Parts[i]
		}
		if i < len(b.Parts) {
			y = b.Parts[i]
		}
		if x < y {
			return -1
		}
		if x > y {
			return 1
		}
	}
	return 0
}

type comparator struct {
	op string
	v  Version
}

// Range is a conjunction of comparators, e.g. ">=1.0.0 <2.0.0".
// Empty or "*" matches everything.
type Range struct {
	raw  string
	cmps []comparator
}

func ParseRange(s string) (Range, error) {
	r := Range{raw: s}
	s = strings.ReplaceAll(s, ",", " ")
	for _, tok := range strings.Fields(s) {
		if tok == "*" {
			continue
		}
		op := ""
		for _, o := range []string{">=", "<=", "!=", ">", "<", "="} {
			if strings.HasPrefix(tok, o) {
				op = o
				tok = strings.TrimPrefix(tok, o)
				break
			}
		}
		v, err := ParseVersion(tok)
		if err != nil {
			return Range{}, fmt.Errorf("invalid range %q: %v", r.raw, err)
		}
		if op == "" {
			op = "="
		}
		r.cmps = append(r.cmps, comparator{op: op, v: v})
	}
	return r, nil
}

func (r Range) Matches(v Version) bool {
	for _, c := range r.cmps {
		d := CompareVersion(v, c.v)
		switch c.op {
		case "=":
			if d != 0 {
				return false
			}
		case "!=":
			if d == 0 {
				return false
			}
		case ">":
			if d <= 0 {
				return false
			}
		case ">=":
			if d < 0 {
				return false
			}
		case "<":
			if d >= 0 {
				return false
			}
		case "<=":
			if d > 0 {
				return false
			}
		}
	}
	return true
}
