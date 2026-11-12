package wf

// refValuation is the three-valued interpretation produced by the independent
// reference procedure. It deliberately shares no code with the alternating
// fixed point implementation.
type refValuation struct {
	True    []string
	False   []string
	Unknown []string
}

// referenceEvaluate implements well-founded semantics without enumerating
// stable models:
//
//  1. Starting from empty T and F, add every head whose full body is true in
//     the current three-valued interpretation, closing under those rules.
//  2. Build the greatest unfounded set G from B\T by repeatedly removing a
//     head that still has a rule with no currently false body literal and no
//     positive body atom intersecting G.
//  3. Add G to F and alternate until T and F stabilize.
//
// A positive literal is currently false exactly when its atom is in F; a
// negative literal is currently false exactly when its atom is in T.
// Undefined literals are not false.
func referenceEvaluate(p *Program) refValuation {
	trueSet := make(map[string]bool)
	falseSet := make(map[string]bool)

	for {
		previousTrue := len(trueSet)
		previousFalse := len(falseSet)

		closeTrueRules(p, trueSet, falseSet)

		unfounded := greatestUnfounded(p, trueSet, falseSet)
		for atom := range unfounded {
			falseSet[atom] = true
		}

		if len(trueSet) == previousTrue && len(falseSet) == previousFalse {
			break
		}
	}

	trueList, falseList, unknownList := partitionUniverse(p, trueSet, falseSet)
	return refValuation{True: trueList, False: falseList, Unknown: unknownList}
}

func closeTrueRules(p *Program, trueSet, falseSet map[string]bool) {
	changed := true
	for changed {
		changed = false
		for _, id := range p.ruleIDs {
			rule := p.rules[id]
			if trueSet[rule.head] {
				continue
			}
			if bodyAllTrue(rule, trueSet, falseSet) {
				trueSet[rule.head] = true
				changed = true
			}
		}
	}
}

func bodyAllTrue(rule *compiledRule, trueSet, falseSet map[string]bool) bool {
	for _, premise := range rule.pos {
		if !trueSet[premise] {
			return false
		}
	}
	for _, neg := range rule.neg {
		if !falseSet[neg] {
			return false
		}
	}
	return true
}

func greatestUnfounded(p *Program, trueSet, falseSet map[string]bool) map[string]bool {
	candidate := make(map[string]bool)
	for _, atom := range p.universe {
		if !trueSet[atom] {
			candidate[atom] = true
		}
	}

	changed := true
	for changed {
		changed = false
		for _, head := range p.universe {
			if !candidate[head] {
				continue
			}
			for _, rule := range p.rulesFor(head) {
				if hasCurrentlyFalseLiteral(rule, trueSet, falseSet) {
					continue
				}
				if positiveBodyIntersects(rule, candidate) {
					continue
				}
				delete(candidate, head)
				changed = true
				break
			}
		}
	}
	return candidate
}

func hasCurrentlyFalseLiteral(rule *compiledRule, trueSet, falseSet map[string]bool) bool {
	for _, premise := range rule.pos {
		if falseSet[premise] {
			return true
		}
	}
	for _, neg := range rule.neg {
		if trueSet[neg] {
			return true
		}
	}
	return false
}

func positiveBodyIntersects(rule *compiledRule, set map[string]bool) bool {
	for _, premise := range rule.pos {
		if set[premise] {
			return true
		}
	}
	return false
}

func partitionUniverse(p *Program, trueSet, falseSet map[string]bool) ([]string, []string, []string) {
	var trueList, falseList, unknownList []string
	for _, atom := range p.universe {
		switch {
		case trueSet[atom]:
			trueList = append(trueList, atom)
		case falseSet[atom]:
			falseList = append(falseList, atom)
		default:
			unknownList = append(unknownList, atom)
		}
	}
	return trueList, falseList, unknownList
}
