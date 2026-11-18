package formal

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
)

var (
	// ErrQuorum reports that an operation did not reach its quorum.
	ErrQuorum = errors.New("formal: quorum not reached")
	// ErrUnavailable reports that a committed version cannot be reconstructed
	// from the shards that are currently reachable.
	ErrUnavailable = errors.New("formal: object shards unavailable")
)

// QuorumError describes a missed read or write quorum.
type QuorumError struct {
	Op       string
	Required int
	Achieved int
}

// Error implements error.
func (e *QuorumError) Error() string {
	return fmt.Sprintf("formal: %s quorum not reached: got %d of %d", e.Op, e.Achieved, e.Required)
}

// Unwrap makes errors.Is(err, ErrQuorum) true.
func (e *QuorumError) Unwrap() error { return ErrQuorum }

// AvailabilityError describes a read that met the response quorum but could
// not assemble DataShards fragments of the committed version.
type AvailabilityError struct {
	ObjectID  string
	Version   uint64
	Required  int
	Available int
	Invalid   int
	Err       error
}

// Error implements error.
func (e *AvailabilityError) Error() string {
	msg := fmt.Sprintf("formal: object %q version %d: %d of %d shards available", e.ObjectID, e.Version, e.Available, e.Required)
	if e.Invalid > 0 {
		msg += fmt.Sprintf(", %d invalid", e.Invalid)
	}
	if e.Err != nil {
		msg += ": " + e.Err.Error()
	}
	return msg
}

// Unwrap makes errors.Is(err, ErrUnavailable) true.
func (e *AvailabilityError) Unwrap() error {
	if e.Err != nil {
		return errors.Join(ErrUnavailable, e.Err)
	}
	return ErrUnavailable
}

// QuorumConfig configures an erasure-coded cluster.
//
// The write quorum W must be at least DataShards so every committed write
// leaves enough fragments to reconstruct.  The read quorum R must also be at
// least DataShards.  W+R must be greater than the total shard count N so a
// read quorum intersects every successful write quorum.
type QuorumConfig struct {
	DataShards   int
	ParityShards int
	WriteQuorum  int
	ReadQuorum   int
}

// Cluster combines an erasure codec with a set of shard nodes and enforces
// quorum and version rules.
type Cluster struct {
	codec       *Codec
	nodes       []Node
	writeQuorum int
	readQuorum  int

	nextVersion atomic.Uint64

	commitMu  sync.RWMutex
	committed map[string]uint64

	locks lockMap
}

// NewCluster validates cfg and builds a cluster over nodes.  There must be
// exactly DataShards+ParityShards nodes, one per shard index.
func NewCluster(cfg QuorumConfig, nodes []Node) (*Cluster, error) {
	codec, err := New(cfg.DataShards, cfg.ParityShards)
	if err != nil {
		return nil, err
	}
	total := codec.TotalShards()
	if len(nodes) != total {
		return nil, fmt.Errorf("%w: got %d nodes, want %d", ErrInvalidConfig, len(nodes), total)
	}
	for i, node := range nodes {
		if node == nil {
			return nil, fmt.Errorf("%w: node %d is nil", ErrInvalidConfig, i)
		}
	}
	if cfg.WriteQuorum < cfg.DataShards {
		return nil, fmt.Errorf("%w: write quorum %d is below data shards %d", ErrInvalidConfig, cfg.WriteQuorum, cfg.DataShards)
	}
	if cfg.WriteQuorum > total {
		return nil, fmt.Errorf("%w: write quorum %d exceeds total shards %d", ErrInvalidConfig, cfg.WriteQuorum, total)
	}
	if cfg.ReadQuorum < cfg.DataShards {
		return nil, fmt.Errorf("%w: read quorum %d is below data shards %d", ErrInvalidConfig, cfg.ReadQuorum, cfg.DataShards)
	}
	if cfg.ReadQuorum > total {
		return nil, fmt.Errorf("%w: read quorum %d exceeds total shards %d", ErrInvalidConfig, cfg.ReadQuorum, total)
	}
	if cfg.WriteQuorum+cfg.ReadQuorum <= total {
		return nil, fmt.Errorf("%w: write quorum %d + read quorum %d must exceed %d shards",
			ErrInvalidConfig, cfg.WriteQuorum, cfg.ReadQuorum, total)
	}

	return &Cluster{
		codec:       codec,
		nodes:       append([]Node(nil), nodes...),
		writeQuorum: cfg.WriteQuorum,
		readQuorum:  cfg.ReadQuorum,
		committed:   make(map[string]uint64),
		locks:       lockMap{entries: make(map[string]*lockEntry)},
	}, nil
}

// Codec returns the cluster's erasure codec.
func (c *Cluster) Codec() *Codec { return c.codec }

// Quorums returns the configured write and read quorums.
func (c *Cluster) Quorums() (write, read int) { return c.writeQuorum, c.readQuorum }

// CommittedVersion returns the newest committed version of objectID.
func (c *Cluster) CommittedVersion(objectID string) (uint64, bool) {
	c.commitMu.RLock()
	defer c.commitMu.RUnlock()
	version, ok := c.committed[objectID]
	return version, ok
}

// Write erases and stores data, returning the committed version.
//
// Every node is sent its fragment.  The write is committed only when at least
// WriteQuorum distinct nodes accept it.  A failed write leaves uncommitted
// fragments behind; they are invisible to readers because reads are bounded
// by the committed watermark.
func (c *Cluster) Write(ctx context.Context, objectID string, data []byte) (uint64, error) {
	if objectID == "" {
		return 0, ErrInvalidObjectID
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}

	unlock := c.locks.lock(objectID)
	defer unlock()

	shards, err := c.codec.EncodePadded(data)
	if err != nil {
		return 0, err
	}

	version := c.nextVersion.Add(1)
	type putResult struct{ err error }
	results := make(chan putResult, len(c.nodes))
	for i, node := range c.nodes {
		fragment := Fragment{
			ObjectID: objectID,
			Index:    i,
			Version:  version,
			DataLen:  len(data),
			Data:     append([]byte(nil), shards[i]...),
		}
		go func(node Node, fragment Fragment) {
			results <- putResult{err: node.Put(ctx, fragment)}
		}(node, fragment)
	}

	acks := 0
	for range c.nodes {
		if err := (<-results).err; err == nil {
			acks++
		}
	}

	if acks < c.writeQuorum {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return 0, fmt.Errorf("formal: write %q: %w", objectID, ctxErr)
		}
		return 0, &QuorumError{Op: "write", Required: c.writeQuorum, Achieved: acks}
	}

	c.commitMu.Lock()
	if version > c.committed[objectID] {
		c.committed[objectID] = version
	}
	c.commitMu.Unlock()
	return version, nil
}

// Read returns the newest committed version of objectID.  Missing shards are
// reconstructed from the available data and parity shards, so a read succeeds
// as long as DataShards fragments of the committed version can be collected.
func (c *Cluster) Read(ctx context.Context, objectID string) ([]byte, error) {
	data, _, err := c.ReadVersion(ctx, objectID)
	return data, err
}

// ReadVersion is like Read and also returns the version that was served.
func (c *Cluster) ReadVersion(ctx context.Context, objectID string) ([]byte, uint64, error) {
	if objectID == "" {
		return nil, 0, ErrInvalidObjectID
	}
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}

	version, ok := c.CommittedVersion(objectID)
	if !ok {
		return nil, 0, ErrNotFound
	}

	const attempts = 4
	for attempt := 0; attempt < attempts; attempt++ {
		data, err := c.readAtVersion(ctx, objectID, version)
		if err == nil {
			return data, version, nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, 0, ctxErr
		}

		newer, ok := c.CommittedVersion(objectID)
		if ok && newer > version {
			version = newer
			continue
		}
		return nil, 0, err
	}
	return nil, 0, fmt.Errorf("formal: read %q: committed version changed repeatedly", objectID)
}

func (c *Cluster) readAtVersion(ctx context.Context, objectID string, version uint64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	type response struct {
		index    int
		fragment Fragment
		err      error
	}
	responses := make(chan response, len(c.nodes))
	for i, node := range c.nodes {
		go func(index int, node Node) {
			fragment, err := node.Get(readCtx, objectID, index, version)
			responses <- response{index: index, fragment: fragment, err: err}
		}(i, node)
	}

	shards := make(map[int]Fragment)
	responsesSeen := 0
	invalid := 0
	dataLen := -1
	shardSize := -1
	var lastErr error

	for responsesSeen < len(c.nodes) {
		var resp response
		select {
		case resp = <-responses:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		responsesSeen++

		fragment := resp.fragment
		if resp.err != nil {
			if !errors.Is(resp.err, ErrNotFound) && lastErr == nil {
				lastErr = resp.err
			}
		} else if fragment.Index != resp.index ||
			fragment.ObjectID != "" && fragment.ObjectID != objectID ||
			fragment.Version == 0 || fragment.Version > version ||
			fragment.DataLen < 0 {
			invalid++
		} else if fragment.Version != version {
			// A stale shard from an older version.  It is a valid response but
			// must never be combined with the committed version.
		} else {
			size := c.codec.ShardSize(fragment.DataLen)
			valid := true
			if len(fragment.Data) != size {
				invalid++
				valid = false
			} else if dataLen < 0 {
				dataLen = fragment.DataLen
				shardSize = size
			} else if fragment.DataLen != dataLen || size != shardSize {
				// Same version but incompatible metadata: do not mix it in.
				invalid++
				valid = false
			}
			if valid {
				if _, exists := shards[resp.index]; !exists {
					shards[resp.index] = fragment.Clone()
				}
			}
		}

		// Re-check after every response, including stale or failed responses:
		// the response that satisfies the read quorum may not itself be a
		// usable shard.
		if dataLen >= 0 && responsesSeen >= c.readQuorum && len(shards) >= c.codec.DataShards() {
			data, err := c.decodeSnapshot(shards, dataLen, version)
			if err != nil {
				return nil, err
			}
			cancel()
			return data, nil
		}
	}

	if responsesSeen < c.readQuorum {
		return nil, &QuorumError{Op: "read", Required: c.readQuorum, Achieved: responsesSeen}
	}
	if len(shards) < c.codec.DataShards() {
		return nil, &AvailabilityError{
			ObjectID:  objectID,
			Version:   version,
			Required:  c.codec.DataShards(),
			Available: len(shards),
			Invalid:   invalid,
			Err:       lastErr,
		}
	}
	return c.decodeSnapshot(shards, dataLen, version)
}

// decodeSnapshot reconstructs from one immutable version's fragments.  The
// fragments are already private copies, and decodeSnapshot never consults the
// nodes, so a late response cannot change the bytes being decoded.
func (c *Cluster) decodeSnapshot(shards map[int]Fragment, dataLen int, version uint64) ([]byte, error) {
	if dataLen < 0 {
		return nil, &AvailabilityError{
			Version:   version,
			Required:  c.codec.DataShards(),
			Available: 0,
			Err:       ErrUnavailable,
		}
	}
	if dataLen == 0 {
		return []byte{}, nil
	}

	stripe := make([][]byte, c.codec.TotalShards())
	for index, fragment := range shards {
		stripe[index] = fragment.Data
	}
	data, err := c.codec.ReconstructData(stripe, dataLen)
	if err != nil {
		return nil, fmt.Errorf("formal: reconstruct version %d: %w", version, err)
	}
	return data, nil
}

// lockMap provides a mutex per object ID without retaining entries forever.
type lockMap struct {
	mu      sync.Mutex
	entries map[string]*lockEntry
}

type lockEntry struct {
	mu   sync.Mutex
	refs int
}

func (l *lockMap) lock(key string) func() {
	l.mu.Lock()
	entry := l.entries[key]
	if entry == nil {
		entry = &lockEntry{}
		l.entries[key] = entry
	}
	entry.refs++
	l.mu.Unlock()

	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		l.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(l.entries, key)
		}
		l.mu.Unlock()
	}
}
