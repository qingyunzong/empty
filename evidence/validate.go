package evidence

import (
	"fmt"
	"time"
)

// Status is the overall verdict of a validation report.
type Status string

const (
	StatusValid      Status = "valid"
	StatusIncomplete Status = "incomplete"
	StatusRejected   Status = "rejected"
)

// Rejection pinpoints why and where evidence was refused.
type Rejection struct {
	Position string
	Reason   string
}

// ChainLink is one hop of the association chain: problem hash -> artifact
// hash -> score -> receipt.
type ChainLink struct {
	Name     string
	Position string
	Status   Status
	Detail   string
}

// Report is the validation output: an overall status, the association chain,
// and every rejection reason. The validator never auto-fills evaluation
// conclusions; missing evidence yields StatusIncomplete, not a guess.
type Report struct {
	Status     Status
	Chain      []ChainLink
	Rejections []Rejection
}

// Input bundles the manifest, its receipt, and the expected (current) values
// the evidence is checked against.
type Input struct {
	ExpectedVersion      int
	ExpectedProblemHash  string
	ExpectedArtifactHash string
	Manifest             *Manifest
	Receipt              *Receipt
	Now                  time.Time
}

// Validator checks manifests and receipts against expected values, a
// signature adapter, and a trust store.
type Validator struct {
	Adapter Adapter
	Trust   *TrustStore
}

func NewValidator(a Adapter, t *TrustStore) *Validator {
	return &Validator{Adapter: a, Trust: t}
}

// Validate checks the evidence and returns a report. It never mutates the
// manifest (in particular it never fills in Conclusion).
func (v *Validator) Validate(in Input) Report {
	rep := Report{Status: StatusValid}
	link := func(name, pos string, st Status, detail string) {
		rep.Chain = append(rep.Chain, ChainLink{Name: name, Position: pos, Status: st, Detail: detail})
	}
	reject := func(pos, reason string) {
		rep.Rejections = append(rep.Rejections, Rejection{Position: pos, Reason: reason})
	}

	m := in.Manifest
	if m == nil {
		link("manifest", "manifest", StatusIncomplete, "no manifest provided")
		reject("manifest", "missing evidence manifest")
		return finish(rep)
	}

	if m.Version != in.ExpectedVersion {
		link("version", "version", StatusRejected,
			fmt.Sprintf("evidence version %d invalidated by update to %d", m.Version, in.ExpectedVersion))
		reject("version", fmt.Sprintf("stale evidence: version %d, expected %d", m.Version, in.ExpectedVersion))
	} else {
		link("version", "version", StatusValid, fmt.Sprintf("version %d current", m.Version))
	}

	switch {
	case m.ProblemHash == "":
		link("problem_hash", "problem_hash", StatusIncomplete, "problem statement hash missing")
		reject("problem_hash", "missing problem statement hash")
	case m.ProblemHash != in.ExpectedProblemHash:
		link("problem_hash", "problem_hash", StatusRejected, "problem statement hash mismatch")
		reject("problem_hash", "problem statement hash does not match expected hash")
	default:
		link("problem_hash", "problem_hash", StatusValid, "problem statement hash matches")
	}

	switch {
	case m.ArtifactHash == "":
		link("artifact_hash", "artifact_hash", StatusIncomplete, "run artifact hash missing")
		reject("artifact_hash", "missing run artifact hash")
	case m.ArtifactHash != in.ExpectedArtifactHash:
		link("artifact_hash", "artifact_hash", StatusRejected, "run artifact hash mismatch")
		reject("artifact_hash", "run artifact hash does not match expected hash")
	default:
		link("artifact_hash", "artifact_hash", StatusValid, "run artifact hash matches")
	}

	switch {
	case m.Score == nil:
		link("score", "score", StatusIncomplete, "score field missing")
		reject("score", "missing score")
	case *m.Score < MinScore || *m.Score > MaxScore:
		link("score", "score", StatusRejected,
			fmt.Sprintf("score %d outside [%d,%d]", *m.Score, MinScore, MaxScore))
		reject("score", fmt.Sprintf("score must be an integer in [%d,%d], got %d", MinScore, MaxScore, *m.Score))
	default:
		link("score", "score", StatusValid, fmt.Sprintf("score %d within [%d,%d]", *m.Score, MinScore, MaxScore))
	}

	v.validateReceipt(in, m, link, reject)
	return finish(rep)
}

func (v *Validator) validateReceipt(in Input, m *Manifest, link func(string, string, Status, string), reject func(string, string)) {
	r := in.Receipt
	if r == nil {
		link("receipt", "receipt", StatusIncomplete, "no signature receipt provided")
		reject("receipt", "missing signature receipt")
		return
	}
	if r.ManifestID != m.ID {
		link("receipt", "receipt.manifest_id", StatusRejected, "receipt bound to a different manifest")
		reject("receipt.manifest_id", "receipt manifest id mismatch")
		return
	}
	if r.Version != m.Version {
		link("receipt", "receipt.version", StatusRejected,
			fmt.Sprintf("receipt version %d stale against manifest version %d", r.Version, m.Version))
		reject("receipt.version", "receipt version does not match manifest version")
		return
	}
	if r.Digest != m.Digest() {
		link("receipt", "receipt.digest", StatusRejected, "receipt digest mismatch")
		reject("receipt.digest", "receipt digest does not match manifest digest")
		return
	}
	if v.Adapter != nil {
		if err := v.Adapter.Verify(r.Signer, r.Payload(), r.Signature); err != nil {
			link("receipt", "receipt.signature", StatusRejected, "signature verification failed")
			reject("receipt.signature", "signature verification failed: "+err.Error())
			return
		}
	}
	if v.Trust != nil {
		if revokedAt, revoked := v.Trust.RevokedAt(r.Signer, r.TrustVersion); revoked && !r.SignedAt.Before(revokedAt) {
			link("receipt", "receipt.trust_version", StatusRejected,
				fmt.Sprintf("signer trust version %d revoked at %s", r.TrustVersion, revokedAt.UTC().Format(time.RFC3339)))
			reject("receipt.trust_version", fmt.Sprintf("signer %q trust version %d revoked", r.Signer, r.TrustVersion))
			return
		}
	}
	link("receipt", "receipt", StatusValid,
		fmt.Sprintf("signed by %q at trust version %d", r.Signer, r.TrustVersion))
}

func finish(rep Report) Report {
	incomplete := false
	for _, l := range rep.Chain {
		if l.Status == StatusRejected {
			rep.Status = StatusRejected
			return rep
		}
		if l.Status == StatusIncomplete {
			incomplete = true
		}
	}
	if incomplete {
		rep.Status = StatusIncomplete
	}
	return rep
}
