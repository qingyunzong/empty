// Package evidencecheck validates evaluation evidence manifests: it checks
// statement hashes, run-artifact hashes and score fields, tracks evidence
// versions, and verifies signed receipts against signer trust versions.
//
// The library reports whether evidence is valid, incomplete or rejected, and
// outputs the association chain plus rejection reasons. It never fabricates
// an evaluation conclusion on its own: missing evidence yields StatusIncomplete
// and the caller is responsible for any final verdict.
package evidencecheck

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// Status is the outcome of validating or recording evidence.
type Status string

const (
	// StatusValid means every required check passed.
	StatusValid Status = "valid"
	// StatusIncomplete means required evidence is missing. The library
	// explicitly reports incompleteness instead of guessing a conclusion.
	StatusIncomplete Status = "incomplete"
	// StatusRejected means evidence is present but failed a check.
	StatusRejected Status = "rejected"
)

// Required manifest fields, used as error locations.
const (
	FieldProblemID     = "problem_id"
	FieldVersion       = "version"
	FieldStatementHash = "statement_hash"
	FieldArtifactHash  = "artifact_hash"
	FieldScore         = "score"
)

// ValidationError pinpoints a single failed check.
type ValidationError struct {
	// Location is the manifest or receipt field that failed, e.g. "score"
	// or "receipt.signature".
	Location string
	Reason   string
}

func (e ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Location, e.Reason)
}

// Manifest is the decoded evidence manifest. Score is a pointer so a missing
// score is distinguishable from a present one.
type Manifest struct {
	ProblemID     string
	Version       int
	StatementHash string
	ArtifactHash  string
	Score         *int
}

// HashBytes returns the lowercase hex SHA-256 of content.
func HashBytes(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

// ChainHash binds statement hash, artifact hash and score into one
// association hash. The receipt signs this value, so any tampering with a
// link breaks the chain.
func ChainHash(statementHash, artifactHash string, score int) string {
	sum := sha256.Sum256([]byte(statementHash + "|" + artifactHash + "|" + fmt.Sprintf("%d", score)))
	return hex.EncodeToString(sum[:])
}

// ChainLink is one stage of the association chain reported to callers.
type ChainLink struct {
	Stage  string // "statement", "artifact", "score", "receipt"
	Hash   string // hash bound at this stage, if any
	OK     bool
	Reason string // rejection reason when OK is false
}

// Report is the full validation output: overall status, the association
// chain, and every error with its location.
type Report struct {
	Status Status
	Chain  []ChainLink
	Errors []ValidationError
}

func (r *Report) addError(location, reason string) {
	r.Errors = append(r.Errors, ValidationError{Location: location, Reason: reason})
}
