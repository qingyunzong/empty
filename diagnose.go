package rulelib

// Diagnosis reports whether a rule can ever fire after higher-priority
// rules shadow it. Reachable rules carry a shortest witness path;
// unreachable rules carry a complete empty-language certificate.
type Diagnosis struct {
	Rule        string
	Reachable   bool
	Witness     []string // shortest path this rule still decides, when reachable
	Certificate []string // full reachable graph with no accept, when unreachable
}

// Diagnose checks every rule for true unreachability caused by priority
// shadowing. For each rule it computes L(rule) minus the union of the
// languages of all strictly-more-specific rules. Rules tied in
// specificity do not shadow each other (they are rejected at match time).
func Diagnose(rules []Rule) ([]Diagnosis, error) {
	sorted := sortRules(rules)
	alpha, err := newAlphabet(sorted)
	if err != nil {
		return nil, err
	}
	langs := make([]*dfa, len(sorted))
	for i, r := range sorted {
		langs[i] = ruleLanguage(r, alpha)
	}
	out := make([]Diagnosis, len(sorted))
	var shadow *dfa // union of languages of strictly higher-specificity rules
	for i, r := range sorted {
		if shadow != nil {
			diff := combine(langs[i], shadow, andNot)
			res := checkEmpty(diff)
			out[i] = Diagnosis{
				Rule:        r.Name,
				Reachable:   !res.Empty,
				Witness:     res.Witness,
				Certificate: res.Certificate,
			}
		} else {
			// Highest-specificity group: only its own language matters.
			res := checkEmpty(langs[i])
			out[i] = Diagnosis{
				Rule:        r.Name,
				Reachable:   !res.Empty,
				Witness:     res.Witness,
				Certificate: res.Certificate,
			}
		}
		// Accumulate the shadow once per specificity group so that tied
		// rules never shadow each other.
		lastOfGroup := i == len(sorted)-1 ||
			sorted[i].specificity().compare(sorted[i+1].specificity()) != 0
		if lastOfGroup {
			j := i
			for j >= 0 && sorted[j].specificity().compare(sorted[i].specificity()) == 0 {
				if shadow == nil {
					shadow = langs[j]
				} else {
					shadow = combine(shadow, langs[j], or)
				}
				j--
			}
		}
	}
	return out, nil
}
