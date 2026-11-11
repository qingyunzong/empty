package q245

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Signature headers carrying the authentication material. The signed
// payload is the same three values on every request, so the signature
// binds the timestamp and nonce to the exact request body.
const (
	HeaderTimestamp = "X-Webhook-Timestamp"
	HeaderNonce     = "X-Webhook-Nonce"
	HeaderSignature = "X-Webhook-Signature"
)

// ctxKey is an unexported key type for values stored by the middleware.
type ctxKey int

const (
	tenantKey ctxKey = iota + 1
	txKey
)

// MessageHandler processes one verified webhook message inside the
// transaction that holds the nonce occupation. It must not write to the
// HTTP response directly: returning an error rolls the transaction back
// and frees the nonce for a retry, while a nil error commits it.
type MessageHandler interface {
	HandleWebhook(ctx context.Context, tx Tx, tenant string, body []byte) error
}

// MessageHandlerFunc adapts a plain function to MessageHandler.
type MessageHandlerFunc func(ctx context.Context, tx Tx, tenant string, body []byte) error

// HandleWebhook implements MessageHandler.
func (f MessageHandlerFunc) HandleWebhook(ctx context.Context, tx Tx, tenant string, body []byte) error {
	return f(ctx, tx, tenant, body)
}

// TenantResolver extracts the tenant bound to the request's route.
// Implementations must derive the tenant solely from routing state
// (path, host, mounted route) and never from the request body.
type TenantResolver func(r *http.Request) (string, error)

// Config configures a Middleware.
type Config struct {
	// Keys resolves the per-tenant HMAC secret. Required.
	Keys TenantKeyStore

	// TxManager makes nonce occupation and business submission atomic.
	// Required.
	TxManager TransactionManager

	// Handler receives verified messages. Required.
	Handler MessageHandler

	// ResolveTenant derives the tenant from route state. Optional; the
	// default reads the {tenant} path wildcard via r.PathValue.
	ResolveTenant TenantResolver

	// ClockTolerance is the maximum absolute difference between the
	// timestamp header and the current time. Required and positive.
	ClockTolerance time.Duration

	// MaxBodyBytes bounds how many request body bytes are buffered.
	// Bodies larger than this are rejected with ErrBodyTooLarge.
	// Required and positive.
	MaxBodyBytes int64

	// NonceTTL decides how long an occupied nonce stays live before it
	// can be reclaimed and reused. Required and positive.
	NonceTTL time.Duration

	// Clock supplies the current time. Optional; defaults to time.Now.
	Clock Clock
}

// Middleware verifies webhook signatures and dispatches verified
// messages through an atomic nonce-guarded transaction.
type Middleware struct {
	cfg Config
}

// New validates cfg and returns a Middleware.
func New(cfg Config) (*Middleware, error) {
	if cfg.Keys == nil {
		return nil, errors.New("q245: Config.Keys is required")
	}
	if cfg.TxManager == nil {
		return nil, errors.New("q245: Config.TxManager is required")
	}
	if cfg.Handler == nil {
		return nil, errors.New("q245: Config.Handler is required")
	}
	if cfg.ResolveTenant == nil {
		cfg.ResolveTenant = defaultTenantResolver
	}
	if cfg.ClockTolerance <= 0 {
		return nil, errors.New("q245: Config.ClockTolerance must be positive")
	}
	if cfg.MaxBodyBytes <= 0 {
		return nil, errors.New("q245: Config.MaxBodyBytes must be positive")
	}
	if cfg.NonceTTL <= 0 {
		return nil, errors.New("q245: Config.NonceTTL must be positive")
	}
	if cfg.Clock == nil {
		cfg.Clock = systemClock{}
	}
	return &Middleware{cfg: cfg}, nil
}

// ServeHTTP implements http.Handler.
func (m *Middleware) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := m.serve(r); err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

func (m *Middleware) serve(r *http.Request) error {
	// Tenant comes from the route only; body content is never consulted.
	tenant, err := m.cfg.ResolveTenant(r)
	if err != nil {
		return err
	}

	nonce := r.Header.Get(HeaderNonce)
	if nonce == "" {
		return ErrInvalidSignature
	}

	ts, err := parseTimestamp(r.Header.Get(HeaderTimestamp))
	if err != nil {
		return err
	}
	now := m.cfg.Clock.Now()
	if absDuration(now.Sub(ts)) > m.cfg.ClockTolerance {
		return ErrTimestampOutOfRange
	}

	// Stream the body under a hard byte cap; the exact bytes buffered
	// here are both hashed for verification and handed to the handler.
	body, err := readCappedBody(r.Body, m.cfg.MaxBodyBytes)
	if err != nil {
		return err
	}

	secret, err := m.cfg.Keys.Secret(r.Context(), tenant)
	if err != nil {
		return err
	}

	if err := verifySignature(secret, ts.Unix(), nonce, body, r.Header.Get(HeaderSignature)); err != nil {
		return err
	}

	// Verification passed: occupy the nonce and run the business handler
	// in the same transaction. Duplicate/live nonces fail before the
	// handler runs, and rollback releases the nonce for retry.
	ctx := context.WithValue(r.Context(), tenantKey, tenant)
	return m.cfg.TxManager.WithinTx(ctx, tenant, nonce, now.Add(m.cfg.NonceTTL), func(tx Tx) error {
		handlerCtx := context.WithValue(tx.Context(), txKey, tx)
		return m.cfg.Handler.HandleWebhook(handlerCtx, tx, tenant, body)
	})
}

// defaultTenantResolver reads the {tenant} wildcard from the route.
func defaultTenantResolver(r *http.Request) (string, error) {
	tenant := r.PathValue("tenant")
	if tenant == "" {
		return "", ErrUnknownTenant
	}
	return tenant, nil
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, ErrUnknownTenant):
		status = http.StatusNotFound
	case errors.Is(err, ErrDuplicateNonce):
		status = http.StatusConflict
	case errors.Is(err, ErrBodyTooLarge):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, ErrTimestampOutOfRange):
		status = http.StatusUnauthorized
	case errors.Is(err, ErrInvalidSignature):
		status = http.StatusUnauthorized
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":"` + err.Error() + `"}`))
}

// Sign computes the hex-encoded HMAC-SHA256 signature over the
// timestamp, nonce and SHA-256 digest of body. Webhook producers use the
// same function to build the X-Webhook-Signature header.
//
// The signed payload is:
//
//	fmt.Sprintf("%d\n%s\n%s", timestamp, nonce, hex(sha256(body)))
func Sign(secret []byte, timestamp int64, nonce string, body []byte) string {
	digest := sha256.Sum256(body)
	payload := strconv.FormatInt(timestamp, 10) + "\n" + nonce + "\n" + hex.EncodeToString(digest[:])

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

func verifySignature(secret []byte, timestamp int64, nonce string, body []byte, signature string) error {
	if signature == "" {
		return ErrInvalidSignature
	}
	provided, err := hex.DecodeString(signature)
	if err != nil {
		return ErrInvalidSignature
	}
	expected, err := hex.DecodeString(Sign(secret, timestamp, nonce, body))
	if err != nil {
		return ErrInvalidSignature
	}
	if subtle.ConstantTimeCompare(provided, expected) != 1 {
		return ErrInvalidSignature
	}
	return nil
}

func parseTimestamp(raw string) (time.Time, error) {
	if raw == "" {
		return time.Time{}, ErrTimestampOutOfRange
	}
	seconds, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return time.Time{}, ErrTimestampOutOfRange
	}
	return time.Unix(seconds, 0).UTC(), nil
}

// readCappedBody streams r into memory but never buffers more than
// limit bytes. A body exceeding the limit returns ErrBodyTooLarge
// without reading the remainder.
func readCappedBody(r io.Reader, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, ErrBodyTooLarge
	}
	return body, nil
}

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

// TenantFromContext returns the route-bound tenant stored by the
// middleware, or "" when absent.
func TenantFromContext(ctx context.Context) string {
	tenant, _ := ctx.Value(tenantKey).(string)
	return tenant
}

// TxFromContext returns the in-flight transaction stored by the
// middleware, or nil when called outside a MessageHandler.
func TxFromContext(ctx context.Context) Tx {
	tx, _ := ctx.Value(txKey).(Tx)
	return tx
}
