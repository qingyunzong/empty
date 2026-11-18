package policy

import (
	"fmt"
	"regexp"
)

// compiledExpr is the immutable, compiled form of an Expr. Evaluation is
// pure: it reads scope and never mutates anything.
type compiledExpr interface {
	eval(scope any) bool
}

type compiledAnd []compiledExpr

func (c compiledAnd) eval(scope any) bool {
	for _, arg := range c {
		if !arg.eval(scope) {
			return false
		}
	}
	return true
}

type compiledOr []compiledExpr

func (c compiledOr) eval(scope any) bool {
	for _, arg := range c {
		if arg.eval(scope) {
			return true
		}
	}
	return false
}

type compiledNot struct{ arg compiledExpr }

func (c compiledNot) eval(scope any) bool { return !c.arg.eval(scope) }

// compiledPred is a predicate with its path and comparison value
// resolved and frozen at compile time.
type compiledPred struct {
	path    []string
	op      Op
	value   any // deep-copied, immutable
	pattern *regexp.Regexp
}

func (p *compiledPred) eval(scope any) bool {
	r := resolve(scope, p.path)
	switch p.op {
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
		// Equality against an explicit null still distinguishes the
		// tri-state: nil equals null but never a missing field.
		if r.state == fieldNull {
			switch p.op {
			case OpEq:
				return p.value == nil
			case OpNotEq:
				return p.value != nil
			}
		}
		// Every other value predicate fails on missing or null fields;
		// the two states remain distinguishable via the Exists/IsNull
		// family above.
		return false
	}
	switch p.op {
	case OpEq:
		return valuesEqual(r.value, p.value)
	case OpNotEq:
		return !valuesEqual(r.value, p.value)
	case OpIn:
		for _, candidate := range p.value.([]any) {
			if valuesEqual(r.value, candidate) {
				return true
			}
		}
		return false
	case OpNotIn:
		for _, candidate := range p.value.([]any) {
			if valuesEqual(r.value, candidate) {
				return false
			}
		}
		return true
	case OpGt, OpGte, OpLt, OpLte:
		cmp, ok := compareOrdered(r.value, p.value)
		if !ok {
			return false
		}
		switch p.op {
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
		return ok && p.pattern.MatchString(s)
	}
	return false
}

// compiledSelector matches a labels map with Kubernetes-like semantics.
type compiledSelector struct {
	path        []string
	matchLabels map[string]string
	exprs       []SelectorExpr // Values slices deep-copied
}

func (s *compiledSelector) eval(scope any) bool {
	r := resolve(scope, s.path)
	var labels map[string]any
	if r.state == fieldValue {
		m, ok := r.value.(map[string]any)
		if !ok {
			// A non-map labels field only matches an empty selector.
			return len(s.matchLabels) == 0 && len(s.exprs) == 0
		}
		labels = m
	}
	for key, want := range s.matchLabels {
		got, ok := labels[key].(string)
		if !ok || got != want {
			return false
		}
	}
	for _, req := range s.exprs {
		raw, present := labels[req.Key]
		str, isStr := raw.(string)
		switch req.Operator {
		case SelectorIn:
			if !present || !isStr || !containsString(req.Values, str) {
				return false
			}
		case SelectorNotIn:
			if present && isStr && containsString(req.Values, str) {
				return false
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

func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// compiledQuantifier applies item to each element of a list field.
type compiledQuantifier struct {
	kind QuantKind
	path []string
	item compiledExpr
}

func (q *compiledQuantifier) eval(scope any) bool {
	r := resolve(scope, q.path)
	if r.state != fieldValue {
		// Missing or null collection: not an empty set, quantifier fails.
		return false
	}
	list, ok := r.value.([]any)
	if !ok {
		return false
	}
	if q.kind == ForAll {
		for _, elem := range list {
			if !q.item.eval(elem) {
				return false
			}
		}
		return true // vacuous truth on the empty set
	}
	for _, elem := range list {
		if q.item.eval(elem) {
			return true
		}
	}
	return false
}

// compileExpr validates and compiles an expression tree. All mutable
// caller data (paths, maps, slices, comparison values) is deep-copied so
// the resulting plan cannot be polluted by later mutation.
func compileExpr(expr Expr) (compiledExpr, error) {
	switch e := expr.(type) {
	case And:
		args := make([]compiledExpr, 0, len(e.Args))
		for _, arg := range e.Args {
			c, err := compileExpr(arg)
			if err != nil {
				return nil, err
			}
			args = append(args, c)
		}
		return compiledAnd(args), nil
	case Or:
		args := make([]compiledExpr, 0, len(e.Args))
		for _, arg := range e.Args {
			c, err := compileExpr(arg)
			if err != nil {
				return nil, err
			}
			args = append(args, c)
		}
		return compiledOr(args), nil
	case Not:
		if e.Arg == nil {
			return nil, fmt.Errorf("policy: Not requires an argument")
		}
		c, err := compileExpr(e.Arg)
		if err != nil {
			return nil, err
		}
		return compiledNot{arg: c}, nil
	case Pred:
		return compilePred(e)
	case Selector:
		return compileSelector(e)
	case Quantifier:
		return compileQuantifier(e)
	case nil:
		return nil, fmt.Errorf("policy: nil expression")
	default:
		return nil, fmt.Errorf("policy: unknown expression type %T", expr)
	}
}

func compilePred(p Pred) (compiledExpr, error) {
	if !p.Op.valid() {
		return nil, fmt.Errorf("policy: invalid predicate operator %d", p.Op)
	}
	cp := &compiledPred{
		path: append([]string(nil), p.Path...),
		op:   p.Op,
	}
	switch p.Op {
	case OpIn, OpNotIn:
		list, ok := p.Value.([]any)
		if !ok {
			return nil, fmt.Errorf("policy: In/NotIn on path %v requires a []any value", p.Path)
		}
		cp.value = deepCopyValue(list)
	case OpMatches:
		pattern, ok := p.Value.(string)
		if !ok {
			return nil, fmt.Errorf("policy: Matches on path %v requires a string pattern", p.Path)
		}
		re, err := regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("policy: invalid Matches pattern: %w", err)
		}
		cp.pattern = re
	case OpExists, OpNotExists, OpIsNull, OpIsNotNull:
		// no comparison value
	default:
		cp.value = deepCopyValue(p.Value)
	}
	return cp, nil
}

func compileSelector(s Selector) (compiledExpr, error) {
	path := s.Path
	if path == nil {
		path = []string{"metadata", "labels"}
	}
	cs := &compiledSelector{
		path:        append([]string(nil), path...),
		matchLabels: make(map[string]string, len(s.MatchLabels)),
	}
	for k, v := range s.MatchLabels {
		cs.matchLabels[k] = v
	}
	for _, req := range s.MatchExpressions {
		switch req.Operator {
		case SelectorIn, SelectorNotIn:
			if len(req.Values) == 0 {
				return nil, fmt.Errorf("policy: selector %q requires values", req.Key)
			}
		case SelectorExists, SelectorDoesNotExist:
		default:
			return nil, fmt.Errorf("policy: invalid selector operator %d", req.Operator)
		}
		cs.exprs = append(cs.exprs, SelectorExpr{
			Key:      req.Key,
			Operator: req.Operator,
			Values:   append([]string(nil), req.Values...),
		})
	}
	return cs, nil
}

func compileQuantifier(q Quantifier) (compiledExpr, error) {
	if q.Kind != ForAll && q.Kind != Exists {
		return nil, fmt.Errorf("policy: invalid quantifier kind %d", q.Kind)
	}
	if len(q.Path) == 0 {
		return nil, fmt.Errorf("policy: quantifier requires a non-empty path")
	}
	if q.Item == nil {
		return nil, fmt.Errorf("policy: quantifier on path %v requires an item expression", q.Path)
	}
	item, err := compileExpr(q.Item)
	if err != nil {
		return nil, err
	}
	return &compiledQuantifier{
		kind: q.Kind,
		path: append([]string(nil), q.Path...),
		item: item,
	}, nil
}

// compiledRule pairs a rule's stable identity with its compiled guard.
type compiledRule struct {
	id     string
	reason string
	when   compiledExpr
}

// Plan is an immutable, compiled rule set. It is safe for concurrent
// use and can be evaluated repeatedly without side effects.
type Plan struct {
	rules []compiledRule // in stable rule order
}

// Compile validates rules and builds an immutable evaluation plan.
// Rule IDs must be unique and non-empty; rule order is preserved and
// defines the stable ordering of reasons.
func Compile(rules []Rule) (*Plan, error) {
	seen := make(map[string]struct{}, len(rules))
	compiled := make([]compiledRule, 0, len(rules))
	for i, rule := range rules {
		if rule.ID == "" {
			return nil, fmt.Errorf("policy: rule #%d has an empty ID", i)
		}
		if _, dup := seen[rule.ID]; dup {
			return nil, fmt.Errorf("policy: duplicate rule ID %q", rule.ID)
		}
		seen[rule.ID] = struct{}{}
		if rule.When == nil {
			return nil, fmt.Errorf("policy: rule %q has no When expression", rule.ID)
		}
		when, err := compileExpr(rule.When)
		if err != nil {
			return nil, fmt.Errorf("policy: rule %q: %w", rule.ID, err)
		}
		reason := rule.Reason
		if reason == "" {
			reason = fmt.Sprintf("denied by rule %s", rule.ID)
		}
		compiled = append(compiled, compiledRule{id: rule.ID, reason: reason, when: when})
	}
	return &Plan{rules: compiled}, nil
}
