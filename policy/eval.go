package policy

// Evaluate evaluates the plan against obj with short-circuit semantics:
// the first matching deny rule rejects the object and evaluation stops.
// Evaluation is pure — obj is only read, never mutated — so abandoning
// the remaining rules has no observable side effect.
func (p *Plan) Evaluate(obj any) Decision {
	for _, rule := range p.rules {
		if rule.when.eval(obj) {
			return Decision{
				Allowed: false,
				Reasons: []Reason{{RuleID: rule.id, Message: rule.reason}},
			}
		}
	}
	return Decision{Allowed: true}
}

// EvaluateAll evaluates every rule and merges the outcome: any matching
// deny rule rejects the object, and all matched reasons are reported in
// stable rule order (the order rules were given to Compile).
func (p *Plan) EvaluateAll(obj any) Decision {
	var reasons []Reason
	for _, rule := range p.rules {
		if rule.when.eval(obj) {
			reasons = append(reasons, Reason{RuleID: rule.id, Message: rule.reason})
		}
	}
	if len(reasons) == 0 {
		return Decision{Allowed: true}
	}
	return Decision{Allowed: false, Reasons: reasons}
}
