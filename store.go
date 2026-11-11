package q245

import (
	"context"
	"time"
)

// TenantKeyStore resolves the HMAC secret bound to a tenant.
//
// The tenant identifier always comes from route state (see
// TenantResolver), never from the request body, so a caller cannot forge
// the tenant a request is billed to.
type TenantKeyStore interface {
	// Secret returns the HMAC-SHA256 secret configured for tenant.
	// Implementations must return ErrUnknownTenant when the tenant is
	// unknown.
	Secret(ctx context.Context, tenant string) (secret []byte, err error)
}

// Tx is the transaction handed to a MessageHandler. Business writes made
// through it commit or roll back together with the nonce occupation.
type Tx interface {
	// Context returns the context bound to the transaction.
	Context() context.Context
}

// TransactionManager runs a unit of work that occupies a nonce and runs
// the business handler in one atomic transaction.
//
// WithinTx must:
//   - start a transaction,
//   - insert/occupy (tenantID, nonce) inside that transaction; a live
//     duplicate must fail with ErrDuplicateNonce and roll back,
//   - invoke fn with the transaction,
//   - commit only when fn returns nil; otherwise roll back and return
//     fn's error.
//
// Because the nonce row and the business writes share one transaction,
// a rollback releases the nonce and a later retry with the same nonce
// can succeed.
type TransactionManager interface {
	WithinTx(ctx context.Context, tenantID, nonce string, expiresAt time.Time, fn func(Tx) error) error
}
