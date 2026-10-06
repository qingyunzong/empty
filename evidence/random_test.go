package evidence

import (
	"math/rand"
	"testing"
)

// TestRandomManifestMutationsReportPositions randomly deletes fields or
// corrupts hashes of an otherwise-valid manifest and checks that the
// validator reports the error at the mutated position.
func TestRandomManifestMutationsReportPositions(t *testing.T) {
	type mutation struct {
		name     string
		apply    func(*Input)
		position string
		status   Status
	}
	mutations := []mutation{
		{"delete problem hash", func(in *Input) { in.Manifest.ProblemHash = "" }, "problem_hash", StatusIncomplete},
		{"delete artifact hash", func(in *Input) { in.Manifest.ArtifactHash = "" }, "artifact_hash", StatusIncomplete},
		{"delete score", func(in *Input) { in.Manifest.Score = nil }, "score", StatusIncomplete},
		{"delete receipt", func(in *Input) { in.Receipt = nil }, "receipt", StatusIncomplete},
		{"delete manifest", func(in *Input) { in.Manifest = nil }, "manifest", StatusIncomplete},
		{"corrupt problem hash", func(in *Input) { in.Manifest.ProblemHash = HashBytes("problem", []byte("x")) }, "problem_hash", StatusRejected},
		{"corrupt artifact hash", func(in *Input) { in.Manifest.ArtifactHash = HashBytes("artifact", []byte("x")) }, "artifact_hash", StatusRejected},
		{"corrupt expected problem hash", func(in *Input) { in.ExpectedProblemHash = HashBytes("problem", []byte("y")) }, "problem_hash", StatusRejected},
		{"corrupt expected artifact hash", func(in *Input) { in.ExpectedArtifactHash = HashBytes("artifact", []byte("y")) }, "artifact_hash", StatusRejected},
		{"score below range", func(in *Input) { in.Manifest.Score = intPtr(0) }, "score", StatusRejected},
		{"score above range", func(in *Input) { in.Manifest.Score = intPtr(6) }, "score", StatusRejected},
		{"stale version", func(in *Input) { in.ExpectedVersion = in.Manifest.Version + 1 }, "version", StatusRejected},
	}

	rng := rand.New(rand.NewSource(20261006))
	for trial := 0; trial < 200; trial++ {
		mut := mutations[rng.Intn(len(mutations))]
		f := newFixture(t)
		mut.apply(&f.input)
		// Re-sign so the receipt tracks the mutated manifest; otherwise a
		// digest mismatch would mask the mutated position.
		if f.input.Manifest != nil && f.input.Receipt != nil {
			f.input.Receipt.Digest = f.input.Manifest.Digest()
			sig, err := f.adapter.Sign("signer-a", []byte(f.input.Manifest.Digest()))
			if err != nil {
				t.Fatal(err)
			}
			f.input.Receipt.Signature = sig
		}
		rep := f.val.Validate(f.input)
		if rep.Status != mut.status {
			t.Fatalf("trial %d mutation %q: status = %s, want %s (rejections %+v)",
				trial, mut.name, rep.Status, mut.status, rep.Rejections)
		}
		if rejectionAt(rep, mut.position) == nil {
			t.Fatalf("trial %d mutation %q: no rejection at position %q (got %+v)",
				trial, mut.name, mut.position, rep.Rejections)
		}
		found := false
		for _, l := range rep.Chain {
			if l.Position == mut.position && l.Status != StatusValid {
				found = true
			}
		}
		if !found {
			t.Fatalf("trial %d mutation %q: chain has no non-valid link at %q (%+v)",
				trial, mut.name, mut.position, rep.Chain)
		}
	}
}
