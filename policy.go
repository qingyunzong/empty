package licchk

// Policy describes license compatibility constraints.
type Policy struct {
	// Forbidden lists licenses that may not appear in any chosen option.
	Forbidden []string
	// Incompatible lists unordered pairs of licenses that may not
	// co-occur, neither within a single package's chosen option nor
	// across the chosen options of two different packages.
	Incompatible [][2]string
}

func (p Policy) forbiddenSet() map[string]struct{} {
	set := make(map[string]struct{}, len(p.Forbidden))
	for _, f := range p.Forbidden {
		set[f] = struct{}{}
	}
	return set
}

// pairKey canonicalizes an unordered license pair.
func pairKey(a, b string) [2]string {
	if a > b {
		a, b = b, a
	}
	return [2]string{a, b}
}

func (p Policy) incompatibleSet() map[[2]string]struct{} {
	set := make(map[[2]string]struct{}, len(p.Incompatible))
	for _, pair := range p.Incompatible {
		set[pairKey(pair[0], pair[1])] = struct{}{}
	}
	return set
}

// optionSelfViolates reports whether a single option violates the policy on
// its own: it contains a forbidden license or an incompatible pair.
func optionSelfViolates(o Option, forbidden map[string]struct{}, incompat map[[2]string]struct{}) bool {
	for _, lic := range o {
		if _, ok := forbidden[lic]; ok {
			return true
		}
	}
	for i := 0; i < len(o); i++ {
		for j := i + 1; j < len(o); j++ {
			if _, ok := incompat[pairKey(o[i], o[j])]; ok {
				return true
			}
		}
	}
	return false
}

// optionsConflict reports whether two chosen options (from different
// packages) share an incompatible license pair.
func optionsConflict(a, b Option, incompat map[[2]string]struct{}) bool {
	for _, x := range a {
		for _, y := range b {
			if x == y {
				continue
			}
			if _, ok := incompat[pairKey(x, y)]; ok {
				return true
			}
		}
	}
	return false
}
