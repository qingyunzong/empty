package q245

import "errors"

// Sentinel errors returned by the middleware and its storage interfaces.
var (
	// ErrUnknownTenant is returned when a route resolves to a tenant that
	// the TenantKeyStore does not know.
	ErrUnknownTenant = errors.New("q245: unknown tenant")

	// ErrDuplicateNonce is returned when a nonce is already occupied by an
	// in-flight or unexpired transaction for the same tenant.
	ErrDuplicateNonce = errors.New("q245: duplicate nonce")

	// ErrBodyTooLarge is returned when the request body exceeds the
	// configured byte limit.
	ErrBodyTooLarge = errors.New("q245: request body too large")

	// ErrInvalidSignature is returned when the HMAC signature is missing,
	// malformed or does not match.
	ErrInvalidSignature = errors.New("q245: invalid signature")

	// ErrTimestampOutOfRange is returned when the timestamp header is
	// missing, not a Unix epoch second, or outside the configured clock
	// tolerance.
	ErrTimestampOutOfRange = errors.New("q245: timestamp out of tolerance")
)
