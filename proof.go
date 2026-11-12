package dataeng

import "fmt"

// buildProof assembles per-field evidence explaining why full enumeration
// found no counterexample. The exhaustiveness comes from Check itself; these
// facts give the host a readable structural justification alongside the
// exact enumerated domain size.
func buildProof(oldC, newC *compiledSchema, checked uint64) *Proof {
	facts := make([]FieldFact, 0, len(oldC.fields)+len(newC.fields))
	for _, old := range oldC.fields {
		j, ok := newC.index[old.Name]
		if !ok {
			facts = append(facts, FieldFact{
				Field:  old.Name,
				Detail: "field removed by new schema; any present value would be rejected",
			})
			continue
		}
		fresh := newC.fields[j]
		fact := FieldFact{Field: old.Name, Contained: true}
		switch {
		case old.Kind != fresh.Kind:
			fact.Contained = false
			fact.Detail = fmt.Sprintf("kind changed from %d to %d", old.Kind, fresh.Kind)
		case fresh.Required && !old.Required:
			fact.Contained = false
			fact.Detail = "new schema makes the field required, but old records may omit it"
		case old.Kind == IntegerEnum:
			fact.Detail = integerEnumFact(old, fresh)
			fact.Contained = fact.Detail == ""
		default:
			fact.Detail = arrayFact(old, fresh)
			fact.Contained = fact.Detail == ""
		}
		facts = append(facts, fact)
	}
	for _, fresh := range newC.fields {
		if _, ok := oldC.index[fresh.Name]; ok {
			continue
		}
		fact := FieldFact{Field: fresh.Name, Contained: true}
		if fresh.Required {
			fact.Contained = false
			fact.Detail = "new required field is absent from every old record"
		} else {
			fact.Detail = "new optional field: old records simply omit it"
		}
		facts = append(facts, fact)
	}
	return &Proof{
		Contained:     true,
		OldDomainSize: checked,
		Checked:       checked,
		FieldFacts:    facts,
	}
}

// integerEnumFact returns "" when every old value (including null) stays
// legal under the new field, otherwise an explanatory detail.
func integerEnumFact(old, fresh FieldSpec) string {
	if old.Nullable && !fresh.Nullable {
		return "old field allows null but the new field rejects null"
	}
	if !enumSubset(old.Enum, fresh.Enum) {
		return fmt.Sprintf("old enum %v is not a subset of new enum %v", old.Enum, fresh.Enum)
	}
	return ""
}

// arrayFact returns "" when every old array length and element stays legal.
func arrayFact(old, fresh FieldSpec) string {
	if old.MinItems < fresh.MinItems {
		return fmt.Sprintf("MinItems tightened from %d to %d", old.MinItems, fresh.MinItems)
	}
	if old.MaxItems > fresh.MaxItems {
		return fmt.Sprintf("MaxItems tightened from %d to %d", old.MaxItems, fresh.MaxItems)
	}
	if !enumSubset(old.Enum, fresh.Enum) {
		return fmt.Sprintf("old enum %v is not a subset of new enum %v", old.Enum, fresh.Enum)
	}
	return ""
}

// enumSubset reports whether every caller-ordered value of a appears in b.
// Order itself is not required to match because the values must remain
// legal; ordering only affects enumeration sequence.
func enumSubset(a, b []int) bool {
	allowed := make(map[int]struct{}, len(b))
	for _, v := range b {
		allowed[v] = struct{}{}
	}
	for _, v := range a {
		if _, ok := allowed[v]; !ok {
			return false
		}
	}
	return true
}
