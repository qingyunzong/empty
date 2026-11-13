package dataeng

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

// Pair is an unordered pair of entity IDs. Its endpoints are canonicalized
// when a Pair is used as a constraint.
type Pair struct {
	Left  string
	Right string
}

// Canonical returns the pair with its endpoints sorted lexicographically.
func (p Pair) Canonical() Pair {
	if p.Left <= p.Right {
		return p
	}
	return Pair{Left: p.Right, Right: p.Left}
}

// Candidate is a proposed merge between two entities. Candidates are processed
// in descending score order.
type Candidate struct {
	Left  string
	Right string
	Score float64
}

// TieKey is the public secondary sort key used when two candidates have equal
// scores. The endpoints are canonicalized, so (b, a) and (a, b) have the same
// key.
type TieKey struct {
	Left  string
	Right string
}

// TieKey returns the candidate's deterministic tie-breaking key.
func (c Candidate) TieKey() TieKey {
	p := Pair{Left: c.Left, Right: c.Right}.Canonical()
	return TieKey{Left: p.Left, Right: p.Right}
}

// Less reports whether c should be processed before other: higher scores
// first, then ascending TieKey.
func (c Candidate) Less(other Candidate) bool {
	if c.Score != other.Score {
		return c.Score > other.Score
	}
	return c.TieKey().Less(other.TieKey())
}

// Less reports whether k sorts before other.
func (k TieKey) Less(other TieKey) bool {
	if k.Left != other.Left {
		return k.Left < other.Left
	}
	return k.Right < other.Right
}

// LinkKind identifies the reason two entities are related in a conflict path.
type LinkKind uint8

const (
	// LinkMust is an input must-link constraint.
	LinkMust LinkKind = iota + 1
	// LinkCannot is an input cannot-link constraint.
	LinkCannot
	// LinkMerge is an accepted candidate edge.
	LinkMerge
)

func (k LinkKind) String() string {
	switch k {
	case LinkMust:
		return "must-link"
	case LinkCannot:
		return "cannot-link"
	case LinkMerge:
		return "accepted-merge"
	default:
		return fmt.Sprintf("link(%d)", uint8(k))
	}
}

// Decision records how one candidate edge was resolved.
type Decision struct {
	Candidate     Candidate
	TieKey        TieKey
	Accepted      bool
	AlreadyMerged bool
	// Conflict is non-nil exactly when Accepted is false.
	Conflict *ConflictPath
}

// Rejection is a candidate that was not merged, together with a minimum-length
// conflict path proving why.
type Rejection struct {
	Candidate Candidate
	TieKey    TieKey
	Path      ConflictPath
}

// Result is the outcome of processing all candidate edges.
type Result struct {
	// Clusters contains non-empty clusters. Members and clusters are both
	// sorted lexicographically, which makes the result deterministic.
	Clusters [][]string
	// Decisions is in processing order (descending score, then ascending TieKey).
	Decisions []Decision
	// Rejected is the subset of Decisions with Accepted == false.
	Rejected []Rejection
}

// InconsistentError reports hard constraints that cannot be satisfied.
type InconsistentError struct {
	// Must is the first must-link edge in MustPath, or the canonical endpoint
	// pair when no edge exists.
	Must   Pair
	Cannot Pair
	// MustPath connects the endpoints of Cannot using must-link edges only.
	MustPath []string
}

func (e *InconsistentError) Error() string {
	if e.Cannot.Left == e.Cannot.Right {
		return fmt.Sprintf("dataeng: inconsistent constraints: cannot-link entity %q to itself", e.Cannot.Left)
	}
	return fmt.Sprintf(
		"dataeng: inconsistent constraints: cannot-link %q-%q is forced by must-link path %v",
		e.Cannot.Left, e.Cannot.Right, e.MustPath,
	)
}

// ErrInconsistent is returned when must-link and cannot-link constraints
// cannot all be satisfied.
var ErrInconsistent = errors.New("dataeng: inconsistent must-link/cannot-link constraints")

// Unwrap makes InconsistentError match ErrInconsistent with errors.Is.
func (e *InconsistentError) Unwrap() error { return ErrInconsistent }

// Graph holds hard must-link and cannot-link constraints. Once created, its
// hard constraints are immutable; Candidate processing works on a private copy.
type Graph struct {
	entities []string
	must     []Pair
	cannot   []Pair

	parent  map[string]string
	size    map[string]int
	enemies map[string]map[string]struct{}

	// mustAdj keeps the actual must-link/merge graph so conflict paths can be
	// minimum-length even when the input contains cycles.
	mustAdj map[string]map[string]LinkKind
}

// New validates the hard constraints and returns a reusable constraint graph.
//
// All must-links are applied first. A cannot-link between entities that are
// already in the same must-link component is reported as an InconsistentError.
// Entity IDs are registered in the order they first appear.
func New(must, cannot []Pair) (*Graph, error) {
	g := &Graph{
		parent:  make(map[string]string),
		size:    make(map[string]int),
		enemies: make(map[string]map[string]struct{}),
		mustAdj: make(map[string]map[string]LinkKind),
	}

	seenMust := make(map[Pair]struct{}, len(must))
	for _, p := range must {
		p = p.Canonical()
		if _, ok := seenMust[p]; ok {
			continue
		}
		seenMust[p] = struct{}{}
		g.must = append(g.must, p)
		g.register(p.Left)
		g.register(p.Right)
	}

	seenCannot := make(map[Pair]struct{}, len(cannot))
	for _, p := range cannot {
		if p.Left == p.Right {
			return nil, &InconsistentError{
				Must:     Pair{Left: p.Left, Right: p.Left},
				Cannot:   Pair{Left: p.Left, Right: p.Left},
				MustPath: []string{p.Left},
			}
		}
		p = p.Canonical()
		if _, ok := seenCannot[p]; ok {
			continue
		}
		seenCannot[p] = struct{}{}
		g.cannot = append(g.cannot, p)
		g.register(p.Left)
		g.register(p.Right)
	}

	// Union all must-links before introducing cannot-link enemies. This makes
	// the result independent of the order in which the two slices were given.
	for _, p := range g.must {
		g.addMustEdge(p.Left, p.Right, LinkMust)
	}
	for _, p := range g.cannot {
		ra, rb := g.find(p.Left), g.find(p.Right)
		if ra == rb {
			path := g.pathInComponent(p.Left, p.Right)
			must := Pair{Left: p.Left, Right: p.Right}.Canonical()
			if len(path) >= 2 {
				must = Pair{Left: path[0], Right: path[1]}.Canonical()
			}
			return nil, &InconsistentError{
				Must:     must,
				Cannot:   p,
				MustPath: path,
			}
		}
		g.addEnemy(ra, rb)
	}

	return g, nil
}

// Cluster is the one-call convenience form of New followed by Graph.Cluster.
func Cluster(must, cannot []Pair, candidates []Candidate) (*Result, error) {
	g, err := New(must, cannot)
	if err != nil {
		return nil, err
	}
	return g.Cluster(candidates)
}

// Entities returns a sorted copy of the registered entity IDs.
func (g *Graph) Entities() []string {
	out := append([]string(nil), g.entities...)
	sort.Strings(out)
	return out
}

// Register adds entity IDs that do not occur in a hard constraint. This is
// useful when candidate-only entities must also be covered by
// EnumeratePartitions. IDs that are already registered are ignored.
func (g *Graph) Register(ids ...string) {
	for _, id := range ids {
		g.register(id)
	}
}

// MustLinks returns the canonical, deduplicated input must-link constraints.
func (g *Graph) MustLinks() []Pair {
	return append([]Pair(nil), g.must...)
}

// CannotLinks returns the canonical, deduplicated input cannot-link
// constraints.
func (g *Graph) CannotLinks() []Pair {
	return append([]Pair(nil), g.cannot...)
}

// Cluster processes candidates in descending score order. Equal scores are
// ordered by the public TieKey (ascending), and completely equal keys preserve
// input order because the sort is stable.
//
// A merge is accepted only when the cannot-link closure of the current
// components contains no link between them. A rejected candidate carries a
// minimum-length conflict path.
func (g *Graph) Cluster(candidates []Candidate) (*Result, error) {
	for i, c := range candidates {
		if math.IsNaN(c.Score) {
			return nil, fmt.Errorf("dataeng: candidate %d (%q-%q) has NaN score", i, c.Left, c.Right)
		}
	}

	state := g.clone()
	ordered := append([]Candidate(nil), candidates...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].Less(ordered[j])
	})

	result := &Result{
		Clusters:  [][]string{},
		Decisions: make([]Decision, 0, len(ordered)),
		Rejected:  []Rejection{},
	}

	for _, c := range ordered {
		state.register(c.Left)
		state.register(c.Right)

		d := Decision{
			Candidate: c,
			TieKey:    c.TieKey(),
			Accepted:  true,
		}

		ra, rb := state.find(c.Left), state.find(c.Right)
		switch {
		case c.Left == c.Right || ra == rb:
			d.AlreadyMerged = true
		case state.areEnemies(ra, rb):
			path := state.minimalConflictPath(c.Left, c.Right)
			d.Accepted = false
			d.Conflict = &path
			result.Rejected = append(result.Rejected, Rejection{
				Candidate: c,
				TieKey:    d.TieKey,
				Path:      path,
			})
		default:
			state.addMustEdge(c.Left, c.Right, LinkMerge)
		}

		result.Decisions = append(result.Decisions, d)
	}

	result.Clusters = state.clusters()
	return result, nil
}

func (g *Graph) register(id string) {
	if _, ok := g.parent[id]; ok {
		return
	}
	g.parent[id] = id
	g.size[id] = 1
	g.entities = append(g.entities, id)
}

func (g *Graph) find(id string) string {
	root := id
	for g.parent[root] != root {
		root = g.parent[root]
	}
	for id != root {
		next := g.parent[id]
		g.parent[id] = root
		id = next
	}
	return root
}

func (g *Graph) addMustEdge(a, b string, kind LinkKind) {
	if a == b {
		return
	}
	g.register(a)
	g.register(b)
	if g.mustAdj[a] == nil {
		g.mustAdj[a] = make(map[string]LinkKind)
	}
	if g.mustAdj[b] == nil {
		g.mustAdj[b] = make(map[string]LinkKind)
	}
	if old, ok := g.mustAdj[a][b]; !ok || old == LinkMerge && kind == LinkMust {
		g.mustAdj[a][b] = kind
		g.mustAdj[b][a] = kind
	}
	g.union(a, b)
}

func (g *Graph) union(a, b string) {
	ra, rb := g.find(a), g.find(b)
	if ra == rb {
		return
	}
	if g.size[ra] < g.size[rb] {
		ra, rb = rb, ra
	}

	g.parent[rb] = ra
	g.size[ra] += g.size[rb]

	// Move the absorbed root's enemies onto the surviving root. Updating both
	// directions keeps the cannot-link closure symmetric.
	if len(g.enemies[rb]) > 0 && g.enemies[ra] == nil {
		g.enemies[ra] = make(map[string]struct{}, len(g.enemies[rb]))
	}
	for enemy := range g.enemies[rb] {
		delete(g.enemies[enemy], rb)
		if enemy != ra {
			g.enemies[enemy][ra] = struct{}{}
			g.enemies[ra][enemy] = struct{}{}
		}
	}
	delete(g.enemies, rb)
	delete(g.enemies[ra], ra)
	delete(g.enemies[ra], rb)
}

func (g *Graph) addEnemy(a, b string) {
	if a == b {
		return
	}
	if g.enemies[a] == nil {
		g.enemies[a] = make(map[string]struct{})
	}
	if g.enemies[b] == nil {
		g.enemies[b] = make(map[string]struct{})
	}
	g.enemies[a][b] = struct{}{}
	g.enemies[b][a] = struct{}{}
}

func (g *Graph) areEnemies(a, b string) bool {
	_, ok := g.enemies[a][b]
	return ok
}

func (g *Graph) clusters() [][]string {
	groups := make(map[string][]string)
	for _, id := range g.entities {
		root := g.find(id)
		groups[root] = append(groups[root], id)
	}

	out := make([][]string, 0, len(groups))
	for _, members := range groups {
		sort.Strings(members)
		out = append(out, members)
	}
	sort.Slice(out, func(i, j int) bool {
		if len(out[i]) == 0 || len(out[j]) == 0 {
			return len(out[i]) < len(out[j])
		}
		return out[i][0] < out[j][0]
	})
	return out
}

func (g *Graph) clone() *Graph {
	out := &Graph{
		entities: append([]string(nil), g.entities...),
		must:     g.must,
		cannot:   g.cannot,
		parent:   make(map[string]string, len(g.parent)),
		size:     make(map[string]int, len(g.size)),
		enemies:  make(map[string]map[string]struct{}, len(g.enemies)),
		mustAdj:  make(map[string]map[string]LinkKind, len(g.mustAdj)),
	}
	for id, root := range g.parent {
		out.parent[id] = root
	}
	for id, size := range g.size {
		out.size[id] = size
	}
	for root, enemies := range g.enemies {
		if len(enemies) == 0 {
			continue
		}
		copied := make(map[string]struct{}, len(enemies))
		for enemy := range enemies {
			copied[enemy] = struct{}{}
		}
		out.enemies[root] = copied
	}
	for from, neighbors := range g.mustAdj {
		copied := make(map[string]LinkKind, len(neighbors))
		for to, kind := range neighbors {
			copied[to] = kind
		}
		out.mustAdj[from] = copied
	}
	return out
}

// pathInComponent returns the lexicographically smallest shortest must-link
// path between two entities that are already in the same component.
func (g *Graph) pathInComponent(a, b string) []string {
	if a == b {
		return []string{a}
	}
	_, parent := g.bfs(a)
	path, ok := g.lexShortestPath(a, b, parent)
	if !ok {
		return []string{a, b}
	}
	return path
}
