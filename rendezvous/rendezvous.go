// Package rendezvous implements rendezvous (highest random weight) hashing
// for the distributed collection scheduler.
//
// A Snapshot is an immutable, versioned view of cluster membership. Each key
// is routed to a primary node plus backup nodes drawn from distinct fault
// domains. Scores are computed with integer arithmetic only, so routing
// decisions are identical across platforms and architectures. Membership
// changes only re-route the keys that were assigned to the affected nodes.
package rendezvous

import (
	"fmt"
	"math"
	"math/bits"
	"sort"
)

// weightScale quantizes node weights to 1/weightScale precision so that
// scoring uses deterministic integer arithmetic instead of floating-point
// comparisons.
const weightScale = 1 << 20

// maxScaledWeight caps quantized weights so score products stay in 128 bits.
const maxScaledWeight = math.MaxUint32

// Node is a member of the cluster.
type Node struct {
	// ID uniquely identifies the node within a snapshot.
	ID string
	// Domain is the fault domain (rack, zone, ...) the node belongs to.
	// Backup replicas are preferentially placed in distinct domains.
	Domain string
	// Weight controls the share of keys routed to the node. A weight of 0
	// is treated as 1. Weights are quantized to 1/weightScale precision.
	Weight float64
}

type member struct {
	Node
	idHash       uint64
	scaledWeight uint64
}

// ln2Fixed48 is ln(2) in 2^-48 fixed point, computed once from the exact
// math.Ln2 constant with a single IEEE-754 multiply (deterministic).
var ln2Fixed48 = func() uint64 {
	two48 := 281474976710656.0 // 2^48
	return uint64(math.Ln2 * two48)
}()

// Snapshot is an immutable, versioned membership view.
type Snapshot struct {
	version uint64
	members []member // sorted by ID for deterministic iteration
}

// NewSnapshot builds a versioned membership snapshot. Nodes are stored in a
// canonical order, so the input order does not affect routing.
func NewSnapshot(version uint64, nodes []Node) (*Snapshot, error) {
	if len(nodes) == 0 {
		return nil, fmt.Errorf("rendezvous: snapshot requires at least one node")
	}
	seen := make(map[string]struct{}, len(nodes))
	members := make([]member, 0, len(nodes))
	for _, n := range nodes {
		if n.ID == "" {
			return nil, fmt.Errorf("rendezvous: node with empty ID")
		}
		if _, ok := seen[n.ID]; ok {
			return nil, fmt.Errorf("rendezvous: duplicate node ID %q", n.ID)
		}
		seen[n.ID] = struct{}{}
		w, err := scaleWeight(n.Weight)
		if err != nil {
			return nil, fmt.Errorf("rendezvous: node %q: %w", n.ID, err)
		}
		members = append(members, member{
			Node:         n,
			idHash:       hashString(n.ID),
			scaledWeight: w,
		})
	}
	sort.Slice(members, func(i, j int) bool { return members[i].ID < members[j].ID })
	return &Snapshot{version: version, members: members}, nil
}

// scaleWeight converts a floating-point weight into a fixed-point integer.
// The conversion is a single IEEE-754 multiply and round, which is exact and
// reproducible on every platform; all subsequent comparisons are integer-only.
func scaleWeight(w float64) (uint64, error) {
	if w == 0 {
		w = 1
	}
	if math.IsNaN(w) || math.IsInf(w, 0) || w < 0 {
		return 0, fmt.Errorf("invalid weight %v", w)
	}
	scaled := math.Round(w * weightScale)
	if scaled < 1 {
		scaled = 1
	}
	if scaled > maxScaledWeight {
		scaled = maxScaledWeight
	}
	return uint64(scaled), nil
}

// Version returns the membership version the snapshot was built with.
func (s *Snapshot) Version() uint64 { return s.version }

// Size returns the number of nodes in the snapshot.
func (s *Snapshot) Size() int { return len(s.members) }

// Nodes returns the members of the snapshot in canonical (ID-sorted) order.
func (s *Snapshot) Nodes() []Node {
	out := make([]Node, len(s.members))
	for i, m := range s.members {
		out[i] = m.Node
	}
	return out
}

// score returns the rendezvous score of a member for a key hash.
// Higher is better; comparison is pure integer arithmetic.
//
// The score is W / -ln(u), the classic weighted rendezvous formula, where
// u is a uniform value in (0,1] derived from the key/node hash and W is the
// node weight. It is evaluated entirely in fixed-point integer arithmetic
// (see negLnFixed32), so every platform produces bit-identical results while
// keys are still distributed in exact proportion to node weights.
func (m member) score(keyHash uint64) uint64 {
	h := mix64(keyHash ^ m.idHash)
	l := negLnFixed32(h)
	if l == 0 {
		return math.MaxUint64
	}
	// W / -ln(u) = (scaledWeight / 2^20) / (l / 2^32)
	//            = (scaledWeight << 12) / l
	return (m.scaledWeight << 12) / l
}

// negLnFixed32 returns -ln(h / 2^64) in 2^-32 fixed point, using only
// integer arithmetic. h == 0 is clamped to 1 to avoid ln(0).
func negLnFixed32(h uint64) uint64 {
	if h == 0 {
		h = 1
	}
	// Write h = m * 2^e with m in [1, 2). Then
	//   -ln(h / 2^64) = (64 - e) * ln(2) - ln(m).
	e := bits.Len64(h) - 1
	var m62 uint64 // m in 2^-62 fixed point
	if e <= 62 {
		m62 = h << uint(62-e)
	} else {
		m62 = h >> 1
	}
	// ln(m) via the atanh series ln(m) = 2 * (y + y^3/3 + y^5/5 + ...)
	// with y = (m-1)/(m+1) in [0, 1/3), in 2^-48 fixed point.
	a := m62 - (1 << 62)
	b := m62 + (1 << 62)
	y, _ := bits.Div64(a>>16, a<<48, b) // y * 2^48
	hi, lo := bits.Mul64(y, y)
	y2 := hi<<16 | lo>>48 // y^2 * 2^48
	sum := y
	p := y
	for k := 1; k <= 8; k++ { // terms y^3/3 .. y^17/17
		hi, lo := bits.Mul64(p, y2)
		p = hi<<16 | lo>>48
		sum += p / uint64(2*k+1)
	}
	lnm48 := 2 * sum // ln(m) * 2^48
	negLn48 := uint64(64-e)*ln2Fixed48 - lnm48
	return negLn48 >> 16 // to 2^-32 fixed point
}

// rank returns member indexes ordered by descending score for keyHash.
// Ties break toward the lexicographically smaller node ID, which is
// deterministic because members are stored sorted by ID.
func (s *Snapshot) rank(keyHash uint64) []int {
	type scored struct {
		score uint64
		idx   int
	}
	ranked := make([]scored, len(s.members))
	for i := range s.members {
		ranked[i] = scored{score: s.members[i].score(keyHash), idx: i}
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].idx < ranked[j].idx
	})
	out := make([]int, len(ranked))
	for i, r := range ranked {
		out[i] = r.idx
	}
	return out
}

// Lookup returns the primary node for key.
func (s *Snapshot) Lookup(key string) (Node, bool) {
	nodes := s.LookupN(key, 1)
	if len(nodes) == 0 {
		return Node{}, false
	}
	return nodes[0], true
}

// LookupN returns up to n nodes for key, best score first. The first result
// is the primary; the rest are backups. Backups are chosen from distinct
// fault domains whenever possible; if the snapshot has fewer domains than n,
// the remaining slots are filled with the next best-scoring nodes regardless
// of domain.
func (s *Snapshot) LookupN(key string, n int) []Node {
	if n <= 0 || len(s.members) == 0 {
		return nil
	}
	if n > len(s.members) {
		n = len(s.members)
	}
	ranked := s.rank(hashString(key))

	out := make([]Node, 0, n)
	usedDomain := make(map[string]struct{}, n)
	for _, idx := range ranked {
		if len(out) == n {
			return out
		}
		m := s.members[idx]
		if _, ok := usedDomain[m.Domain]; ok {
			continue
		}
		usedDomain[m.Domain] = struct{}{}
		out = append(out, m.Node)
	}
	// Not enough distinct domains: fill remaining slots by score.
	picked := make(map[string]struct{}, len(out))
	for _, node := range out {
		picked[node.ID] = struct{}{}
	}
	for _, idx := range ranked {
		if len(out) == n {
			break
		}
		m := s.members[idx]
		if _, ok := picked[m.ID]; ok {
			continue
		}
		picked[m.ID] = struct{}{}
		out = append(out, m.Node)
	}
	return out
}

// Migration reports how key assignments change between two snapshots.
type Migration struct {
	// Keys is the total number of keys compared.
	Keys int
	// PrimaryMoved is the number of keys whose primary node changed.
	PrimaryMoved int
	// ReplicaMoved is the number of keys whose replica set (primary plus
	// backups, order-insensitive) changed.
	ReplicaMoved int
	// PrimaryRatio is PrimaryMoved / Keys (0 when Keys is 0).
	PrimaryRatio float64
	// ReplicaRatio is ReplicaMoved / Keys (0 when Keys is 0).
	ReplicaRatio float64
}

// MigrationTo compares s with next over the given keys and reports the
// fraction of keys that must move. replicas controls how many nodes per key
// (primary + backups) are considered for the replica-set comparison.
func (s *Snapshot) MigrationTo(next *Snapshot, keys []string, replicas int) Migration {
	m := Migration{Keys: len(keys)}
	for _, key := range keys {
		before := s.LookupN(key, replicas)
		after := next.LookupN(key, replicas)
		if len(before) == 0 && len(after) == 0 {
			continue
		}
		if len(before) == 0 || len(after) == 0 || before[0].ID != after[0].ID {
			m.PrimaryMoved++
		}
		if !sameNodeSet(before, after) {
			m.ReplicaMoved++
		}
	}
	if m.Keys > 0 {
		m.PrimaryRatio = float64(m.PrimaryMoved) / float64(m.Keys)
		m.ReplicaRatio = float64(m.ReplicaMoved) / float64(m.Keys)
	}
	return m
}

func sameNodeSet(a, b []Node) bool {
	if len(a) != len(b) {
		return false
	}
	counts := make(map[string]int, len(a))
	for _, n := range a {
		counts[n.ID]++
	}
	for _, n := range b {
		counts[n.ID]--
		if counts[n.ID] < 0 {
			return false
		}
	}
	return true
}

// hashString is FNV-1a 64, implemented inline to avoid allocations.
func hashString(s string) uint64 {
	const (
		offset64 = 14695981039346656037
		prime64  = 1099511628211
	)
	h := uint64(offset64)
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= prime64
	}
	return h
}

// mix64 is the splitmix64 finalizer, used to avalanche the combined
// key/node hash before scoring.
func mix64(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}
