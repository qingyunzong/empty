package q214

import "errors"

var (
	// ErrMalformedToken is returned when the compact serialization is not
	// exactly three non-empty base64url segments.
	ErrMalformedToken = errors.New("q214: malformed token")

	// ErrNonCanonicalEncoding is returned when a segment uses padding, a
	// non-base64url alphabet, or any byte sequence that is not its shortest
	// canonical base64url representation.
	ErrNonCanonicalEncoding = errors.New("q214: non-canonical base64url encoding")

	// ErrMalformedJSON is returned when a header or payload is not a single
	// valid JSON object, contains duplicate keys, or carries unknown fields.
	ErrMalformedJSON = errors.New("q214: malformed JSON")

	// ErrBadHeader is returned when the header is missing "alg"/"kid" or uses
	// types other than JSON strings.
	ErrBadHeader = errors.New("q214: invalid header")

	// ErrUnsupportedAlgorithm is returned when "alg" is anything other than
	// HS256, including the "none" algorithm and RSA/ECDSA identifiers.
	ErrUnsupportedAlgorithm = errors.New("q214: unsupported algorithm")

	// ErrUnknownKey is returned when the header "kid" is absent from the
	// key set captured for the verification.
	ErrUnknownKey = errors.New("q214: unknown key id")

	// ErrBadSignature is returned when the HMAC-SHA256 signature does not
	// match, or the referenced key is too short to be accepted.
	ErrBadSignature = errors.New("q214: signature verification failed")

	// ErrMissingClaim is returned when aud, exp, nbf or jti is absent.
	ErrMissingClaim = errors.New("q214: missing required claim")

	// ErrBadClaim is returned when a required claim has the wrong JSON type
	// or value shape (for example aud as an array, exp as a fraction).
	ErrBadClaim = errors.New("q214: invalid claim")

	// ErrAudience is returned when the payload audience differs from the
	// audience configured on the verifier.
	ErrAudience = errors.New("q214: audience mismatch")

	// ErrExpired is returned when now >= exp; the interval is half open.
	ErrExpired = errors.New("q214: token expired")

	// ErrNotYetValid is returned when now < nbf.
	ErrNotYetValid = errors.New("q214: token not yet valid")

	// ErrRevoked is returned before signature verification whenever the
	// RevocationChecker reports the jti as revoked.
	ErrRevoked = errors.New("q214: jti revoked")
)
