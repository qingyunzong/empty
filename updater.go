package q216

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// parsedEnvelope is a validated envelope together with the exact RFC 8785
// canonical bytes of its signed payload.
type parsedEnvelope struct {
	canonical []byte
	signed    map[string]any
	sigs      []Signature
}

// parseEnvelope performs the input-level validation shared by roots and
// manifests: strict JSON decoding, duplicate-key rejection, duplicate
// signature key rejection and canonicalization of the signed payload.
func parseEnvelope(raw []byte) (*parsedEnvelope, error) {
	tree, err := decodeJSONStrict(raw)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate JSON object key") {
			return nil, fmt.Errorf("%w: %v", ErrDuplicateKey, err)
		}
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	obj, ok := tree.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%w: top-level JSON value must be an object", ErrMalformed)
	}

	var env envelope
	if err := strictUnmarshal(obj, &env); err != nil {
		return nil, classifySchemaError(err)
	}
	if len(env.Signatures) == 0 {
		return nil, fmt.Errorf("%w: envelope carries no signatures", ErrMalformed)
	}

	seenSigKey := make(map[string]struct{}, len(env.Signatures))
	for _, sig := range env.Signatures {
		if sig.KeyID == "" || sig.Sig == "" {
			return nil, fmt.Errorf("%w: signature entries require keyid and sig", ErrMalformed)
		}
		if _, dup := seenSigKey[sig.KeyID]; dup {
			return nil, fmt.Errorf("%w: signature keyid %q appears more than once",
				ErrDuplicateKey, sig.KeyID)
		}
		seenSigKey[sig.KeyID] = struct{}{}
		if _, err := hex.DecodeString(sig.Sig); err != nil {
			return nil, fmt.Errorf("%w: invalid signature hex: %v", ErrMalformed, err)
		}
	}

	canon, err := canonicalJSON(env.Signed)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	return &parsedEnvelope{
		canonical: canon,
		signed:    env.Signed,
		sigs:      env.Signatures,
	}, nil
}

// trustedRoot is a fully validated root document.
type trustedRoot struct {
	env     *parsedEnvelope
	doc     *SignedRoot
	expires time.Time
	keys    map[string]PublicKey
	pubKeys map[string]ed25519.PublicKey
	roles   map[string]Role
}

// compileRoot validates a parsed envelope against the root schema and
// returns a trustedRoot. It does not verify signatures (the caller decides
// which root's threshold applies).
func compileRoot(env *parsedEnvelope) (*trustedRoot, error) {
	docType, err := requireString(env.signed, "type")
	if err != nil {
		return nil, err
	}
	if docType != typeRoot {
		return nil, fmt.Errorf("%w: expected type %q, got %q", ErrMalformed, typeRoot, docType)
	}

	version, err := requirePositiveInt(env.signed, "version")
	if err != nil {
		return nil, err
	}
	expiresRaw, err := requireString(env.signed, "expires")
	if err != nil {
		return nil, err
	}
	expires, err := time.Parse(time.RFC3339, expiresRaw)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid expires timestamp: %v", ErrMalformed, err)
	}

	var doc SignedRoot
	if err := strictUnmarshal(env.signed, &doc); err != nil {
		return nil, classifySchemaError(err)
	}
	doc.Version = version

	keys := make(map[string]PublicKey, len(doc.Keys))
	pubKeys := make(map[string]ed25519.PublicKey, len(doc.Keys))
	seenRaw := make(map[string]struct{}, len(doc.Keys))
	for _, key := range doc.Keys {
		if key.Type != KeyTypeEd25519 {
			return nil, fmt.Errorf("%w: unsupported key type %q", ErrMalformed, key.Type)
		}
		pub, err := decodeEd25519Public(key.KeyVal.Public)
		if err != nil {
			return nil, err
		}
		expectedID, err := ComputeKeyID(key.KeyVal.Public)
		if err != nil {
			return nil, err
		}
		if key.KeyID != expectedID {
			return nil, fmt.Errorf("%w: keyid %q does not match the public key",
				ErrMalformed, key.KeyID)
		}
		if _, dup := keys[key.KeyID]; dup {
			return nil, fmt.Errorf("%w: keyid %q listed more than once",
				ErrDuplicateKey, key.KeyID)
		}
		if _, dup := seenRaw[string(pub)]; dup {
			return nil, fmt.Errorf("%w: public key %q registered more than once",
				ErrDuplicateKey, key.KeyID)
		}
		seenRaw[string(pub)] = struct{}{}
		keys[key.KeyID] = key
		pubKeys[key.KeyID] = pub
	}

	roles := make(map[string]Role, len(doc.Roles))
	for _, role := range doc.Roles {
		if !knownRole(role.Name) {
			return nil, fmt.Errorf("%w: role %q", ErrUnknownRole, role.Name)
		}
		if _, dup := roles[role.Name]; dup {
			return nil, fmt.Errorf("%w: role %q listed more than once",
				ErrDuplicateKey, role.Name)
		}
		if role.Threshold <= 0 {
			return nil, fmt.Errorf("%w: role %q threshold must be positive",
				ErrMalformed, role.Name)
		}
		seenRoleKey := make(map[string]struct{}, len(role.KeyIDs))
		for _, id := range role.KeyIDs {
			if _, ok := keys[id]; !ok {
				return nil, fmt.Errorf("%w: role %q references unknown keyid %q",
					ErrMalformed, role.Name, id)
			}
			if _, dup := seenRoleKey[id]; dup {
				return nil, fmt.Errorf("%w: role %q lists keyid %q more than once",
					ErrDuplicateKey, role.Name, id)
			}
			seenRoleKey[id] = struct{}{}
		}
		if int64(role.Threshold) > int64(len(role.KeyIDs)) {
			return nil, fmt.Errorf("%w: role %q threshold %d exceeds its key count %d",
				ErrMalformed, role.Name, role.Threshold, len(role.KeyIDs))
		}
		roles[role.Name] = role
	}
	for _, required := range []string{RoleRoot, RoleTargets} {
		if _, ok := roles[required]; !ok {
			return nil, fmt.Errorf("%w: root metadata must define role %q",
				ErrMalformed, required)
		}
	}

	return &trustedRoot{
		env:     env,
		doc:     &doc,
		expires: expires,
		keys:    keys,
		pubKeys: pubKeys,
		roles:   roles,
	}, nil
}

// verifySignatures checks that the envelope carries at least the role's
// threshold of distinct, valid Ed25519 signatures from keys assigned to
// that role. Signatures from keys not assigned to the role are ignored,
// following the TUF counting model. The strict parser already guarantees
// that no key identifier appears twice, so every counted key is distinct.
func (r *trustedRoot) verifySignatures(env *parsedEnvelope, roleName string) error {
	role := r.roles[roleName]
	assigned := make(map[string]struct{}, len(role.KeyIDs))
	for _, id := range role.KeyIDs {
		assigned[id] = struct{}{}
	}

	valid := 0
	for _, sig := range env.sigs {
		if _, ok := assigned[sig.KeyID]; !ok {
			continue
		}
		signature, err := hex.DecodeString(sig.Sig)
		if err != nil {
			return fmt.Errorf("%w: invalid signature hex: %v", ErrMalformed, err)
		}
		if !ed25519.Verify(r.pubKeys[sig.KeyID], env.canonical, signature) {
			return fmt.Errorf("%w: signature from keyid %q failed verification",
				ErrInvalidSignature, sig.KeyID)
		}
		valid++
	}
	if valid < role.Threshold {
		return fmt.Errorf("%w: role %q needs %d signatures, has %d",
			ErrThresholdNotMet, roleName, role.Threshold, valid)
	}
	return nil
}
