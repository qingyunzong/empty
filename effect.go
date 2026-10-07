package effectcheck

import "sort"

// Effect is a single read or write of an abstract memory region, recorded
// together with the source path of the statement that caused it.
type Effect struct {
	Region string
	Path   string
}

// Throw is a raised exception recorded with its source path.
type Throw struct {
	Exc  string
	Path string
}

// Summary is the inferred effect set of one function.
type Summary struct {
	Reads   map[Effect]struct{}
	Writes  map[Effect]struct{}
	Throws  map[Throw]struct{}
	Returns map[string]struct{} // regions referenced by return statements
}

// NewSummary returns an empty effect summary.
func NewSummary() *Summary {
	return &Summary{
		Reads:   make(map[Effect]struct{}),
		Writes:  make(map[Effect]struct{}),
		Throws:  make(map[Throw]struct{}),
		Returns: make(map[string]struct{}),
	}
}

func (s *Summary) equal(o *Summary) bool {
	return effectsEqual(s.Reads, o.Reads) &&
		effectsEqual(s.Writes, o.Writes) &&
		throwsEqual(s.Throws, o.Throws) &&
		stringsEqual(s.Returns, o.Returns)
}

func effectsEqual(a, b map[Effect]struct{}) bool {
	if len(a) != len(b) {
		return false
	}
	for e := range a {
		if _, ok := b[e]; !ok {
			return false
		}
	}
	return true
}

func throwsEqual(a, b map[Throw]struct{}) bool {
	if len(a) != len(b) {
		return false
	}
	for t := range a {
		if _, ok := b[t]; !ok {
			return false
		}
	}
	return true
}

func stringsEqual(a, b map[string]struct{}) bool {
	if len(a) != len(b) {
		return false
	}
	for s := range a {
		if _, ok := b[s]; !ok {
			return false
		}
	}
	return true
}

// SortedEffects returns the effects in a deterministic order.
func SortedEffects(m map[Effect]struct{}) []Effect {
	out := make([]Effect, 0, len(m))
	for e := range m {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Region != out[j].Region {
			return out[i].Region < out[j].Region
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// SortedThrows returns the throws in a deterministic order.
func SortedThrows(m map[Throw]struct{}) []Throw {
	out := make([]Throw, 0, len(m))
	for t := range m {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Exc != out[j].Exc {
			return out[i].Exc < out[j].Exc
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// SortedStrings returns the set members in a deterministic order.
func SortedStrings(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for s := range m {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}
