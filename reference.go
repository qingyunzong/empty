package logrule

// Interpret is the reference recursive interpreter for the engine
// semantics. Engine.Process must produce a provenance tree identical to
// Interpret for every record; the randomized tests cross-check the two.
func (e *Engine) Interpret(rec Record) *Node {
	return e.interpret(rec, 0, nil)
}

func (e *Engine) interpret(rec Record, depth int, ancestors []Record) *Node {
	n := &Node{Record: rec, Depth: depth}
	gen := e.generationFor(rec.Seq)
	n.Gen = gen.id
	if depth > 0 && containsRecord(ancestors, rec) {
		n.Note = NoteRematch
		return n
	}
	var derived []Record
	for _, r := range gen.rules {
		if r.Match != nil && r.Match(rec) {
			n.Matched = append(n.Matched, r.Name)
			if r.Derive != nil {
				derived = append(derived, r.Derive(rec)...)
			}
		}
	}
	if len(derived) == 0 {
		return n
	}
	if depth >= e.maxDepth {
		n.Note = NoteDepthBudget
		return n
	}
	ancestors = append(append([]Record{}, ancestors...), rec)
	for _, d := range derived {
		n.Children = append(n.Children, e.interpret(d, depth+1, ancestors))
	}
	return n
}

func containsRecord(haystack []Record, rec Record) bool {
	for _, h := range haystack {
		if h == rec {
			return true
		}
	}
	return false
}
