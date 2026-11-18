package policy

// naiveEvalExpr is the independent reference interpreter used by the
// differential tests. It re-evaluates the declarative AST directly,
// predicate by predicate, sharing only the tri-state resolve helper and
// the value comparison primitives with the compiled implementation.

import "regexp"

func naiveEvalExpr(expr Expr, scope any) bool {
	switch e := expr.(type) {
	case And:
		for _, arg := range e.Args {
			if !naiveEvalExpr(arg, scope) {
				return false
			}
		}
		return true
	case Or:
		for _, arg := range e.Args {
			if naiveEvalExpr(arg, scope) {
				return true
			}
		}
		return false
	case Not:
		return !naiveEvalExpr(e.Arg, scope)
	case Pred:
		return naiveEvalPred(e, scope)
	case Selector:
		return naiveEvalSelector(e, scope)
	case Quantifier:
		return naiveEvalQuantifier(e, scope)
	}
	panic("unknown expression")
}

func naiveEvalPred(p Pred, scope any) bool {
	r := resolve(scope, p.Path)
	switch p.Op {
	case OpExists:
		return r.state != fieldMissing
	case OpNotExists:
		return r.state == fieldMissing
	case OpIsNull:
		return r.state == fieldNull
	case OpIsNotNull:
		return r.state == fieldValue
	}
	if r.state != fieldValue {
		if r.state == fieldNull {
			switch p.Op {
			case OpEq:
				return p.Value == nil
			case OpNotEq:
				return p.Value != nil
			}
		}
		return false
	}
	switch p.Op {
	case OpEq:
		return valuesEqual(r.value, p.Value)
	case OpNotEq:
		return !valuesEqual(r.value, p.Value)
	case OpIn:
		for _, c := range p.Value.([]any) {
			if valuesEqual(r.value, c) {
				return true
			}
		}
		return false
	case OpNotIn:
		for _, c := range p.Value.([]any) {
			if valuesEqual(r.value, c) {
				return false
			}
		}
		return true
	case OpGt, OpGte, OpLt, OpLte:
		cmp, ok := compareOrdered(r.value, p.Value)
		if !ok {
			return false
		}
		switch p.Op {
		case OpGt:
			return cmp > 0
		case OpGte:
			return cmp >= 0
		case OpLt:
			return cmp < 0
		default:
			return cmp <= 0
		}
	case OpMatches:
		s, ok := r.value.(string)
		if !ok {
			return false
		}
		return regexp.MustCompile(p.Value.(string)).MatchString(s)
	}
	panic("unknown op")
}

func naiveEvalSelector(s Selector, scope any) bool {
	path := s.Path
	if path == nil {
		path = []string{"metadata", "labels"}
	}
	r := resolve(scope, path)
	var labels map[string]any
	if r.state == fieldValue {
		m, ok := r.value.(map[string]any)
		if !ok {
			return len(s.MatchLabels) == 0 && len(s.MatchExpressions) == 0
		}
		labels = m
	}
	for k, want := range s.MatchLabels {
		got, ok := labels[k].(string)
		if !ok || got != want {
			return false
		}
	}
	for _, req := range s.MatchExpressions {
		raw, present := labels[req.Key]
		str, isStr := raw.(string)
		switch req.Operator {
		case SelectorIn:
			found := false
			if present && isStr {
				for _, v := range req.Values {
					if v == str {
						found = true
					}
				}
			}
			if !found {
				return false
			}
		case SelectorNotIn:
			if present && isStr {
				for _, v := range req.Values {
					if v == str {
						return false
					}
				}
			}
		case SelectorExists:
			if !present {
				return false
			}
		case SelectorDoesNotExist:
			if present {
				return false
			}
		}
	}
	return true
}

func naiveEvalQuantifier(q Quantifier, scope any) bool {
	r := resolve(scope, q.Path)
	if r.state != fieldValue {
		return false
	}
	list, ok := r.value.([]any)
	if !ok {
		return false
	}
	matches := 0
	for _, elem := range list {
		if naiveEvalExpr(q.Item, elem) {
			matches++
		}
	}
	if q.Kind == ForAll {
		return matches == len(list)
	}
	return matches > 0
}

// naiveDecision re-derives the merged decision by re-evaluating every
// rule's AST in stable rule order.
func naiveDecision(rules []Rule, obj any) Decision {
	var reasons []Reason
	for _, rule := range rules {
		if naiveEvalExpr(rule.When, obj) {
			msg := rule.Reason
			if msg == "" {
				msg = "denied by rule " + rule.ID
			}
			reasons = append(reasons, Reason{RuleID: rule.ID, Message: msg})
		}
	}
	if len(reasons) == 0 {
		return Decision{Allowed: true}
	}
	return Decision{Allowed: false, Reasons: reasons}
}
