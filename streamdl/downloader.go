package streamdl

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"strings"
)

// Sentinel errors. Concrete failures are wrapped with these errors so callers
// can use errors.Is.
var (
	// ErrProtocol means the server response violates the download contract
	// (bad status, missing strong ETag, inconsistent range metadata, ...).
	ErrProtocol = errors.New("streamdl: protocol violation")

	// ErrDigest means the fully received content does not match the
	// caller-supplied SHA-256 digest.
	ErrDigest = errors.New("streamdl: sha256 digest mismatch")
)

// Requester executes one HTTP request against the remote resource.
//
// method is always http.MethodGet. headers carries the headers the downloader
// requires (Range and If-Range for resumes); it may be empty for a plain GET.
// The implementation must attach those headers to the outgoing request and
// return the unmodified *http.Response, including its readable Body. The
// downloader closes the body.
type Requester func(ctx context.Context, method string, headers http.Header) (*http.Response, error)

// Txn is one append transaction against the staging store.
//
// Writes before Commit are not durable. Commit atomically durably persists all
// writes together with the new staged length and returns the total persisted
// length; a failed Commit leaves the store at the previous savepoint.
// Rollback discards uncommitted writes.
type Txn interface {
	io.Writer
	Commit(ctx context.Context) (persistedLength int64, err error)
	Rollback(ctx context.Context) error
}

// Staged describes the durable resume state.
type Staged struct {
	// Length is the number of bytes already persisted.
	Length int64
	// ETag is the strong entity tag persisted together with the bytes.
	ETag string
	// Total is the entity's full content length.
	Total int64
}

// Staging is the transactional byte store supplied by the caller.
//
// Implementations must guarantee that bytes and their length are persisted
// atomically: after a crash or failed Commit, Load reflects the previous
// savepoint exactly, never a torn length.
type Staging interface {
	// Load returns the current savepoint. exists is false when nothing is
	// staged.
	Load(ctx context.Context) (staged Staged, exists bool, err error)

	// Begin opens an append transaction that expects to write at start.
	// start is zero for a fresh entity and the persisted length for a resume.
	Begin(ctx context.Context, start int64, etag string, total int64) (Txn, error)

	// Reader returns the currently persisted bytes and their length.
	Reader(ctx context.Context) (io.ReadCloser, int64, error)

	// Discard removes all staged state. It must be idempotent.
	Discard(ctx context.Context) error

	// Publish atomically materializes the persisted content at dst.
	Publish(ctx context.Context, dst string) error
}

// Downloader runs resumable downloads. The zero value is not usable; set
// Request and Staging.
type Downloader struct {
	// Request executes remote HTTP requests. Required.
	Request Requester
	// Staging durably stores partial content. Required.
	Staging Staging
	// ChunkSize bounds each read/write/commit cycle. Zero uses a default.
	ChunkSize int
}

const defaultChunkSize = 64 * 1024

func (d *Downloader) chunkSize() int {
	if d.ChunkSize > 0 {
		return d.ChunkSize
	}
	return defaultChunkSize
}

// Download fetches the resource into dst, resuming from durable staging when
// possible. want is the required SHA-256 of the complete entity. The file at
// dst is created or replaced atomically only after the full length and digest
// both match.
//
// Interrupted transfers (context cancellation, dropped connections) leave the
// verified prefix staged so a later Download call resumes. Protocol violations
// discard staging and force the next call to start from zero.
func (d *Downloader) Download(ctx context.Context, dst string, want [sha256.Size]byte) error {
	if d.Request == nil {
		return errors.New("streamdl: Downloader.Request is nil")
	}
	if d.Staging == nil {
		return errors.New("streamdl: Downloader.Staging is nil")
	}

	staged, exists, err := d.Staging.Load(ctx)
	if err != nil {
		return fmt.Errorf("streamdl: load staging: %w", err)
	}

	headers := make(http.Header)
	resume := exists && staged.Length > 0 && staged.Length < staged.Total
	if exists && !resume {
		// Completed-but-unpublished or corrupt state cannot be resumed safely.
		if err := d.Staging.Discard(ctx); err != nil {
			return fmt.Errorf("streamdl: discard unusable staging: %w", err)
		}
		exists = false
	}
	if resume {
		headers.Set("Range", fmt.Sprintf("bytes=%d-", staged.Length))
		// If-Range carries the raw strong ETag, including its quotes.
		headers.Set("If-Range", staged.ETag)
	}

	resp, err := d.Request(ctx, http.MethodGet, headers)
	if err != nil {
		return fmt.Errorf("streamdl: request failed: %w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusOK:
		if exists {
			// The entity was restarted from scratch: old bytes are obsolete.
			if err := d.Staging.Discard(ctx); err != nil {
				return fmt.Errorf("streamdl: discard superseded staging: %w", err)
			}
		}
		return d.handleInitial(ctx, resp, want, dst)
	case resp.StatusCode == http.StatusPartialContent && resume:
		return d.handlePartial(ctx, resp, staged, want, dst)
	default:
		// Unexpected status: staging is untouched and the next call retries.
		return fmt.Errorf("%w: unexpected status %d %q", ErrProtocol, resp.StatusCode, resp.Status)
	}
}

// handleInitial enforces the rules for a first-contact 200 response.
func (d *Downloader) handleInitial(ctx context.Context, resp *http.Response, want [sha256.Size]byte, dst string) error {
	etag, err := strongETag(resp.Header)
	if err != nil {
		return err
	}
	if resp.ContentLength < 0 {
		return fmt.Errorf("%w: initial response lacks Content-Length", ErrProtocol)
	}
	total := resp.ContentLength

	if total == 0 {
		// Empty entity: verify the body is actually empty and the digest is
		// the SHA-256 of nothing. No resume request is ever sent.
		var one [1]byte
		n, _ := io.ReadFull(resp.Body, one[:])
		if n != 0 {
			return fmt.Errorf("%w: body exceeds declared zero length", ErrProtocol)
		}
		var emptySum [sha256.Size]byte
		if want != emptySum {
			return fmt.Errorf("%w: empty entity digest mismatch", ErrDigest)
		}
		// Establish a committed empty savepoint so Publish has valid state.
		txn, err := d.Staging.Begin(ctx, 0, etag, 0)
		if err != nil {
			return fmt.Errorf("streamdl: begin empty staging: %w", err)
		}
		if _, err := txn.Commit(context.WithoutCancel(ctx)); err != nil {
			return fmt.Errorf("streamdl: commit empty staging: %w", err)
		}
		if err := d.Staging.Publish(ctx, dst); err != nil {
			return fmt.Errorf("streamdl: publish empty entity: %w", err)
		}
		_ = d.Staging.Discard(ctx)
		return nil
	}

	return d.stream(ctx, resp.Body, 0, total, etag, want, dst)
}

// handlePartial enforces the rules for a 206 resume response.
func (d *Downloader) handlePartial(ctx context.Context, resp *http.Response, staged Staged, want [sha256.Size]byte, dst string) error {
	bg := context.WithoutCancel(ctx)

	etag, etagErr := strongETag(resp.Header)
	cr := resp.Header.Get("Content-Range")
	start, end, total, rangeErr := parseContentRange(cr)

	bad := etagErr != nil ||
		etag != staged.ETag ||
		cr == "" ||
		rangeErr != nil ||
		start != staged.Length ||
		end != staged.Total-1 ||
		total != staged.Total
	if !bad && resp.ContentLength != -1 && resp.ContentLength != total-start {
		bad = true
	}
	if bad {
		// Any missing or inconsistent range metadata means the staged prefix
		// cannot be trusted: drop it so the next call starts from zero.
		_ = d.Staging.Discard(bg)
		return fmt.Errorf("%w: invalid 206 response (etag=%q content-range=%q)", ErrProtocol, etag, cr)
	}

	return d.stream(ctx, resp.Body, start, total, etag, want, dst)
}

// stream appends body to staging, committing durable savepoints as data
// arrives, then verifies the digest and publishes. start is zero for a fresh
// entity and the persisted prefix length for a resume.
func (d *Downloader) stream(ctx context.Context, body io.Reader, start, total int64, etag string, want [sha256.Size]byte, dst string) error {
	bg := context.WithoutCancel(ctx)

	txn, err := d.Staging.Begin(ctx, start, etag, total)
	if err != nil {
		return fmt.Errorf("streamdl: begin staging: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = txn.Rollback(bg)
		}
	}()

	hasher := sha256.New()
	if start > 0 {
		// Re-hash the persisted prefix so the final digest covers every byte.
		if err := seedHash(d.Staging, ctx, start, hasher); err != nil {
			return err
		}
	}

	buf := make([]byte, d.chunkSize())
	remaining := total - start
	var received int64
	for received < remaining {
		if err := ctx.Err(); err != nil {
			if _, cerr := txn.Commit(bg); cerr != nil {
				return cerr
			}
			committed = true
			return err
		}

		limit := int64(len(buf))
		if gap := remaining - received; gap < limit {
			limit = gap
		}
		nr, rerr := io.ReadFull(body, buf[:limit])
		if nr > 0 {
			if _, werr := txn.Write(buf[:nr]); werr != nil {
				return fmt.Errorf("streamdl: staging write: %w", werr)
			}
			hasher.Write(buf[:nr])
			received += int64(nr)
		}
		if rerr != nil {
			// Connection cut, read failure or cancellation: persist the
			// verified prefix for a later resume.
			if _, cerr := txn.Commit(bg); cerr != nil {
				return cerr
			}
			committed = true
			if cerr := ctx.Err(); cerr != nil {
				return cerr
			}
			if errors.Is(rerr, io.EOF) || errors.Is(rerr, io.ErrUnexpectedEOF) {
				return fmt.Errorf("streamdl: interrupted after %d/%d remaining bytes: %w",
					received, remaining, io.ErrUnexpectedEOF)
			}
			return fmt.Errorf("streamdl: read body: %w", rerr)
		}
	}

	// The declared length is satisfied; the body must not contain extra bytes.
	var one [1]byte
	if extra, _ := io.ReadFull(body, one[:]); extra > 0 {
		_ = d.Staging.Discard(bg)
		return fmt.Errorf("%w: body longer than declared length %d", ErrProtocol, total)
	}

	if sum := hasher.Sum(nil); !bytes.Equal(sum, want[:]) {
		_ = d.Staging.Discard(bg)
		return fmt.Errorf("%w: expected %x, got %x", ErrDigest, want, sum)
	}

	if _, err := txn.Commit(bg); err != nil {
		return fmt.Errorf("streamdl: final commit: %w", err)
	}
	committed = true
	if err := d.Staging.Publish(bg, dst); err != nil {
		return fmt.Errorf("streamdl: publish: %w", err)
	}
	_ = d.Staging.Discard(bg)
	return nil
}

func seedHash(staging Staging, ctx context.Context, start int64, hasher hash.Hash) error {
	rc, n, err := staging.Reader(ctx)
	if err != nil {
		return fmt.Errorf("streamdl: open staged reader: %w", err)
	}
	copied, err := io.Copy(hasher, rc)
	_ = rc.Close()
	if err != nil {
		return fmt.Errorf("streamdl: hash staged prefix: %w", err)
	}
	if n != start || copied != start {
		return fmt.Errorf("%w: staged prefix length %d (reader %d) does not match resume start %d",
			ErrProtocol, copied, n, start)
	}
	return nil
}

// strongETag returns the raw ETag only when it is a strong validator.
func strongETag(h http.Header) (string, error) {
	etag := strings.TrimSpace(h.Get("ETag"))
	if etag == "" {
		return "", fmt.Errorf("%w: missing ETag", ErrProtocol)
	}
	if strings.HasPrefix(etag, "W/") {
		return "", fmt.Errorf("%w: weak ETag %q is not a strong validator", ErrProtocol, etag)
	}
	if !strings.HasPrefix(etag, "\"") || !strings.HasSuffix(etag, "\"") || len(etag) < 2 {
		return "", fmt.Errorf("%w: malformed ETag %q", ErrProtocol, etag)
	}
	return etag, nil
}

// parseContentRange parses a complete "bytes start-end/total" header. A "*"
// total or any malformed component is rejected because the resume contract
// requires the full length.
func parseContentRange(value string) (start, end, total int64, err error) {
	const prefix = "bytes "
	if !strings.HasPrefix(value, prefix) {
		return 0, 0, 0, fmt.Errorf("%w: malformed Content-Range %q", ErrProtocol, value)
	}
	rest := value[len(prefix):]
	dash := strings.IndexByte(rest, '-')
	slash := strings.IndexByte(rest, '/')
	if dash <= 0 || slash <= dash+1 || slash == len(rest)-1 {
		return 0, 0, 0, fmt.Errorf("%w: malformed Content-Range %q", ErrProtocol, value)
	}

	start, err = parseInt64(rest[:dash])
	if err != nil {
		return 0, 0, 0, fmt.Errorf("%w: bad Content-Range start %q", ErrProtocol, value)
	}
	end, err = parseInt64(rest[dash+1 : slash])
	if err != nil {
		return 0, 0, 0, fmt.Errorf("%w: bad Content-Range end %q", ErrProtocol, value)
	}
	totalPart := rest[slash+1:]
	if totalPart == "*" {
		return 0, 0, 0, fmt.Errorf("%w: Content-Range %q omits total length", ErrProtocol, value)
	}
	total, err = parseInt64(totalPart)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("%w: bad Content-Range total %q", ErrProtocol, value)
	}
	if start < 0 || end < start || total <= end {
		return 0, 0, 0, fmt.Errorf("%w: impossible Content-Range %q", ErrProtocol, value)
	}
	return start, end, total, nil
}

func parseInt64(s string) (int64, error) {
	var n int64
	if s == "" {
		return 0, errors.New("empty integer")
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, fmt.Errorf("not an integer: %q", s)
		}
		n = n*10 + int64(r-'0')
	}
	return n, nil
}
