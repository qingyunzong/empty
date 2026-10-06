// Package evidence validates evaluation evidence: problem-statement hashes,
// run-artifact hashes, score fields, and signed receipts bound to signer
// trust versions.
package evidence

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// Score bounds: a score is only meaningful as an integer in [MinScore, MaxScore].
const (
	MinScore = 1
	MaxScore = 5
)

// Manifest is the evidence manifest under validation. Score is a pointer so
// that a missing score field is distinguishable from a present one; the
// validator never synthesizes a score or a conclusion.
type Manifest struct {
	ID           string
	Version      int
	ProblemHash  string
	ArtifactHash string
	Score        *int
	Conclusion   string
}

// Canonical returns the canonical serialization that receipts sign.
func (m *Manifest) Canonical() string {
	score := "<missing>"
	if m.Score != nil {
		score = fmt.Sprintf("%d", *m.Score)
	}
	return strings.Join([]string{
		"id=" + m.ID,
		fmt.Sprintf("version=%d", m.Version),
		"problem=" + m.ProblemHash,
		"artifact=" + m.ArtifactHash,
		"score=" + score,
	}, "|")
}

// Digest is the content digest receipts bind to.
func (m *Manifest) Digest() string {
	sum := sha256.Sum256([]byte(m.Canonical()))
	return hex.EncodeToString(sum[:])
}

// HashBytes hashes labeled content (problem statement, run artifact).
func HashBytes(label string, b []byte) string {
	sum := sha256.Sum256(append([]byte(label+":"), b...))
	return hex.EncodeToString(sum[:])
}
