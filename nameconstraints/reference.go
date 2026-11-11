package nameconstraints

// ChainEntry is one certificate in a signature-verified chain presented to
// the reference implementation. Entries are ordered from the root CA down
// to the leaf.
type ChainEntry struct {
	// Permitted and Excluded are the CA's own name constraints.
	Permitted []Constraint
	Excluded  []Constraint
	// SANs are checked for this entry. Intermediate CAs typically leave
	// this empty; the leaf always populates it.
	SANs []Name
	// SelfIssued marks a non-leaf self-issued certificate. Such an entry
	// skips its own name check while still contributing its constraints.
	// The field is ignored for the final entry, which is never skipped.
	SelfIssued bool
}

// ReferenceValidator walks a chain one CA at a time. At each entry it first
// checks that entry's SANs against the constraints accumulated from the
// CAs above it (unless the entry is a non-leaf self-issued certificate),
// then merges the entry's own constraints for the remainder of the chain.
type ReferenceValidator struct {
	set Set
	// entries counts how many chain entries have been applied.
	entries int
}

// NewReferenceValidator returns an empty reference validator.
func NewReferenceValidator() *ReferenceValidator {
	return &ReferenceValidator{set: *NewSet()}
}

// Set exposes the constraints accumulated so far.
func (v *ReferenceValidator) Set() *Set {
	return &v.set
}

// ApplyCA processes one chain entry.
//
// For non-leaf self-issued entries the SAN check is skipped while the
// entry's constraints are still applied. The leaf is never skipped: pass
// leaf=true for the final entry to force its SANs to be checked.
func (v *ReferenceValidator) ApplyCA(entry ChainEntry, leaf bool) error {
	v.entries++
	// A non-leaf self-issued certificate skips its own name check, but the
	// leaf is never skipped. The check always precedes merging this entry's
	// constraints so its own permitted set cannot shield its SANs.
	if leaf || !entry.SelfIssued {
		if err := v.set.CheckNames(entry.SANs); err != nil {
			return err
		}
	}
	v.set.AddCA(entry.Permitted, entry.Excluded)
	return nil
}

// EvaluateChain runs the reference algorithm over a full chain ordered from
// the root CA to the leaf and returns the final accumulated set.
func EvaluateChain(chain []ChainEntry) (*Set, error) {
	v := NewReferenceValidator()
	for i, entry := range chain {
		if err := v.ApplyCA(entry, i == len(chain)-1); err != nil {
			return nil, err
		}
	}
	return v.Set(), nil
}
