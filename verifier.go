package q214

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Clock supplies the current time. Inject a fixed or controllable clock in
// tests and deterministic workers.
type Clock interface {
	Now() time.Time
}

// ClockFunc adapts a function to the Clock interface.
type ClockFunc func() time.Time

func (f ClockFunc) Now() time.Time { return f() }

// RevocationChecker answers whether a jti has been revoked. Revocation is
// consulted before signature and time-window checks so a revoked token can
// never reach the business callback.
type RevocationChecker interface {
	IsRevoked(jti string) bool
}

// RevocationCheckerFunc adapts a function to the RevocationChecker interface.
type RevocationCheckerFunc func(jti string) bool

func (f RevocationCheckerFunc) IsRevoked(jti string) bool { return f(jti) }

// Claims is the validated payload handed to a business callback. All fields
// are guaranteed present and well typed by the time a callback observes them.
type Claims struct {
	Audience  string
	Expiry    int64
	NotBefore int64
	JTI       string
}

type rawHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
}

// Pointer fields make "absent" distinguishable from JSON null or zero values.
type rawPayload struct {
	Aud *string          `json:"aud"`
	Exp *json.RawMessage `json:"exp"`
	Nbf *json.RawMessage `json:"nbf"`
	Jti *string          `json:"jti"`
}

// Verifier embeds compact HS256 token verification into a service. A Verifier
// is safe for concurrent use.
type Verifier struct {
	keys    *KeySet
	clock   Clock
	aud     string
	revoker RevocationChecker
}

// NewVerifier builds a verifier bound to a fixed audience and a versioned key
// set. The clock is invoked for every verification; the revocation checker may
// be nil when no jti revocation list exists.
func NewVerifier(keys *KeySet, clock Clock, audience string, revoker RevocationChecker) (*Verifier, error) {
	if keys == nil {
		return nil, errors.New("q214: nil key set")
	}
	if clock == nil {
		return nil, errors.New("q214: nil clock")
	}
	if audience == "" {
		return nil, errors.New("q214: empty audience")
	}
	return &Verifier{keys: keys, clock: clock, aud: audience, revoker: revoker}, nil
}

// Verify validates a compact token and returns its claims only after every
// structural, revocation, signature and time-window check has passed.
func (v *Verifier) Verify(token string) (*Claims, error) {
	return v.verify(token)
}

// VerifyCallback runs callback with the validated claims. The callback is
// never invoked when any verification step fails, so untrusted payload data
// cannot leak into business logic on an invalid token.
func (v *Verifier) VerifyCallback(token string, callback func(*Claims)) error {
	claims, err := v.verify(token)
	if err != nil {
		return err
	}
	callback(claims)
	return nil
}

func (v *Verifier) verify(token string) (*Claims, error) {
	segments := strings.Split(token, ".")
	if len(segments) != 3 || segments[0] == "" || segments[1] == "" || segments[2] == "" {
		return nil, ErrMalformedToken
	}
	headerRaw, err := decodeBase64URLCanonical(segments[0])
	if err != nil {
		return nil, err
	}
	payloadRaw, err := decodeBase64URLCanonical(segments[1])
	if err != nil {
		return nil, err
	}
	signature, err := decodeBase64URLCanonical(segments[2])
	if err != nil {
		return nil, err
	}

	var header rawHeader
	if err := strictUnmarshal(headerRaw, &header); err != nil {
		return nil, err
	}
	if header.Alg == "" || header.Kid == "" {
		return nil, ErrBadHeader
	}

	var payload rawPayload
	if err := strictUnmarshal(payloadRaw, &payload); err != nil {
		return nil, err
	}

	// Revocation takes priority over signature and validity window. A token
	// can only be revoked by jti, so a missing jti fails later as a bad claim.
	if payload.Jti != nil && v.revoker != nil && v.revoker.IsRevoked(*payload.Jti) {
		return nil, ErrRevoked
	}

	if header.Alg != "HS256" {
		return nil, ErrUnsupportedAlgorithm
	}

	// Pin one immutable key-set snapshot for the whole verification.
	snap := v.keys.snapshot()
	secret, ok := snap.byKid[header.Kid]
	if !ok {
		return nil, ErrUnknownKey
	}
	if len(secret) < minKeyBytes {
		return nil, ErrBadSignature
	}

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(segments[0] + "." + segments[1]))
	expected := mac.Sum(nil)
	if len(signature) != len(expected) || subtle.ConstantTimeCompare(signature, expected) != 1 {
		return nil, ErrBadSignature
	}

	claims, err := validateClaims(payload, v.aud, v.clock.Now().Unix())
	if err != nil {
		return nil, err
	}
	return claims, nil
}

func validateClaims(payload rawPayload, audience string, now int64) (*Claims, error) {
	if payload.Aud == nil || payload.Exp == nil || payload.Nbf == nil || payload.Jti == nil {
		return nil, ErrMissingClaim
	}
	if *payload.Aud == "" || *payload.Jti == "" {
		return nil, ErrBadClaim
	}

	exp, err := integerClaim(*payload.Exp)
	if err != nil {
		return nil, err
	}
	nbf, err := integerClaim(*payload.Nbf)
	if err != nil {
		return nil, err
	}

	if *payload.Aud != audience {
		return nil, ErrAudience
	}

	// Half-open validity interval: nbf <= now < exp.
	if now >= exp {
		return nil, ErrExpired
	}
	if now < nbf {
		return nil, ErrNotYetValid
	}

	return &Claims{
		Audience:  *payload.Aud,
		Expiry:    exp,
		NotBefore: nbf,
		JTI:       *payload.Jti,
	}, nil
}

// integerClaim parses exp/nbf as JSON numbers expressed in whole seconds.
// RawMessage preserves the original token type so quoted strings, booleans,
// objects, fractions and overflowing values are all rejected.
func integerClaim(raw json.RawMessage) (int64, error) {
	// A JSON number token starts with '-' or a digit; reject quoted strings,
	// booleans, null, arrays and objects before assigning to json.Number,
	// whose underlying string type would otherwise swallow a JSON string.
	if len(raw) == 0 || (raw[0] != '-' && (raw[0] < '0' || raw[0] > '9')) {
		return 0, ErrBadClaim
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return 0, ErrBadClaim
	}
	value, err := number.Int64()
	if err != nil {
		return 0, ErrBadClaim
	}
	return value, nil
}
