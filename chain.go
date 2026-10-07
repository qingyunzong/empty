package preimage

// PreimageStep records one per-interval preimage computation: the output
// interval queried at a layer and the input intervals recovered for it.
type PreimageStep struct {
	Query   Interval
	Results []Interval
}

// LayerProof records every preimage step performed at one chain layer.
// Layer 0 is the first map applied to the input; the final map is layer
// len(chain)-1. Replaying layers from the last map backwards reproduces
// the query and shows that every intermediate floor rounding was
// traversed instead of merging coefficients across layers.
type LayerProof struct {
	Layer int
	Steps []PreimageStep
}

// Proof is the layer-by-layer preimage certificate of a chain query.
type Proof struct {
	Layers []LayerProof
}

// Token is a resumable cursor for budget-limited chain preimage queries.
// A nil Token means the query is complete.
type Token struct {
	// Layer is the chain layer currently being processed, counting down
	// from len(chain)-1 to 0.
	Layer int
	// Pending holds the not-yet-processed query intervals at Layer.
	Pending []Interval
	// Emit buffers already-computed layer-0 results that did not fit in
	// the previous budget-limited batch.
	Emit []Interval
}

// PreimageChain computes the input intervals of chain[0] whose image under
// the composed map chain[len-1] o ... o chain[0] lies in the half-open
// interval y. The preimage is computed layer by layer, so every
// intermediate floor rounding is honored exactly.
//
// At most budget result intervals are emitted per call; budget <= 0 means
// unlimited. If the query is not finished, a non-nil Token is returned;
// pass it to ResumePreimage to continue. Results are emitted in
// deterministic query order; apply Canonicalize to the concatenation of
// all batches for the canonical form.
func PreimageChain(chain []Map, y Interval, budget int) ([]Interval, *Token, Proof) {
	return ResumePreimage(chain, Token{Layer: len(chain) - 1, Pending: []Interval{y}}, budget)
}

// ResumePreimage continues a paused chain preimage query. The returned
// proof covers only the steps performed during this call; concatenate
// proofs across resumes for the full certificate.
func ResumePreimage(chain []Map, tok Token, budget int) ([]Interval, *Token, Proof) {
	var results []Interval
	var proof Proof
	pending := append([]Interval(nil), tok.Pending...)
	emit := append([]Interval(nil), tok.Emit...)

	for layer := tok.Layer; layer >= 0; layer-- {
		lp := LayerProof{Layer: layer}
		if layer == 0 {
			// Flush buffered results from a previous paused batch.
			for len(emit) > 0 {
				results = append(results, emit[0])
				emit = emit[1:]
				if budget > 0 && len(results) >= budget && (len(emit) > 0 || len(pending) > 0) {
					tok := &Token{Layer: 0, Pending: pending, Emit: emit}
					return results, tok, Proof{Layers: append(proof.Layers, lp)}
				}
			}
		}
		var next []Interval
		for i := 0; i < len(pending); i++ {
			q := pending[i]
			got := chain[layer].Preimage(q)
			lp.Steps = append(lp.Steps, PreimageStep{Query: q, Results: got})
			if layer == 0 {
				for len(got) > 0 {
					results = append(results, got[0])
					got = got[1:]
					if budget > 0 && len(results) >= budget && (len(got) > 0 || i+1 < len(pending)) {
						tok := &Token{Layer: 0, Pending: pending[i+1:], Emit: got}
						return results, tok, Proof{Layers: append(proof.Layers, lp)}
					}
				}
			} else {
				next = append(next, got...)
			}
		}
		proof.Layers = append(proof.Layers, lp)
		pending = Canonicalize(next)
	}
	return results, nil, proof
}

// EvalChain applies the composed map to x layer by layer. The second
// result is false if x falls outside any intermediate map domain.
func EvalChain(chain []Map, x int64) (int64, bool) {
	v := x
	for _, m := range chain {
		var ok bool
		v, ok = m.Eval(v)
		if !ok {
			return 0, false
		}
	}
	return v, true
}
