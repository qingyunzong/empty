package rulecheck

// Diagnosis reports whether a rule can ever be selected, i.e. whether some
// path matches the rule and no higher-priority rule.
type Diagnosis struct {
	RuleID    string
	Reachable bool
	Witness   []string          // shortest path where this rule wins (if reachable)
	Cert      *EmptyCertificate // proof of unreachability (if not reachable)
}

// EmptyCertificate certifies that a rule's effective language, after
// subtracting all higher-priority rules, is empty. It is complete and
// independently checkable via Verify.
type EmptyCertificate struct {
	RuleID string
	// SelfEmpty is true when the rule's own Include minus its Excludes is
	// already the empty language (shadowing is not even needed).
	SelfEmpty bool
	// ShadowedBy lists the higher-priority rules whose union covers the
	// rule's effective language.
	ShadowedBy []string
	// Explored is the number of product-automaton states examined while
	// proving emptiness (proof size).
	Explored int
}

// Diagnose analyses every rule in priority order and reports, for each one,
// either a shortest witness path on which it is the selected rule, or a
// certificate that it can never be selected.
func (l *Library) Diagnose() []Diagnosis {
	out := make([]Diagnosis, 0, len(l.rules))
	for i := range l.rules {
		r := &l.rules[i]
		var higher []*compiledRule
		for j := range l.rules {
			if l.rules[j].spec.higher(r.spec) {
				higher = append(higher, &l.rules[j])
			}
		}
		d := Diagnosis{RuleID: r.rule.ID}

		_, selfNonEmpty := r.eff.shortestWord()
		if !selfNonEmpty {
			d.Cert = &EmptyCertificate{RuleID: r.rule.ID, SelfEmpty: true}
			out = append(out, d)
			continue
		}

		rest := make([]*Automaton, 0, len(higher))
		for _, h := range higher {
			rest = append(rest, h.eff)
		}
		unshadowed := subtractAll(r.eff, rest...)
		if w, ok := unshadowed.shortestWord(); ok {
			d.Reachable = true
			d.Witness = w
			out = append(out, d)
			continue
		}

		cert := &EmptyCertificate{RuleID: r.rule.ID, Explored: unshadowed.NumStates()}
		for _, h := range higher {
			if _, ok := intersect(r.eff, h.eff).shortestWord(); ok {
				cert.ShadowedBy = append(cert.ShadowedBy, h.rule.ID)
			}
		}
		d.Cert = cert
		out = append(out, d)
	}
	return out
}

// Verify independently re-checks the certificate against the library: the
// named rule must exist, every listed shadower must be strictly more
// specific, and the rule's language minus the shadowers' union must be
// empty. For SelfEmpty certificates the rule's own language must be empty.
func (c *EmptyCertificate) Verify(l *Library) bool {
	var target *compiledRule
	for i := range l.rules {
		if l.rules[i].rule.ID == c.RuleID {
			target = &l.rules[i]
			break
		}
	}
	if target == nil {
		return false
	}
	if c.SelfEmpty {
		_, nonEmpty := target.eff.shortestWord()
		return !nonEmpty
	}
	seen := map[string]bool{}
	var shadowers []*Automaton
	for _, id := range c.ShadowedBy {
		if seen[id] {
			return false
		}
		seen[id] = true
		var h *compiledRule
		for i := range l.rules {
			if l.rules[i].rule.ID == id {
				h = &l.rules[i]
				break
			}
		}
		if h == nil || !h.spec.higher(target.spec) {
			return false
		}
		shadowers = append(shadowers, h.eff)
	}
	_, nonEmpty := subtractAll(target.eff, shadowers...).shortestWord()
	return !nonEmpty
}
