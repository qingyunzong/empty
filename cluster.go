// Package dataeng provides exact constrained clustering for near-duplicate
// collection records.
//
// A partition score is the sum of the signed merge benefits of every unordered
// pair of records that share a group. Must-link constraints are transitive.
// Cannot-link constraints are checked after must-link closure, so an
// inconsistent constraint set is reported with a concrete contradiction chain.
//
// The solver is exact. It supports at most MaxRecords records, enumerates every
// legal partition of the must-link components, and uses a canonical
// lexicographic tie-break over groups.
package dataeng

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// MaxRecords is the largest supported input size. Exhaustive enumeration is
// practical up to this size (Bell(12) = 4,213,597 set partitions).
const MaxRecords = 12

var (
	// ErrTooManyRecords indicates that the input exceeds MaxRecords.
	ErrTooManyRecords = errors.New("dataeng: too many records")
	// ErrDuplicateRecord indicates that a record ID was supplied more than once.
	ErrDuplicateRecord = errors.New("dataeng: duplicate record ID")
	// ErrUnknownRecord indicates that a benefit or constraint names an unknown
	// record ID.
	ErrUnknownRecord = errors.New("dataeng: unknown record ID")
	// ErrDuplicateBenefit indicates that an unordered pair has more than one
	// benefit entry. Pairs without an entry have benefit zero.
	ErrDuplicateBenefit = errors.New("dataeng: duplicate benefit pair")
	// ErrSelfBenefit indicates that a benefit entry names the same record twice.
	// Self-pairs are not part of the partition score.
	ErrSelfBenefit = errors.New("dataeng: benefit pair uses the same record twice")
	// ErrUnsatisfiable indicates that the constraints admit no legal partition.
	// The returned Result still contains a Conflict witness.
	ErrUnsatisfiable = errors.New("dataeng: constraints are unsatisfiable")
)

// Constraint is an unordered constraint between two record IDs.
type Constraint struct {
	A int
	B int
}

// PairBenefit assigns a signed merge benefit to an unordered pair of record
// IDs. The pair is unordered; PairBenefit{A: 1, B: 2} and
// PairBenefit{A: 2, B: 1} describe the same
// input and supplying both is an ErrDuplicateBenefit error.
type PairBenefit struct {
	A       int
	B       int
	Benefit int64
}

// Input is one clustering request. Records is the complete set of record IDs;
// every ID referenced by Benefits and constraints must occur in Records.
type Input struct {
	Records     []int
	Benefits    []PairBenefit
	MustLinks   []Constraint
	CannotLinks []Constraint
}

// BasisReason explains one intra-group record pair.
type BasisReason string

const (
	// BasisMustLink means the pair is forced by the transitive must-link
	// closure. MustLinkPath contains one shortest deterministic chain.
	BasisMustLink BasisReason = "must-link"
	// BasisPositive means the pair contributes a strictly positive benefit.
	BasisPositive BasisReason = "positive"
	// BasisZero means the pair contributes zero (the default benefit).
	BasisZero BasisReason = "zero"
	// BasisNegative means the pair contributes a negative benefit.
	BasisNegative BasisReason = "negative"
)

// PairBasis is the evidence for one unordered pair inside a result group.
type PairBasis struct {
	A       int
	B       int
	Benefit int64
	// MustLink is true when A and B are in the same must-link component.
	MustLink bool
	// MustLinkPath is a shortest must-link path from A to B when MustLink is
	// true, including both endpoints. It is nil otherwise.
	MustLinkPath []int
	Reason       BasisReason
}

// Group is one cluster in the selected partition. IDs are sorted ascending.
// Score is the sum of Basis benefits for all unordered pairs in this group.
type Group struct {
	IDs   []int
	Score int64
	Basis []PairBasis
}

// ConstraintKind identifies a link in a conflict witness.
type ConstraintKind string

const (
	// KindMustLink is a must-link edge in a conflict witness.
	KindMustLink ConstraintKind = "must-link"
	// KindCannotLink is the cannot-link edge that closes a contradiction.
	KindCannotLink ConstraintKind = "cannot-link"
)

// ChainLink is one constraint in a conflict witness.
type ChainLink struct {
	Kind ConstraintKind
	A    int
	B    int
}

// Conflict is an unsatisfiable constraint witness. MustLinkPath connects the
// endpoints of CannotLink using direct must-link edges; Chain lists that path
// followed by the cannot-link edge.
type Conflict struct {
	CannotLink   Constraint
	MustLinkPath []int
	Chain        []ChainLink
	Message      string
}

// Result is the selected partition or an unsatisfiable conflict witness.
type Result struct {
	Feasible bool
	Score    int64
	// Groups is sorted by each group's smallest record ID. The IDs in each
	// group are sorted as well.
	Groups []Group
	// Conflict is set, and ErrUnsatisfiable is returned, when no legal
	// partition exists.
	Conflict *Conflict
}

// GroupIDs returns the selected groups as plain ID slices. It is a convenient
// form for callers that do not need the per-pair basis.
func (r Result) GroupIDs() [][]int {
	groups := make([][]int, len(r.Groups))
	for i, group := range r.Groups {
		groups[i] = append([]int(nil), group.IDs...)
	}
	return groups
}

// Cluster solves one clustering request exactly.
//
// It returns ErrTooManyRecords, ErrDuplicateRecord, ErrUnknownRecord,
// ErrDuplicateBenefit or ErrSelfBenefit for invalid input. If the constraints
// are contradictory, it returns a Result with Feasible false and Conflict set,
// together with ErrUnsatisfiable.
func Cluster(in Input) (Result, error) {
	records, idIndex, err := normalizeRecords(in.Records)
	if err != nil {
		return Result{}, err
	}

	benefit, hasBenefit, err := normalizeBenefits(in.Benefits, idIndex)
	if err != nil {
		return Result{}, err
	}

	mustEdges, cannotEdges, err := normalizeConstraints(in.MustLinks, in.CannotLinks, idIndex)
	if err != nil {
		return Result{}, err
	}

	recordCount := len(records)
	if recordCount == 0 {
		return Result{Feasible: true, Groups: []Group{}}, nil
	}

	dsu := newDisjointSet(recordCount)
	for _, edge := range mustEdges {
		dsu.union(edge[0], edge[1])
	}

	mustAdj := buildMustAdjacency(recordCount, mustEdges)

	// A cannot-link inside a must-link component is the only source of
	// unsatisfiability: separating every component into its own group always
	// satisfies all remaining cross-component cannot-links.
	if conflict := firstConflict(dsu, cannotEdges, mustAdj, records); conflict != nil {
		return Result{Feasible: false, Conflict: conflict}, ErrUnsatisfiable
	}

	// Collapse each transitive must-link component into an indivisible atom.
	var atoms []atomInfo
	rootAtom := make(map[int]int, recordCount)
	var atomOf [MaxRecords]int
	for record := 0; record < recordCount; record++ {
		root := dsu.find(record)
		atom, ok := rootAtom[root]
		if !ok {
			atom = len(atoms)
			rootAtom[root] = atom
			atoms = append(atoms, atomInfo{})
		}
		atoms[atom].members = append(atoms[atom].members, record)
		atomOf[record] = atom
	}

	var baseScore int64
	var weights [MaxRecords][MaxRecords]int64
	for a := 0; a < recordCount; a++ {
		for b := a + 1; b < recordCount; b++ {
			if !hasBenefit[a][b] {
				continue
			}
			left, right := atomOf[a], atomOf[b]
			if left == right {
				baseScore += benefit[a][b]
			} else {
				weights[left][right] += benefit[a][b]
				weights[right][left] += benefit[a][b]
			}
		}
	}

	var cannotMask [MaxRecords]uint16
	for _, edge := range cannotEdges {
		left, right := atomOf[edge[0]], atomOf[edge[1]]
		if left == right {
			panic("dataeng: internal error: missed cannot-link conflict")
		}
		cannotMask[left] |= 1 << uint(right)
		cannotMask[right] |= 1 << uint(left)
	}

	solver := partitionSolver{
		recordCount: recordCount,
		atomCount:   len(atoms),
		atoms:       atoms,
		weights:     weights,
		cannotMask:  cannotMask,
		score:       baseScore,
	}
	solver.search(0)

	groups := buildGroups(
		records,
		idIndex,
		benefit,
		hasBenefit,
		dsu,
		mustAdj,
		atoms,
		atomOf,
		solver.bestLabels,
	)

	return Result{
		Feasible: true,
		Score:    solver.bestScore,
		Groups:   groups,
	}, nil
}

// Solve is the positional convenience form of Cluster.
func Solve(records []int, benefits []PairBenefit, mustLinks, cannotLinks []Constraint) (Result, error) {
	return Cluster(Input{
		Records:     records,
		Benefits:    benefits,
		MustLinks:   mustLinks,
		CannotLinks: cannotLinks,
	})
}

// Partition is an alias for Solve.
func Partition(records []int, benefits []PairBenefit, mustLinks, cannotLinks []Constraint) (Result, error) {
	return Solve(records, benefits, mustLinks, cannotLinks)
}

type atomInfo struct {
	// members are record indexes in the normalized, ascending ID order.
	members []int
}

func normalizeRecords(input []int) ([]int, map[int]int, error) {
	if len(input) > MaxRecords {
		return nil, nil, fmt.Errorf("%w: got %d, maximum is %d", ErrTooManyRecords, len(input), MaxRecords)
	}
	records := append([]int(nil), input...)
	sort.Ints(records)
	for i := 1; i < len(records); i++ {
		if records[i] == records[i-1] {
			return nil, nil, fmt.Errorf("%w: %d", ErrDuplicateRecord, records[i])
		}
	}
	index := make(map[int]int, len(records))
	for i, id := range records {
		index[id] = i
	}
	return records, index, nil
}

func normalizeBenefits(input []PairBenefit, idIndex map[int]int) ([MaxRecords][MaxRecords]int64, [MaxRecords][MaxRecords]bool, error) {
	var benefit [MaxRecords][MaxRecords]int64
	var present [MaxRecords][MaxRecords]bool
	for _, entry := range input {
		left, ok := idIndex[entry.A]
		if !ok {
			return benefit, present, fmt.Errorf("%w: %d in benefit pair", ErrUnknownRecord, entry.A)
		}
		right, ok := idIndex[entry.B]
		if !ok {
			return benefit, present, fmt.Errorf("%w: %d in benefit pair", ErrUnknownRecord, entry.B)
		}
		if left == right {
			return benefit, present, fmt.Errorf("%w: %d", ErrSelfBenefit, entry.A)
		}
		if left > right {
			left, right = right, left
		}
		if present[left][right] {
			return benefit, present, fmt.Errorf("%w: (%d, %d)", ErrDuplicateBenefit,
				minInt(entry.A, entry.B), maxInt(entry.A, entry.B))
		}
		present[left][right] = true
		present[right][left] = true
		benefit[left][right] = entry.Benefit
		benefit[right][left] = entry.Benefit
	}
	return benefit, present, nil
}

func normalizeConstraints(mustLinks, cannotLinks []Constraint, idIndex map[int]int) ([][2]int, [][2]int, error) {
	mustEdges := make([][2]int, 0, len(mustLinks))
	seenMust := make(map[[2]int]bool)
	for _, link := range mustLinks {
		left, ok := idIndex[link.A]
		if !ok {
			return nil, nil, fmt.Errorf("%w: %d in must-link", ErrUnknownRecord, link.A)
		}
		right, ok := idIndex[link.B]
		if !ok {
			return nil, nil, fmt.Errorf("%w: %d in must-link", ErrUnknownRecord, link.B)
		}
		if left == right {
			continue
		}
		if left > right {
			left, right = right, left
		}
		key := [2]int{left, right}
		if !seenMust[key] {
			seenMust[key] = true
			mustEdges = append(mustEdges, key)
		}
	}

	cannotEdges := make([][2]int, 0, len(cannotLinks))
	seenCannot := make(map[[2]int]bool)
	for _, link := range cannotLinks {
		left, ok := idIndex[link.A]
		if !ok {
			return nil, nil, fmt.Errorf("%w: %d in cannot-link", ErrUnknownRecord, link.A)
		}
		right, ok := idIndex[link.B]
		if !ok {
			return nil, nil, fmt.Errorf("%w: %d in cannot-link", ErrUnknownRecord, link.B)
		}
		if left > right {
			left, right = right, left
		}
		key := [2]int{left, right}
		if !seenCannot[key] {
			seenCannot[key] = true
			cannotEdges = append(cannotEdges, key)
		}
	}
	return mustEdges, cannotEdges, nil
}

func buildMustAdjacency(recordCount int, edges [][2]int) [][]int {
	adj := make([][]int, recordCount)
	for _, edge := range edges {
		adj[edge[0]] = append(adj[edge[0]], edge[1])
		adj[edge[1]] = append(adj[edge[1]], edge[0])
	}
	for i := range adj {
		sort.Ints(adj[i])
	}
	return adj
}

// firstConflict picks a deterministic contradiction witness. It prefers the
// lexicographically smallest cannot-link pair, then the lexicographically
// smallest shortest must-link path.
func firstConflict(dsu *disjointSet, cannotEdges [][2]int, mustAdj [][]int, records []int) *Conflict {
	var selected *[2]int
	for i := range cannotEdges {
		edge := cannotEdges[i]
		if dsu.find(edge[0]) != dsu.find(edge[1]) {
			continue
		}
		if selected == nil || edge[0] < selected[0] || (edge[0] == selected[0] && edge[1] < selected[1]) {
			copy := edge
			selected = &copy
		}
	}
	if selected == nil {
		return nil
	}

	path := shortestMustLinkPath(mustAdj, selected[0], selected[1])
	chain := make([]ChainLink, 0, len(path)+1)
	for i := 0; i+1 < len(path); i++ {
		chain = append(chain, ChainLink{
			Kind: KindMustLink,
			A:    records[path[i]],
			B:    records[path[i+1]],
		})
	}
	chain = append(chain, ChainLink{
		Kind: KindCannotLink,
		A:    records[selected[0]],
		B:    records[selected[1]],
	})

	pathIDs := make([]int, len(path))
	for i, record := range path {
		pathIDs[i] = records[record]
	}

	message := fmt.Sprintf("cannot-link (%d, %d) contradicts must-link path %s",
		records[selected[0]], records[selected[1]], formatIDs(pathIDs))
	if selected[0] == selected[1] {
		message = fmt.Sprintf("cannot-link (%d, %d) forbids a record from sharing a group with itself",
			records[selected[0]], records[selected[1]])
	}

	return &Conflict{
		CannotLink:   Constraint{A: records[selected[0]], B: records[selected[1]]},
		MustLinkPath: pathIDs,
		Chain:        chain,
		Message:      message,
	}
}

func formatIDs(ids []int) string {
	var builder strings.Builder
	builder.WriteByte('[')
	for i, id := range ids {
		if i > 0 {
			builder.WriteString(", ")
		}
		fmt.Fprintf(&builder, "%d", id)
	}
	builder.WriteByte(']')
	return builder.String()
}

// shortestMustLinkPath returns the lexicographically smallest shortest path
// between from and to. It is only called when both records are in one
// must-link component.
func shortestMustLinkPath(adj [][]int, from, to int) []int {
	if from == to {
		return []int{from}
	}
	dist := make([]int, len(adj))
	for i := range dist {
		dist[i] = -1
	}
	dist[to] = 0
	queue := []int{to}
	for head := 0; head < len(queue); head++ {
		current := queue[head]
		for _, next := range adj[current] {
			if dist[next] == -1 {
				dist[next] = dist[current] + 1
				queue = append(queue, next)
			}
		}
	}
	if dist[from] < 0 {
		return nil
	}

	path := make([]int, 0, dist[from]+1)
	current := from
	path = append(path, current)
	for current != to {
		for _, next := range adj[current] {
			if dist[next] == dist[current]-1 {
				current = next
				path = append(path, current)
				break
			}
		}
	}
	return path
}

type disjointSet struct {
	parent []int
	size   []int
}

func newDisjointSet(n int) *disjointSet {
	parent := make([]int, n)
	size := make([]int, n)
	for i := range parent {
		parent[i] = i
		size[i] = 1
	}
	return &disjointSet{parent: parent, size: size}
}

func (d *disjointSet) find(x int) int {
	root := x
	for d.parent[root] != root {
		root = d.parent[root]
	}
	for d.parent[x] != root {
		next := d.parent[x]
		d.parent[x] = root
		x = next
	}
	return root
}

func (d *disjointSet) union(a, b int) {
	left, right := d.find(a), d.find(b)
	if left == right {
		return
	}
	if d.size[left] < d.size[right] {
		left, right = right, left
	}
	d.parent[right] = left
	d.size[left] += d.size[right]
}

type partitionSolver struct {
	recordCount int
	atomCount   int
	atoms       []atomInfo
	weights     [MaxRecords][MaxRecords]int64
	cannotMask  [MaxRecords]uint16

	labels     [MaxRecords]int
	blockMask  [MaxRecords]uint16
	blockCount int

	score int64

	bestFound  bool
	bestScore  int64
	bestLabels [MaxRecords]int
	bestRGS    [MaxRecords]int
}

func (s *partitionSolver) search(atom int) {
	if atom == s.atomCount {
		if !s.bestFound || s.score > s.bestScore {
			groupOfRecord := s.recordGroups()
			s.bestFound = true
			s.bestScore = s.score
			s.bestLabels = s.labels
			s.bestRGS = groupOfRecord
			return
		}
		if s.score == s.bestScore {
			groupOfRecord := s.recordGroups()
			if canonicalPartitionLess(&groupOfRecord, &s.bestRGS, s.recordCount) {
				s.bestLabels = s.labels
				s.bestRGS = groupOfRecord
			}
		}
		return
	}

	bit := uint16(1) << uint(atom)
	for block := 0; block < s.blockCount; block++ {
		if s.blockMask[block]&s.cannotMask[atom] != 0 {
			continue
		}
		increment := s.joinIncrement(atom, block)
		s.labels[atom] = block
		s.blockMask[block] |= bit
		s.score += increment
		s.search(atom + 1)
		s.score -= increment
		s.blockMask[block] &^= bit
	}

	block := s.blockCount
	s.labels[atom] = block
	s.blockMask[block] = bit
	s.blockCount++
	s.search(atom + 1)
	s.blockCount--
	s.blockMask[block] = 0
}

func (s *partitionSolver) joinIncrement(atom, block int) int64 {
	var increment int64
	mask := s.blockMask[block]
	for member := 0; mask != 0; member++ {
		if mask&1 != 0 {
			increment += s.weights[atom][member]
		}
		mask >>= 1
	}
	return increment
}

func (s *partitionSolver) recordGroups() [MaxRecords]int {
	var groupOfRecord [MaxRecords]int
	for atom := 0; atom < s.atomCount; atom++ {
		block := s.labels[atom]
		for _, record := range s.atoms[atom].members {
			groupOfRecord[record] = block
		}
	}
	return groupOfRecord
}

// canonicalPartitionLess implements the tie-break: sort IDs within every group,
// sort groups by their smallest ID, then compare the resulting group list
// lexicographically. A shorter group is smaller when it is a prefix of another
// group.
func canonicalPartitionLess(left, right *[MaxRecords]int, recordCount int) bool {
	leftMax, rightMax := 0, 0
	for record := 0; record < recordCount; record++ {
		if left[record] > leftMax {
			leftMax = left[record]
		}
		if right[record] > rightMax {
			rightMax = right[record]
		}
	}

	for group := 0; ; group++ {
		if group > leftMax && group > rightMax {
			return false
		}
		if group > leftMax {
			return true
		}
		if group > rightMax {
			return false
		}

		leftFrom, rightFrom := 0, 0
		for {
			leftMember, leftOK := nextGroupMember(left, group, leftFrom, recordCount)
			rightMember, rightOK := nextGroupMember(right, group, rightFrom, recordCount)
			if !leftOK && !rightOK {
				break
			}
			if !leftOK {
				return true
			}
			if !rightOK {
				return false
			}
			if leftMember != rightMember {
				return leftMember < rightMember
			}
			leftFrom = leftMember + 1
			rightFrom = rightMember + 1
		}
	}
}

func nextGroupMember(groupOfRecord *[MaxRecords]int, group, from, recordCount int) (int, bool) {
	for record := from; record < recordCount; record++ {
		if groupOfRecord[record] == group {
			return record, true
		}
	}
	return 0, false
}

func buildGroups(
	records []int,
	idIndex map[int]int,
	benefit [MaxRecords][MaxRecords]int64,
	hasBenefit [MaxRecords][MaxRecords]bool,
	dsu *disjointSet,
	mustAdj [][]int,
	atoms []atomInfo,
	atomOf [MaxRecords]int,
	labels [MaxRecords]int,
) []Group {
	groupCount := 0
	for atom := range atoms {
		if labels[atom]+1 > groupCount {
			groupCount = labels[atom] + 1
		}
	}

	groups := make([]Group, 0, groupCount)
	for block := 0; block < groupCount; block++ {
		ids := make([]int, 0, len(records))
		for record := 0; record < len(records); record++ {
			if labels[atomOf[record]] == block {
				ids = append(ids, records[record])
			}
		}
		groups = append(groups, makeGroup(ids, idIndex, benefit, hasBenefit, dsu, mustAdj, records))
	}
	sort.Slice(groups, func(i, j int) bool {
		return groups[i].IDs[0] < groups[j].IDs[0]
	})
	return groups
}

func makeGroup(
	ids []int,
	idIndex map[int]int,
	benefit [MaxRecords][MaxRecords]int64,
	hasBenefit [MaxRecords][MaxRecords]bool,
	dsu *disjointSet,
	mustAdj [][]int,
	records []int,
) Group {
	group := Group{
		IDs:   ids,
		Basis: make([]PairBasis, 0, len(ids)*(len(ids)-1)/2),
	}
	for i := 0; i < len(ids); i++ {
		for j := i + 1; j < len(ids); j++ {
			left, right := idIndex[ids[i]], idIndex[ids[j]]
			var value int64
			if hasBenefit[left][right] {
				value = benefit[left][right]
			}

			sameComponent := dsu.find(left) == dsu.find(right)
			var path []int
			if sameComponent {
				path = shortestMustLinkPath(mustAdj, left, right)
				for k, record := range path {
					path[k] = records[record]
				}
			}

			reason := BasisZero
			if sameComponent {
				reason = BasisMustLink
			} else if value > 0 {
				reason = BasisPositive
			} else if value < 0 {
				reason = BasisNegative
			}

			group.Score += value
			group.Basis = append(group.Basis, PairBasis{
				A:            ids[i],
				B:            ids[j],
				Benefit:      value,
				MustLink:     sameComponent,
				MustLinkPath: path,
				Reason:       reason,
			})
		}
	}
	return group
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
