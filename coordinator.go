package formal

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"sync"
	"sync/atomic"
)

// State is the coordinator's build state.
type State uint8

const (
	StateNew State = iota
	StateScanning
	StateReplaying
	StateSealed
	StateVisible
	StateCanceled
	StateFailed
)

func (s State) String() string {
	switch s {
	case StateNew:
		return "new"
	case StateScanning:
		return "scanning"
	case StateReplaying:
		return "replaying"
	case StateSealed:
		return "sealed"
	case StateVisible:
		return "visible"
	case StateCanceled:
		return "canceled"
	case StateFailed:
		return "failed"
	default:
		return fmt.Sprintf("state(%d)", uint8(s))
	}
}

// Auditor proves that an index contains exactly the authoritative table
// contents at a commit sequence. Seal runs the auditor before issuing a
// certificate; a failed audit prevents Publish.
type Auditor interface {
	Audit(ctx context.Context, at Seq, index Index) error
}

// Config describes one index build.
type Config struct {
	// Snapshots opens the consistent table snapshot that seeds the build.
	Snapshots SnapshotSource
	// Log supplies commits that happened after the snapshot.
	Log ChangeLog
	// Index is the fresh index to populate.
	Index Index
	// BatchSize is the maximum page size passed to ChangeLog.Read.
	// Values <= 0 default to 256.
	BatchSize int
	// Audit is required. Seal runs it after draining to the barrier and before
	// issuing a certificate. Use SnapshotAuditor to compare the index with an
	// authoritative snapshot. A failed audit makes the build fail and makes
	// Publish impossible.
	Audit Auditor
}

// Coordinator drives one online index build.
//
// The normal sequence is Scan, zero or more CatchUp calls, Seal, Publish.
// Only Publish makes the index visible, and it requires a certificate issued
// by Seal after the log was fully drained to its barrier.
type Coordinator struct {
	snapshots SnapshotSource
	log       ChangeLog
	index     Index
	batchSize int
	audit     Auditor

	opMu       sync.Mutex
	baseCtx    context.Context
	baseCancel context.CancelFunc

	mu          sync.Mutex
	state       State
	cause       error
	snapshotSeq Seq
	appliedSeq  Seq
	drainedSeq  Seq
	sealedSeq   Seq
	commits     int
	mutations   int
	digest      hash.Hash
	cert        *Certificate
	token       *buildToken
}

var tokenCounter atomic.Uint64

// New creates a coordinator. The index must be empty when Scan is called.
func New(cfg Config) (*Coordinator, error) {
	if cfg.Snapshots == nil {
		return nil, errors.New("formal: nil SnapshotSource")
	}
	if cfg.Log == nil {
		return nil, errors.New("formal: nil ChangeLog")
	}
	if cfg.Index == nil {
		return nil, errors.New("formal: nil Index")
	}
	if cfg.Audit == nil {
		return nil, ErrNoAuditor
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 256
	}
	baseCtx, baseCancel := context.WithCancel(context.Background())
	return &Coordinator{
		snapshots:  cfg.Snapshots,
		log:        cfg.Log,
		index:      cfg.Index,
		batchSize:  cfg.BatchSize,
		audit:      cfg.Audit,
		baseCtx:    baseCtx,
		baseCancel: baseCancel,
		state:      StateNew,
		digest:     sha256.New(),
		token:      &buildToken{id: tokenCounter.Add(1)},
	}, nil
}

// State returns the current build state.
func (c *Coordinator) State() State {
	c.mu.Lock()
	s := c.state
	c.mu.Unlock()
	return s
}

// Cause returns the cancellation or failure cause, if any.
func (c *Coordinator) Cause() error {
	c.mu.Lock()
	err := c.cause
	c.mu.Unlock()
	return err
}

// Watermark returns the current handoff boundaries.
func (c *Coordinator) Watermark() Watermark {
	c.mu.Lock()
	w := Watermark{
		Snapshot: c.snapshotSeq,
		Applied:  c.appliedSeq,
		Drained:  c.drainedSeq,
		Sealed:   c.sealedSeq,
	}
	c.mu.Unlock()
	return w
}

// Progress returns watermark and replay counters.
func (c *Coordinator) Progress() Progress {
	c.mu.Lock()
	p := Progress{
		Watermark: Watermark{
			Snapshot: c.snapshotSeq,
			Applied:  c.appliedSeq,
			Drained:  c.drainedSeq,
			Sealed:   c.sealedSeq,
		},
		Commits:   c.commits,
		Mutations: c.mutations,
	}
	c.mu.Unlock()
	return p
}

// Scan opens a consistent snapshot, copies it into the index, and records the
// snapshot watermark. It must be called exactly once, on an empty index.
func (c *Coordinator) Scan(ctx context.Context) error {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	opCtx, stop := c.link(ctx)
	defer stop()

	c.mu.Lock()
	if err := c.canceledLocked(); err != nil {
		c.mu.Unlock()
		return err
	}
	if c.state != StateNew {
		state := c.state
		c.mu.Unlock()
		return fmt.Errorf("%w: scan in state %s", ErrInvalidState, state)
	}
	c.mu.Unlock()

	if n := c.index.Len(); n != 0 {
		return fmt.Errorf("%w: %d existing entries", ErrIndexNotEmpty, n)
	}

	c.mu.Lock()
	if err := c.canceledLocked(); err != nil {
		c.mu.Unlock()
		return err
	}
	c.state = StateScanning
	c.mu.Unlock()

	snap, err := c.snapshots.OpenSnapshot(opCtx)
	if err != nil {
		return c.abort(err)
	}
	watermark := snap.Watermark()
	if err := snap.Scan(opCtx, func(k Key, v Value) error {
		if err := opCtx.Err(); err != nil {
			return err
		}
		c.index.Put(k, v)
		return nil
	}); err != nil {
		return c.abort(err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.canceledLocked(); err != nil {
		return err
	}
	c.snapshotSeq = watermark
	c.appliedSeq = watermark
	c.drainedSeq = watermark
	c.sealedSeq = 0
	c.state = StateReplaying
	return nil
}

// CatchUp drains the log through its current high watermark. It may be called
// repeatedly while the build is online.
func (c *Coordinator) CatchUp(ctx context.Context) (Progress, error) {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	opCtx, stop := c.link(ctx)
	defer stop()

	c.mu.Lock()
	if err := c.canceledLocked(); err != nil {
		c.mu.Unlock()
		return Progress{}, err
	}
	if c.state != StateReplaying {
		state := c.state
		c.mu.Unlock()
		return Progress{}, fmt.Errorf("%w: catch-up in state %s", ErrInvalidState, state)
	}
	c.mu.Unlock()

	through, err := c.log.HighWatermark(opCtx)
	if err != nil {
		return Progress{}, c.abort(err)
	}
	if err := c.drain(opCtx, through); err != nil {
		return Progress{}, c.abort(err)
	}
	return c.Progress(), nil
}

// Seal fixes a barrier at the log's current high watermark, drains every
// commit through that barrier, audits the whole index against the table at
// that barrier, and returns a certificate. The index is not visible until
// Publish accepts it.
//
// Seal may be called again from StateSealed if the log advanced.
func (c *Coordinator) Seal(ctx context.Context) (Certificate, error) {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	opCtx, stop := c.link(ctx)
	defer stop()

	c.mu.Lock()
	if err := c.canceledLocked(); err != nil {
		c.mu.Unlock()
		return Certificate{}, err
	}
	if c.state != StateReplaying && c.state != StateSealed {
		state := c.state
		c.mu.Unlock()
		return Certificate{}, fmt.Errorf("%w: seal in state %s", ErrInvalidState, state)
	}
	c.mu.Unlock()

	barrier, err := c.log.HighWatermark(opCtx)
	if err != nil {
		return Certificate{}, c.abort(err)
	}
	if err := c.drain(opCtx, barrier); err != nil {
		return Certificate{}, c.abort(err)
	}

	if err := c.audit.Audit(opCtx, barrier, c.index); err != nil {
		return Certificate{}, c.abort(fmt.Errorf("audit at seq %d: %w", barrier, err))
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.canceledLocked(); err != nil {
		return Certificate{}, err
	}
	var sum [32]byte
	copy(sum[:], c.digest.Sum(nil))
	cert := Certificate{
		snapshot:  c.snapshotSeq,
		barrier:   barrier,
		commits:   c.commits,
		mutations: c.mutations,
		digest:    sum,
		verified:  true,
		token:     c.token,
	}
	c.cert = &cert
	c.sealedSeq = barrier
	c.state = StateSealed
	return cert, nil
}

// Publish switches the index to visible. It accepts only the certificate
// currently issued by this coordinator, and only if the change log has not
// advanced past the certificate barrier.
//
// A stale certificate is not a failure of the build: the caller can Seal again
// and then Publish the new certificate.
func (c *Coordinator) Publish(ctx context.Context, cert Certificate) error {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	opCtx, stop := c.link(ctx)
	defer stop()

	c.mu.Lock()
	if err := c.canceledLocked(); err != nil {
		c.mu.Unlock()
		return err
	}
	if c.state != StateSealed {
		state := c.state
		c.mu.Unlock()
		return fmt.Errorf("%w: publish in state %s", ErrInvalidState, state)
	}
	if !c.sameCertificateLocked(cert) {
		c.mu.Unlock()
		return ErrInvalidCertificate
	}
	barrier := c.sealedSeq
	c.mu.Unlock()

	hw, err := c.log.HighWatermark(opCtx)
	if err != nil {
		return c.abort(err)
	}
	if hw > barrier {
		return fmt.Errorf("%w: log advanced to %d, barrier is %d", ErrStaleCertificate, hw, barrier)
	}
	if hw < barrier {
		return fmt.Errorf("%w: log watermark %d is behind barrier %d", ErrWatermarkRegression, hw, barrier)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.canceledLocked(); err != nil {
		return err
	}
	if c.state != StateSealed {
		state := c.state
		return fmt.Errorf("%w: publish in state %s", ErrInvalidState, state)
	}
	c.state = StateVisible
	return nil
}

// Cancel stops an in-flight build. Blocking snapshot scans and log reads are
// interrupted through context cancellation. Cancellation is permanent for this
// coordinator and always prevents Publish.
//
// The caller owns the partially populated index and should discard it.
func (c *Coordinator) Cancel(cause error) error {
	if cause == nil {
		cause = ErrCanceled
	}
	c.mu.Lock()
	if c.state == StateVisible {
		c.mu.Unlock()
		return fmt.Errorf("%w: cannot cancel a visible index", ErrInvalidState)
	}
	if c.state == StateCanceled {
		c.mu.Unlock()
		return nil
	}
	c.state = StateCanceled
	if c.cause == nil {
		c.cause = cause
	}
	c.mu.Unlock()
	c.baseCancel()
	return nil
}

func (c *Coordinator) drain(ctx context.Context, through Seq) error {
	c.mu.Lock()
	if err := c.canceledLocked(); err != nil {
		c.mu.Unlock()
		return err
	}
	after := c.drainedSeq
	c.mu.Unlock()

	if through < after {
		return fmt.Errorf("%w: through %d is behind drained %d", ErrWatermarkRegression, through, after)
	}

	for after < through {
		if err := contextErr(ctx); err != nil {
			return err
		}
		batch, err := c.log.Read(ctx, after, through, c.batchSize)
		if err != nil {
			return err
		}

		last := after
		progressed := false
		var seen map[Seq]struct{}
		for _, cm := range batch.Commits {
			if err := contextErr(ctx); err != nil {
				return err
			}
			// Stale replay from before this page's range: already covered.
			if cm.Seq <= after {
				continue
			}
			if cm.Seq > through {
				return fmt.Errorf("%w: commit %d, barrier %d", ErrLogBeyondBarrier, cm.Seq, through)
			}
			if cm.Seq < last {
				// A non-adjacent replay of a commit already applied in this
				// page is harmless. A sequence that is genuinely out of order
				// could hide a missing commit, so it is rejected.
				if _, ok := seen[cm.Seq]; ok {
					continue
				}
				return fmt.Errorf("%w: commit %d after %d", ErrLogOrder, cm.Seq, last)
			}
			// Duplicate of a commit applied earlier in this page.
			if cm.Seq == last {
				continue
			}
			if err := c.apply(cm); err != nil {
				return err
			}
			if seen == nil {
				seen = make(map[Seq]struct{})
			}
			seen[cm.Seq] = struct{}{}
			last = cm.Seq
			progressed = true
		}

		c.mu.Lock()
		if err := c.canceledLocked(); err != nil {
			c.mu.Unlock()
			return err
		}
		if last > c.drainedSeq {
			c.drainedSeq = last
		}
		c.mu.Unlock()
		after = last

		if batch.Done {
			break
		}
		if !progressed {
			return fmt.Errorf("%w: no commit after seq %d", ErrLogStalled, after)
		}
	}

	c.mu.Lock()
	if err := c.canceledLocked(); err != nil {
		c.mu.Unlock()
		return err
	}
	if through > c.drainedSeq {
		c.drainedSeq = through
	}
	c.mu.Unlock()
	return nil
}

func (c *Coordinator) apply(cm Commit) error {
	if err := cm.validate(); err != nil {
		return err
	}

	c.mu.Lock()
	if cm.Seq <= c.appliedSeq {
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()

	// Once started, a commit is applied without interruption so the index never
	// exposes half a transaction.
	for _, ch := range cm.Changes {
		switch ch.Op {
		case OpPut:
			c.index.Put(ch.Key, ch.Value)
		case OpDelete:
			c.index.Delete(ch.Key)
		}
	}

	c.mu.Lock()
	c.appliedSeq = cm.Seq
	c.commits++
	c.mutations += len(cm.Changes)
	writeCommitDigest(c.digest, cm)
	c.mu.Unlock()
	return nil
}

func (c *Coordinator) sameCertificateLocked(cert Certificate) bool {
	if c.cert == nil || cert.token != c.token {
		return false
	}
	return cert.snapshot == c.cert.snapshot &&
		cert.barrier == c.cert.barrier &&
		cert.commits == c.cert.commits &&
		cert.mutations == c.cert.mutations &&
		cert.digest == c.cert.digest &&
		cert.verified == c.cert.verified
}

func (c *Coordinator) canceledLocked() error {
	if c.state == StateCanceled {
		return canceledError(c.cause)
	}
	return nil
}

func (c *Coordinator) abort(err error) error {
	if err == nil {
		err = errors.New("formal: unknown coordinator failure")
	}
	c.mu.Lock()
	if c.state == StateCanceled {
		cause := c.cause
		c.mu.Unlock()
		return canceledError(cause)
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		c.state = StateCanceled
		c.cause = err
		c.mu.Unlock()
		c.baseCancel()
		return canceledError(err)
	}
	c.state = StateFailed
	c.cause = err
	c.mu.Unlock()
	return err
}

func (c *Coordinator) link(parent context.Context) (context.Context, func()) {
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(c.baseCtx, cancel)
	return ctx, func() {
		stop()
		cancel()
	}
}

func writeCommitDigest(h hash.Hash, cm Commit) {
	var buf [8]byte
	writeUint64 := func(v uint64) {
		binary.BigEndian.PutUint64(buf[:], v)
		_, _ = h.Write(buf[:])
	}
	writeBytes := func(b []byte) {
		writeUint64(uint64(len(b)))
		_, _ = h.Write(b)
	}

	writeUint64(uint64(cm.Seq))
	writeUint64(uint64(cm.Txn))
	writeUint64(uint64(len(cm.Changes)))
	for _, ch := range cm.Changes {
		writeBytes([]byte{byte(ch.Op)})
		writeBytes([]byte(ch.Key))
		if ch.Op == OpPut {
			writeBytes([]byte(ch.Value))
		} else {
			writeBytes(nil)
		}
	}
}
