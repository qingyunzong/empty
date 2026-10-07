package solver

import (
	"fmt"
	"strconv"
	"strings"
)

// CompareVersions compares two dotted versions numerically, segment by
// segment. Non-numeric suffixes (e.g. "1.0-rc1") compare lexically and order
// before a bare numeric segment. Returns -1, 0 or 1.
func CompareVersions(a, b string) int {
	as := strings.Split(a, ".")
	bs := strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		var sa, sb string
		if i < len(as) {
			sa = as[i]
		}
		if i < len(bs) {
			sb = bs[i]
		}
		if sa == sb {
			continue
		}
		na, errA := strconv.Atoi(sa)
		nb, errB := strconv.Atoi(sb)
		switch {
		case errA == nil && errB == nil:
			if na != nb {
				if na < nb {
					return -1
				}
				return 1
			}
		case errA == nil:
			return 1 // numeric segment sorts after a pre-release tag
		case errB == nil:
			return -1
		default:
			if sa < sb {
				return -1
			}
			return 1
		}
	}
	return 0
}

type comparator struct {
	op  string
	ver string
}

// Range is a conjunction of comparators such as ">=1.2.0 <2.0.0".
type Range struct {
	raw   string
	comps []comparator
}

// ParseRange parses a version range. Comparators are separated by spaces
// and/or commas; supported operators are < <= > >= = == !=. A bare version
// means equality. "" or "*" matches anything.
func ParseRange(s string) (Range, error) {
	r := Range{raw: s}
	s = strings.TrimSpace(strings.ReplaceAll(s, ",", " "))
	if s == "" || s == "*" {
		return r, nil
	}
	for _, tok := range strings.Fields(s) {
		op := "="
		ver := tok
		for _, prefix := range []string{">=", "<=", "==", "!=", ">", "<", "="} {
			if strings.HasPrefix(tok, prefix) {
				op = prefix
				ver = strings.TrimPrefix(tok, prefix)
				break
			}
		}
		if ver == "" {
			return r, fmt.Errorf("invalid comparator %q in range %q", tok, s)
		}
		r.comps = append(r.comps, comparator{op: op, ver: ver})
	}
	return r, nil
}

// Satisfied reports whether version v matches every comparator.
func (r Range) Satisfied(v string) bool {
	for _, c := range r.comps {
		cmp := CompareVersions(v, c.ver)
		ok := false
		switch c.op {
		case "<":
			ok = cmp < 0
		case "<=":
			ok = cmp <= 0
		case ">":
			ok = cmp > 0
		case ">=":
			ok = cmp >= 0
		case "=", "==":
			ok = cmp == 0
		case "!=":
			ok = cmp != 0
		}
		if !ok {
			return false
		}
	}
	return true
}

func (r Range) String() string {
	if r.raw == "" {
		return "*"
	}
	return r.raw
}
