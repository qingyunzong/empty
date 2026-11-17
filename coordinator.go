package formal

import (
	"context"
	"sync"
	"time"
)

// ErrQuorumUnavailable is returned when fewer than R/W healthy replicas
// respond before the request deadline.
type ErrQuorumUnavailable struct {
	Op     string
	Needed int
	Got    int
}

func (e ErrQuorumUnavailable) Error() string {
	return "quorum unavailable for " + e.Op
}

// Config describes the replica group and quorum parameters.
type Config struct {
	Nodes []string
	// LocalNode identifies this coordinator's vantage point for transport
	// partition-group checks and acts as its vector-clock tick origin.
	LocalNode      string
	R              int           // read quorum
	W              int           // write quorum
	RequestTimeout time.Duration // deadline for reaching quorum
	RepairTimeout  time.Duration // bounded post-quorum repair window
	MaxRepair      int           // max replicas touched by background repair
}

// Coordinator drives request-path R/W quorum operations over a Transport.
type Coordinator struct {
	cfg  Config
	node Transport

	// epoch is the coordinator-issued GC generation, advanced by Compact.
	epochMu sync.Mutex
	epoch   int64

	// bg waits on bounded post-quorum repair goroutines so tests can
	// deterministically observe convergence.
	bg sync.WaitGroup
}

// NewCoordinator builds a coordinator for the given configuration.
func NewCoordinator(cfg Config, transport Transport) *Coordinator {
	if cfg.MaxRepair <= 0 {
		cfg.MaxRepair = len(cfg.Nodes)
	}
	if cfg.RepairTimeout <= 0 {
		cfg.RepairTimeout = cfg.RequestTimeout
	}
	return &Coordinator{cfg: cfg, node: transport}
}

// readResult is one replica's response to a read fan-out.
type readResult struct {
	node     string
	versions []Version
	err      error
}

// writeAck is one replica's response to a write fan-out.
type writeAck struct {
	node string
	err  error
}

// Get performs an R-quorum read. It returns as soon as R healthy replicas
// respond with the merged live sibling set, then schedules a bounded
// read-repair in the background to push the merged state to stale nodes.
func (c *Coordinator) Get(ctx context.Context, key string) (live []Version, deleted bool, err error) {
	ch := make(chan readResult, len(c.cfg.Nodes))
	for _, target := range c.cfg.Nodes {
		go func(node string) {
			versions, readErr := c.node.Read(c.cfg.LocalNode, node, key)
			ch <- readResult{node: node, versions: versions, err: readErr}
		}(target)
	}

	deadline := time.NewTimer(c.cfg.RequestTimeout)
	defer deadline.Stop()

	var merged []Version
	healthy := 0

	for healthy < c.cfg.R {
		select {
		case res := <-ch:
			if res.err != nil {
				continue
			}
			healthy++
			merged = MergeVersions(merged, res.versions)
		case <-deadline.C:
			return nil, false, ErrQuorumUnavailable{Op: "read", Needed: c.cfg.R, Got: healthy}
		case <-ctx.Done():
			return nil, false, ctx.Err()
		}
	}

	// Quorum reached: the client gets the answer now; remaining responses
	// are consumed only inside the bounded repair budget.
	live, deleted = Visible(merged)
	c.scheduleReadRepair(key, merged, len(c.cfg.Nodes)-healthy, ch)
	return live, deleted, nil
}

// scheduleReadRepair continues collecting outstanding responses within the
// repair window, folds any late siblings into the merged set, and writes the
// result back to at most MaxRepair replicas that lack any of the merged
// revisions. Answering nodes are not skipped: a successful response can
// itself be stale. It never blocks the caller: the work runs in a tracked
// background goroutine.
func (c *Coordinator) scheduleReadRepair(key string, merged []Version, outstanding int, ch <-chan readResult) {
	c.bg.Add(1)
	go func() {
		defer c.bg.Done()

		window := time.NewTimer(c.cfg.RepairTimeout)
		defer window.Stop()

		pending := outstanding
		for pending > 0 {
			select {
			case res := <-ch:
				pending--
				if res.err != nil {
					continue
				}
				if !containsAll(merged, res.versions) {
					merged = MergeVersions(merged, res.versions)
				}
			case <-window.C:
				pending = 0
			}
		}

		c.repairWrite(key, merged)
	}()
}

// repairWrite pushes versions to replicas missing some of them, capped by
// MaxRepair. Replica-side Apply guarantees stale pushes cannot regress a
// replica that already holds newer data.
func (c *Coordinator) repairWrite(key string, versions []Version) {
	budget := c.cfg.MaxRepair
	for _, target := range c.cfg.Nodes {
		if budget <= 0 {
			return
		}
		current, err := c.node.Read(c.cfg.LocalNode, target, key)
		if err != nil {
			continue
		}
		if containsAll(current, versions) {
			continue
		}
		if err := c.node.Write(c.cfg.LocalNode, target, key, versions); err != nil {
			continue
		}
		budget--
	}
}

// Put performs a write. It first performs an R-quorum read to anchor the new
// revision on the merged causal history, then writes a fresh vector-clock
// descendant to a W quorum. A bounded background write-repair fans the
// revision out to any remaining reachable replicas.
func (c *Coordinator) Put(ctx context.Context, key string, value []byte) (VClock, error) {
	return c.write(ctx, key, Version{Value: append([]byte(nil), value...)})
}

// Delete writes a tombstone revision. Tombstones are kept in storage until a
// Compact advances the safe watermark past their deletion epoch.
func (c *Coordinator) Delete(ctx context.Context, key string) (VClock, error) {
	return c.write(ctx, key, Version{Tombstone: true})
}

func (c *Coordinator) write(ctx context.Context, key string, revision Version) (VClock, error) {
	base, err := c.readMerged(ctx, key)
	if err != nil {
		return nil, err
	}

	clock := base.Increment(c.cfg.LocalNode)
	revision.Clock = clock
	if revision.Tombstone {
		revision.DelEpoch = c.nextEpoch()
	}

	ch := make(chan writeAck, len(c.cfg.Nodes))
	for _, target := range c.cfg.Nodes {
		go func(node string) {
			ch <- writeAck{node: node, err: c.node.Write(c.cfg.LocalNode, node, key, []Version{revision})}
		}(target)
	}

	deadline := time.NewTimer(c.cfg.RequestTimeout)
	defer deadline.Stop()

	acked := make(map[string]bool)
	healthy := 0
	for healthy < c.cfg.W {
		select {
		case res := <-ch:
			if res.err != nil {
				continue
			}
			healthy++
			acked[res.node] = true
		case <-deadline.C:
			return nil, ErrQuorumUnavailable{Op: "write", Needed: c.cfg.W, Got: healthy}
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	c.scheduleWriteRepair(key, revision, acked, ch)
	return clock, nil
}

// scheduleWriteRepair drains outstanding write acks inside the repair window
// and retries the revision on still-missing reachable replicas, capped.
func (c *Coordinator) scheduleWriteRepair(key string, revision Version, acked map[string]bool, ch <-chan writeAck) {
	c.bg.Add(1)
	go func() {
		defer c.bg.Done()

		window := time.NewTimer(c.cfg.RepairTimeout)
		defer window.Stop()

		pending := len(c.cfg.Nodes) - len(acked)
		for pending > 0 {
			select {
			case res := <-ch:
				pending--
				if res.err == nil {
					acked[res.node] = true
				}
			case <-window.C:
				pending = 0
			}
		}

		budget := c.cfg.MaxRepair
		for _, target := range c.cfg.Nodes {
			if budget <= 0 {
				return
			}
			if acked[target] {
				continue
			}
			if err := c.node.Write(c.cfg.LocalNode, target, key, []Version{revision}); err != nil {
				continue
			}
			acked[target] = true
			budget--
		}
	}()
}

// readMerged performs the internal R-quorum read used to anchor writes,
// returning the merged clock across healthy replicas (tombstones included).
func (c *Coordinator) readMerged(ctx context.Context, key string) (VClock, error) {
	ch := make(chan readResult, len(c.cfg.Nodes))
	for _, target := range c.cfg.Nodes {
		go func(node string) {
			versions, readErr := c.node.Read(c.cfg.LocalNode, node, key)
			ch <- readResult{node: node, versions: versions, err: readErr}
		}(target)
	}

	deadline := time.NewTimer(c.cfg.RequestTimeout)
	defer deadline.Stop()

	healthy := 0
	var merged []Version
	for healthy < c.cfg.R {
		select {
		case res := <-ch:
			if res.err != nil {
				continue
			}
			healthy++
			merged = MergeVersions(merged, res.versions)
		case <-deadline.C:
			return nil, ErrQuorumUnavailable{Op: "read-merge", Needed: c.cfg.R, Got: healthy}
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	clock := VClock{}
	for _, v := range merged {
		clock = MergeClocks(clock, v.Clock)
	}
	return clock, nil
}

// Compact advances the cluster safe watermark to a new epoch and collects
// tombstones at or below it. Because tombstones may only be dropped once
// every replica's stored clock has advanced beyond them, this is an
// all-replica operation: any unreachable node makes it fail without moving
// the watermark, leaving all tombstones retained.
func (c *Coordinator) Compact(ctx context.Context, key string) (int, error) {
	epoch := c.nextEpoch()

	for _, target := range c.cfg.Nodes {
		if err := c.node.AdvanceWatermark(c.cfg.LocalNode, target, epoch); err != nil {
			return 0, err
		}
	}

	total := 0
	for _, target := range c.cfg.Nodes {
		n, err := c.node.GC(c.cfg.LocalNode, target, key)
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

// WaitBackground blocks until all bounded post-quorum repairs finish.
func (c *Coordinator) WaitBackground() { c.bg.Wait() }

func (c *Coordinator) nextEpoch() int64 {
	c.epochMu.Lock()
	defer c.epochMu.Unlock()
	c.epoch++
	return c.epoch
}

// containsAll reports whether every version in wanted is already present
// (same clock) in have.
func containsAll(have, wanted []Version) bool {
	for _, w := range wanted {
		found := false
		for _, h := range have {
			if sameClock(h, w) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
