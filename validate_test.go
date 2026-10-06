package evidencecheck

import (
	"math/rand"
	"testing"
)

func testExpected() Expected {
	return ExpectFromContents([]byte("problem statement v1"), []byte("run artifact bytes"))
}

func validRaw(exp Expected) map[string]any {
	return map[string]any{
		"problem_id":     "p-1",
		"version":        float64(1),
		"statement_hash": exp.StatementHash,
		"artifact_hash":  exp.ArtifactHash,
		"score":          float64(4),
	}
}

func errAt(rep Report, location string) *ValidationError {
	for i := range rep.Errors {
		if rep.Errors[i].Location == location {
			return &rep.Errors[i]
		}
	}
	return nil
}

func TestValidManifest(t *testing.T) {
	exp := testExpected()
	rep, m := ValidateManifest(validRaw(exp), exp)
	if rep.Status != StatusValid {
		t.Fatalf("status = %s, want valid; errors: %v", rep.Status, rep.Errors)
	}
	if m.Score == nil || *m.Score != 4 {
		t.Fatalf("score = %v, want 4", m.Score)
	}
	var assoc *ChainLink
	for i := range rep.Chain {
		if rep.Chain[i].Stage == "association" {
			assoc = &rep.Chain[i]
		}
	}
	if assoc == nil || !assoc.OK {
		t.Fatalf("association link missing or broken: %+v", rep.Chain)
	}
	want := ChainHash(exp.StatementHash, exp.ArtifactHash, 4)
	if assoc.Hash != want {
		t.Fatalf("association hash = %s, want %s", assoc.Hash, want)
	}
}

func TestMissingScoreIsIncompleteNotConcluded(t *testing.T) {
	exp := testExpected()
	raw := validRaw(exp)
	delete(raw, "score")
	rep, m := ValidateManifest(raw, exp)
	if rep.Status != StatusIncomplete {
		t.Fatalf("status = %s, want incomplete", rep.Status)
	}
	if errAt(rep, FieldScore) == nil {
		t.Fatalf("expected error at score, got %v", rep.Errors)
	}
	// The library must not auto-fill a conclusion: score stays absent.
	if m.Score != nil {
		t.Fatalf("score auto-filled with %d, want nil", *m.Score)
	}
}

func TestScoreRangeAndType(t *testing.T) {
	exp := testExpected()
	cases := []struct {
		name  string
		score any
	}{
		{"zero", float64(0)},
		{"six", float64(6)},
		{"fractional", float64(2.5)},
		{"string", "4"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := validRaw(exp)
			raw["score"] = tc.score
			rep, _ := ValidateManifest(raw, exp)
			if rep.Status != StatusRejected {
				t.Fatalf("status = %s, want rejected", rep.Status)
			}
			if errAt(rep, FieldScore) == nil {
				t.Fatalf("expected error at score, got %v", rep.Errors)
			}
		})
	}
	for _, s := range []float64{1, 2, 3, 4, 5} {
		raw := validRaw(exp)
		raw["score"] = s
		rep, _ := ValidateManifest(raw, exp)
		if rep.Status != StatusValid {
			t.Fatalf("score %v: status = %s, want valid", s, rep.Status)
		}
	}
}

// TestRandomFieldDeletionLocatesErrors deletes each required field from
// randomized manifests and checks the error points at the deleted field.
func TestRandomFieldDeletionLocatesErrors(t *testing.T) {
	exp := testExpected()
	fields := []string{"problem_id", "version", "statement_hash", "artifact_hash", "score"}
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < 50; i++ {
		raw := validRaw(exp)
		field := fields[rng.Intn(len(fields))]
		delete(raw, field)
		rep, _ := ValidateManifest(raw, exp)
		if rep.Status != StatusIncomplete {
			t.Fatalf("deleted %s: status = %s, want incomplete", field, rep.Status)
		}
		if errAt(rep, field) == nil {
			t.Fatalf("deleted %s: no error at that location, got %v", field, rep.Errors)
		}
	}
}

// TestRandomHashMutationLocatesErrors corrupts hashes in randomized
// manifests and checks the error points at the mutated field.
func TestRandomHashMutationLocatesErrors(t *testing.T) {
	exp := testExpected()
	fields := []string{"statement_hash", "artifact_hash"}
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 50; i++ {
		raw := validRaw(exp)
		field := fields[rng.Intn(len(fields))]
		raw[field] = HashBytes([]byte("tampered"))
		rep, _ := ValidateManifest(raw, exp)
		if rep.Status != StatusRejected {
			t.Fatalf("mutated %s: status = %s, want rejected", field, rep.Status)
		}
		if errAt(rep, field) == nil {
			t.Fatalf("mutated %s: no error at that location, got %v", field, rep.Errors)
		}
		for _, link := range rep.Chain {
			if (field == "statement_hash" && link.Stage == "statement") ||
				(field == "artifact_hash" && link.Stage == "artifact") {
				if link.OK || link.Reason == "" {
					t.Fatalf("chain link for %s should be broken with reason, got %+v", field, link)
				}
			}
		}
	}
}
