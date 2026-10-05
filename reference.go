package logrules

// interpret is the reference recursive interpreter. It exists to cross-check
// the production worklist engine: both must produce structurally identical
// provenance trees for the same root record, rule snapshot, and depth budget.
//
// Semantics implemented here (and mirrored by deriveAll):
//   - every record is matched exactly once against the pinned rule snapshot;
//     derived diagnostics are new records and never re-match their parent;
//   - records at depth maxDepth are not matched; if any rule would have
//     derived from them, the record is marked Truncated.
func interpret(rec Record, rules []Rule, maxDepth int, alloc func() int64, out *[]Record) {
	idx := len(*out)
	*out = append(*out, rec)
	if rec.Depth >= maxDepth {
		if wouldDerive(rec, rules) {
			(*out)[idx].Truncated = true
		}
		return
	}
	for _, r := range rules {
		if !r.Match(rec) {
			continue
		}
		for _, msg := range r.Derive(rec) {
			child := deriveChild(rec, r, msg, alloc)
			interpret(child, rules, maxDepth, alloc, out)
		}
	}
}

// Interpret runs the reference interpreter over a root record and returns the
// full provenance forest, root first.
func Interpret(root Record, rules []Rule, maxDepth int, alloc func() int64) []Record {
	var out []Record
	interpret(root, rules, maxDepth, alloc, &out)
	return out
}
