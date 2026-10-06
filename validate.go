package evidencecheck

import (
	"fmt"
	"math"
)

// Expected carries the trusted reference values a manifest is checked
// against: the hashes of the statement and run artifact contents.
type Expected struct {
	StatementHash string
	ArtifactHash  string
}

// ExpectFromContents builds Expected from raw statement and artifact bytes.
func ExpectFromContents(statement, artifact []byte) Expected {
	return Expected{StatementHash: HashBytes(statement), ArtifactHash: HashBytes(artifact)}
}

// ValidateManifest checks a raw decoded manifest (map form, so deleted
// fields are observable) against the expected hashes and the score rules.
//
// Checks, each reported with its field location:
//   - required fields present (missing evidence => StatusIncomplete)
//   - statement_hash matches expected
//   - artifact_hash matches expected
//   - score is an integer in [1, 5]
//
// The returned Report carries the association chain and rejection reasons.
// The library never invents a conclusion: when evidence is missing the
// status is StatusIncomplete and no verdict is synthesized.
func ValidateManifest(raw map[string]any, exp Expected) (Report, Manifest) {
	rep := Report{Status: StatusValid}
	var m Manifest
	missing := false

	getString := func(field string) string {
		v, ok := raw[field]
		if !ok {
			rep.addError(field, "required field is missing")
			missing = true
			return ""
		}
		s, ok := v.(string)
		if !ok || s == "" {
			rep.addError(field, "must be a non-empty string")
			return ""
		}
		return s
	}

	m.ProblemID = getString(FieldProblemID)
	m.StatementHash = getString(FieldStatementHash)
	m.ArtifactHash = getString(FieldArtifactHash)

	// version
	if v, ok := raw[FieldVersion]; !ok {
		rep.addError(FieldVersion, "required field is missing")
		missing = true
	} else if f, ok := v.(float64); !ok || f != math.Trunc(f) || f < 1 {
		rep.addError(FieldVersion, "must be a positive integer")
	} else {
		m.Version = int(f)
	}

	// score: integer in [1,5]; missing => incomplete, not auto-filled.
	if v, ok := raw[FieldScore]; !ok {
		rep.addError(FieldScore, "required field is missing")
		missing = true
	} else {
		f, ok := v.(float64)
		if !ok || f != math.Trunc(f) {
			rep.addError(FieldScore, "must be an integer")
		} else if f < 1 || f > 5 {
			rep.addError(FieldScore, "must be between 1 and 5")
		} else {
			s := int(f)
			m.Score = &s
		}
	}

	// hash associations
	stmtOK := m.StatementHash != "" && m.StatementHash == exp.StatementHash
	if m.StatementHash != "" && !stmtOK {
		rep.addError(FieldStatementHash, fmt.Sprintf("hash mismatch: got %s, want %s", m.StatementHash, exp.StatementHash))
	}
	artOK := m.ArtifactHash != "" && m.ArtifactHash == exp.ArtifactHash
	if m.ArtifactHash != "" && !artOK {
		rep.addError(FieldArtifactHash, fmt.Sprintf("hash mismatch: got %s, want %s", m.ArtifactHash, exp.ArtifactHash))
	}
	scoreOK := m.Score != nil

	rep.Chain = []ChainLink{
		{Stage: "statement", Hash: m.StatementHash, OK: stmtOK, Reason: linkReason(stmtOK, m.StatementHash, exp.StatementHash)},
		{Stage: "artifact", Hash: m.ArtifactHash, OK: artOK, Reason: linkReason(artOK, m.ArtifactHash, exp.ArtifactHash)},
		{Stage: "score", OK: scoreOK, Reason: scoreReason(m.Score)},
	}
	if stmtOK && artOK && scoreOK {
		rep.Chain = append(rep.Chain, ChainLink{
			Stage: "association",
			Hash:  ChainHash(m.StatementHash, m.ArtifactHash, *m.Score),
			OK:    true,
		})
	}

	switch {
	case missing:
		rep.Status = StatusIncomplete
	case len(rep.Errors) > 0:
		rep.Status = StatusRejected
	}
	return rep, m
}

func linkReason(ok bool, got, want string) string {
	if ok {
		return ""
	}
	if got == "" {
		return "evidence missing"
	}
	return fmt.Sprintf("hash mismatch: got %s, want %s", got, want)
}

func scoreReason(score *int) string {
	if score == nil {
		return "score missing or invalid"
	}
	return ""
}
