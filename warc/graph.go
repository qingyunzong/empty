package warc

import "fmt"

// Graph is a collection of WARC records plus the relationships between
// them. Add records, then call Resolve to validate the collection and
// link records through record ID and WARC-Refers-To.
type Graph struct {
	records     map[string]*Record
	order       []*Record
	referrers   map[string][]*Record
	reassembled map[string][]byte
	resolved    bool
}

// NewGraph returns an empty graph.
func NewGraph() *Graph {
	return &Graph{records: make(map[string]*Record)}
}

// Add inserts a record into the collection. It fails if the record has
// no ID or the ID is already present.
func (g *Graph) Add(r *Record) error {
	if r.ID == "" {
		return fmt.Errorf("%w", ErrMissingRecordID)
	}
	if _, dup := g.records[r.ID]; dup {
		return fmt.Errorf("%w: %q", ErrDuplicateRecordID, r.ID)
	}
	g.records[r.ID] = r
	g.order = append(g.order, r)
	g.resolved = false
	return nil
}

// Record returns the record with the given ID.
func (g *Graph) Record(id string) (*Record, bool) {
	r, ok := g.records[id]
	return r, ok
}

// Records returns all records in insertion order.
func (g *Graph) Records() []*Record {
	return append([]*Record(nil), g.order...)
}

// RefersTo returns the record that the record id refers to via
// WARC-Refers-To.
func (g *Graph) RefersTo(id string) (*Record, bool) {
	r, ok := g.records[id]
	if !ok || r.RefersTo == "" {
		return nil, false
	}
	t, ok := g.records[r.RefersTo]
	return t, ok
}

// Referrers returns the records whose WARC-Refers-To points at id.
// It is populated by Resolve.
func (g *Graph) Referrers(id string) []*Record {
	return append([]*Record(nil), g.referrers[id]...)
}

// Reassembled returns the seamlessly concatenated content of the
// segmented record whose origin (segment 1) record is id. The second
// result is false for unsegmented records. It is populated by Resolve.
func (g *Graph) Reassembled(id string) ([]byte, bool) {
	b, ok := g.reassembled[id]
	return b, ok
}

// payloadForDigest returns the content a record's payload digest is
// verified against: the reassembled content for segmented records,
// otherwise the record content.
func (g *Graph) payloadForDigest(r *Record) []byte {
	if b, ok := g.reassembled[r.ID]; ok {
		return b
	}
	return r.Content
}

// Resolve validates the whole collection and builds the relationship
// indexes. It reassembles segmented records, verifies payload digests
// of original records, resolves WARC-Refers-To and WARC-Concurrent-To
// links, rejects reference cycles, and checks that every revisit record
// refers to a verified original with a matching payload digest.
func (g *Graph) Resolve() error {
	if err := g.resolveSegments(); err != nil {
		return err
	}
	if err := g.verifyOriginals(); err != nil {
		return err
	}
	if err := g.linkReferences(); err != nil {
		return err
	}
	if err := g.checkRevisits(); err != nil {
		return err
	}
	g.resolved = true
	return nil
}

func (g *Graph) resolveSegments() error {
	groups, err := groupSegments(g.records)
	if err != nil {
		return err
	}
	g.reassembled = make(map[string][]byte)
	for id, grp := range groups {
		content, err := grp.reassemble()
		if err != nil {
			return err
		}
		if content != nil {
			g.reassembled[id] = content
		}
	}
	return nil
}

// verifyOriginals verifies the payload digest of every non-revisit
// record that carries both a digest and a payload.
func (g *Graph) verifyOriginals() error {
	for _, r := range g.order {
		if r.Type == TypeRevisit || r.PayloadDigest == "" {
			continue
		}
		payload := g.payloadForDigest(r)
		if len(payload) == 0 {
			continue
		}
		if err := verifyDigest(r.PayloadDigest, payload); err != nil {
			return fmt.Errorf("record %q: %w", r.ID, err)
		}
	}
	return nil
}

// linkReferences resolves RefersTo and ConcurrentTo links, builds the
// referrers index and rejects refers-to cycles.
func (g *Graph) linkReferences() error {
	g.referrers = make(map[string][]*Record)
	for _, r := range g.order {
		if r.RefersTo != "" {
			t, ok := g.records[r.RefersTo]
			if !ok {
				return fmt.Errorf("%w: record %q refers to %q",
					ErrMissingReference, r.ID, r.RefersTo)
			}
			g.referrers[t.ID] = append(g.referrers[t.ID], r)
		}
		for _, c := range r.ConcurrentTo {
			if _, ok := g.records[c]; !ok {
				return fmt.Errorf("%w: record %q concurrent to %q",
					ErrMissingReference, r.ID, c)
			}
		}
	}
	for _, r := range g.order {
		if err := g.checkCycle(r); err != nil {
			return err
		}
	}
	return nil
}

func (g *Graph) checkCycle(start *Record) error {
	seen := map[string]bool{start.ID: true}
	for cur := start; cur.RefersTo != ""; {
		next := g.records[cur.RefersTo]
		if next == nil {
			return nil // missing targets are reported by linkReferences
		}
		if seen[next.ID] {
			return fmt.Errorf("%w: %q -> %q", ErrReferenceCycle, start.ID, next.ID)
		}
		seen[next.ID] = true
		cur = next
	}
	return nil
}

// checkRevisits enforces that a revisit's payload digest references a
// verified original record in the same collection.
func (g *Graph) checkRevisits() error {
	for _, r := range g.order {
		if r.Type != TypeRevisit {
			continue
		}
		if r.RefersTo == "" {
			return fmt.Errorf("%w: revisit %q", ErrMissingRefersTo, r.ID)
		}
		orig := g.records[r.RefersTo] // existence checked by linkReferences
		if orig == nil {
			continue
		}
		if orig.Type == TypeRevisit {
			return fmt.Errorf("%w: revisit %q refers to revisit %q",
				ErrRevisitTargetNotOriginal, r.ID, orig.ID)
		}
		if orig.PayloadDigest == "" || len(g.payloadForDigest(orig)) == 0 {
			return fmt.Errorf("%w: revisit %q target %q",
				ErrUnverifiedOriginal, r.ID, orig.ID)
		}
		if r.PayloadDigest == "" {
			return fmt.Errorf("%w: revisit %q carries no payload digest",
				ErrPayloadDigestMismatch, r.ID)
		}
		equal, err := digestsEqual(r.PayloadDigest, orig.PayloadDigest)
		if err != nil {
			return fmt.Errorf("revisit %q: %w", r.ID, err)
		}
		if !equal {
			return fmt.Errorf("%w: revisit %q digest differs from original %q",
				ErrPayloadDigestMismatch, r.ID, orig.ID)
		}
	}
	return nil
}
