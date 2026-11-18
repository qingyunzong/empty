package formal

import (
	"sort"
	"strconv"
	"strings"
)

// Labels is an immutable-by-convention set of alert labels.
//
// The zero value and a nil Labels both represent an empty label set.
type Labels map[string]string

// Clone returns an independent copy of l.
func (l Labels) Clone() Labels {
	if l == nil {
		return nil
	}
	cloned := make(Labels, len(l))
	for name, value := range l {
		cloned[name] = value
	}
	return cloned
}

// Get returns the value of name, or the empty string when the label is absent.
// Treating an absent label as empty matches the usual alerting matcher
// semantics and keeps group keys stable when a configured group-by label is
// missing.
func (l Labels) Get(name string) string {
	return l[name]
}

// String returns a canonical representation of the label set. Label names are
// sorted and both names and values are quoted, so distinct maps never share a
// string representation.
func (l Labels) String() string {
	if len(l) == 0 {
		return "{}"
	}

	names := make([]string, 0, len(l))
	for name := range l {
		names = append(names, name)
	}
	sort.Strings(names)

	var b strings.Builder
	b.WriteByte('{')
	for i, name := range names {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.Quote(name))
		b.WriteByte(':')
		b.WriteString(strconv.Quote(l[name]))
	}
	b.WriteByte('}')
	return b.String()
}

// Equal reports whether l and other contain the same labels.
func (l Labels) Equal(other Labels) bool {
	if len(l) != len(other) {
		return false
	}
	for name, value := range l {
		if other[name] != value {
			return false
		}
	}
	return true
}

func cloneLabels(l Labels) Labels {
	return l.Clone()
}
