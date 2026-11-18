package formal

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
)

var (
	// ErrNotFound reports that a node has no fragment for the requested
	// object at or below the requested version.
	ErrNotFound = errors.New("formal: shard not found")
	// ErrInvalidObjectID reports an empty object identifier.
	ErrInvalidObjectID = errors.New("formal: invalid object id")
	// ErrInvalidFragment reports a malformed fragment.
	ErrInvalidFragment = errors.New("formal: invalid fragment")
	// ErrUnsupported reports a missing NodeFunc callback.
	ErrUnsupported = errors.New("formal: unsupported operation")
)

// Fragment is one shard of one version of an object.
//
// DataLen is the original object length before padding.  Storing it with the
// shard lets a reader trim the zero padding after reconstruction and also
// serves as a consistency check across shards of the same version.
type Fragment struct {
	ObjectID string
	Index    int
	Version  uint64
	DataLen  int
	Data     []byte
}

// Clone returns a deep copy of the fragment.
func (f Fragment) Clone() Fragment {
	if f.Data != nil {
		f.Data = append([]byte(nil), f.Data...)
	}
	return f
}

// Node is one shard slot in a cluster.  A cluster with n shards uses n nodes,
// one node per shard index.
//
// Get must return the newest fragment for objectID and index whose version is
// at most maxVersion, or ErrNotFound when no such fragment exists.  Returning
// a version lower than maxVersion is allowed when the node missed a write.
// Implementations must never return a version above maxVersion: uncommitted
// writes are invisible to readers.  Implementations should retain older
// versions long enough for concurrent snapshot readers to finish.
type Node interface {
	Put(ctx context.Context, fragment Fragment) error
	Get(ctx context.Context, objectID string, index int, maxVersion uint64) (Fragment, error)
}

// NodeFunc adapts functions to the Node interface.
type NodeFunc struct {
	PutFunc func(ctx context.Context, fragment Fragment) error
	GetFunc func(ctx context.Context, objectID string, index int, maxVersion uint64) (Fragment, error)
}

// Put implements Node.
func (n NodeFunc) Put(ctx context.Context, fragment Fragment) error {
	if n.PutFunc == nil {
		return ErrUnsupported
	}
	return n.PutFunc(ctx, fragment)
}

// Get implements Node.
func (n NodeFunc) Get(ctx context.Context, objectID string, index int, maxVersion uint64) (Fragment, error) {
	if n.GetFunc == nil {
		return Fragment{}, ErrUnsupported
	}
	return n.GetFunc(ctx, objectID, index, maxVersion)
}

// MemoryNode is a thread-safe in-memory Node intended for tests and small
// deployments.  It keeps every version written to it, which preserves the
// snapshots needed by a reader that overlaps a write.  Versions are never
// garbage collected.
type MemoryNode struct {
	mu    sync.RWMutex
	slots map[string]map[uint64]Fragment
}

// NewMemoryNode returns an empty MemoryNode.
func NewMemoryNode() *MemoryNode {
	return &MemoryNode{slots: make(map[string]map[uint64]Fragment)}
}

// Put implements Node.
func (n *MemoryNode) Put(ctx context.Context, fragment Fragment) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateFragment(fragment); err != nil {
		return err
	}

	n.mu.Lock()
	defer n.mu.Unlock()
	versions := n.slots[fragment.ObjectID]
	if versions == nil {
		versions = make(map[uint64]Fragment)
		n.slots[fragment.ObjectID] = versions
	}
	versions[fragment.Version] = fragment.Clone()
	return nil
}

// Get implements Node.
func (n *MemoryNode) Get(ctx context.Context, objectID string, index int, maxVersion uint64) (Fragment, error) {
	if err := ctx.Err(); err != nil {
		return Fragment{}, err
	}
	if objectID == "" {
		return Fragment{}, ErrInvalidObjectID
	}

	n.mu.RLock()
	defer n.mu.RUnlock()
	versions := n.slots[objectID]
	var (
		best    Fragment
		bestVer uint64
		found   bool
	)
	for version, fragment := range versions {
		if version > maxVersion {
			continue
		}
		if !found || version > bestVer {
			best = fragment
			bestVer = version
			found = true
		}
	}
	if !found {
		return Fragment{}, ErrNotFound
	}
	if best.Index != index {
		return Fragment{}, fmt.Errorf("%w: object %q stored index %d, requested %d", ErrInvalidFragment, objectID, best.Index, index)
	}
	return best.Clone(), nil
}

// Versions returns the versions stored for objectID in ascending order.
func (n *MemoryNode) Versions(objectID string) []uint64 {
	n.mu.RLock()
	defer n.mu.RUnlock()
	versions := make([]uint64, 0, len(n.slots[objectID]))
	for version := range n.slots[objectID] {
		versions = append(versions, version)
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	return versions
}

// Drop removes every version of objectID from the node.
func (n *MemoryNode) Drop(objectID string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.slots, objectID)
}

func validateFragment(fragment Fragment) error {
	if fragment.ObjectID == "" {
		return ErrInvalidObjectID
	}
	if fragment.Index < 0 {
		return fmt.Errorf("%w: negative index %d", ErrInvalidFragment, fragment.Index)
	}
	if fragment.Version == 0 {
		return fmt.Errorf("%w: version must be positive", ErrInvalidFragment)
	}
	if fragment.DataLen < 0 {
		return fmt.Errorf("%w: negative data length %d", ErrInvalidFragment, fragment.DataLen)
	}
	return nil
}
