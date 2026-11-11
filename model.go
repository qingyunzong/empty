package q216

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

// Roles recognized by the component. A root metadata file that names any
// other role is rejected.
const (
	RoleRoot    = "root"
	RoleTargets = "targets"
)

// KeyTypeEd25519 is the only supported key type.
const KeyTypeEd25519 = "ed25519"

// Document type tags carried inside the signed payload.
const (
	typeRoot     = "root"
	typeManifest = "manifest"
)

// Sentinel errors returned by the verifier. Callers can use errors.Is to
// distinguish failure classes.
var (
	ErrUninitialized    = errors.New("q216: no trusted state has been bootstrapped")
	ErrMalformed        = errors.New("q216: malformed signed metadata")
	ErrDuplicateKey     = errors.New("q216: duplicate key encountered")
	ErrUnknownRole      = errors.New("q216: unknown role in root metadata")
	ErrUnknownField     = errors.New("q216: unknown field in metadata")
	ErrThresholdNotMet  = errors.New("q216: signature threshold not met")
	ErrInvalidSignature = errors.New("q216: invalid signature")
	ErrVersionRollback  = errors.New("q216: metadata version is not greater than the trusted version")
	ErrExpired          = errors.New("q216: metadata has expired")
	ErrRootRotation     = errors.New("q216: root rotation does not satisfy both root thresholds")
	ErrTargetMismatch   = errors.New("q216: downloaded target does not match the manifest")
	ErrPersist          = errors.New("q216: state persistence failed")
)

// PublicKey is an Ed25519 key entry as listed in root metadata.
type PublicKey struct {
	// KeyID is the lowercase hex SHA-256 of the RFC 8785 canonical bytes
	// of the key object {"keytype":"ed25519","keyval":{"public":"..."}}.
	KeyID string `json:"keyid"`
	// Type must equal KeyTypeEd25519.
	Type string `json:"keytype"`
	// KeyVal carries the lowercase hex-encoded 32-byte Ed25519 public key.
	KeyVal struct {
		Public string `json:"public"`
	} `json:"keyval"`
}

// Role binds a role name to its trusted key identifiers and threshold.
type Role struct {
	// Name is one of RoleRoot or RoleTargets.
	Name string `json:"name"`
	// KeyIDs lists unique key identifiers authorized for the role.
	KeyIDs []string `json:"keyids"`
	// Threshold is the minimum number of distinct valid signatures
	// required from the role's key set.
	Threshold int `json:"threshold"`
}

// SignedRoot is the signed root metadata document.
type SignedRoot struct {
	Type    string      `json:"type"`
	Version int64       `json:"version"`
	Expires string      `json:"expires"`
	Keys    []PublicKey `json:"keys"`
	Roles   []Role      `json:"roles"`
}

// TargetFile describes one downloadable file in a manifest.
type TargetFile struct {
	// Name is the manifest-unique target identifier (path-like string).
	Name string `json:"name"`
	// Length is the expected exact file size in bytes.
	Length int64 `json:"length"`
	// Hashes carries the lowercase hex SHA-256 digest under key "sha256".
	Hashes map[string]string `json:"hashes"`
	// Version is the monotonically increasing per-target version number.
	Version int64 `json:"version"`
}

// SignedManifest is the signed download manifest (targets metadata).
type SignedManifest struct {
	Type    string       `json:"type"`
	Version int64        `json:"version"`
	Expires string       `json:"expires"`
	Targets []TargetFile `json:"targets"`
}

// Signature is one Ed25519 signature over the canonical signed payload.
type Signature struct {
	KeyID string `json:"keyid"`
	// Sig is the lowercase hex-encoded Ed25519 signature.
	Sig string `json:"sig"`
}

// envelope is the on-the-wire signed metadata container.
type envelope struct {
	Signatures []Signature `json:"signatures"`
	// Signed is kept as a generic tree so the exact canonical bytes used
	// for signature verification are derived from validated input.
	Signed map[string]any `json:"signed"`
}

// ComputeKeyID returns the key identifier for a hex-encoded Ed25519
// public key: SHA-256 over the RFC 8785 canonical key object.
func ComputeKeyID(hexPublic string) (string, error) {
	raw, err := decodeEd25519Public(hexPublic)
	if err != nil {
		return "", err
	}
	keyObj := map[string]any{
		"keytype": KeyTypeEd25519,
		"keyval":  map[string]any{"public": hex.EncodeToString(raw)},
	}
	canon, err := canonicalJSON(keyObj)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canon)
	return hex.EncodeToString(digest[:]), nil
}

// decodeEd25519Public decodes and length-checks a hex Ed25519 public key.
func decodeEd25519Public(hexPublic string) (ed25519.PublicKey, error) {
	raw, err := hex.DecodeString(hexPublic)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid public key hex: %v", ErrMalformed, err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%w: ed25519 public key must be %d bytes, got %d",
			ErrMalformed, ed25519.PublicKeySize, len(raw))
	}
	return ed25519.PublicKey(raw), nil
}

// knownRole reports whether name is an accepted role.
func knownRole(name string) bool {
	return name == RoleRoot || name == RoleTargets
}
