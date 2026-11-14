package dataeng

import (
	"fmt"
	"math"
	"math/bits"
	"sort"
	"strings"
)

const (
	// maxExactPages is the hard workflow bound for SolveExact. The exact
	// solver uses a uint64 subset, and the state-space check below rejects
	// batches whose DP would not fit comfortably in memory.
	maxExactPages = 16
	maxExactState = 1_500_000
)

const costEpsilon = 1e-9

type choice struct {
	hasNumber  bool
	number     int
	confidence float64
	source     string
}

type model struct {
	opts Options
	doc  Document

	pages   []Page
	ranks   []int
	missing []int

	choices [][]choice
	cMax    int

	ocr        [][]float64
	unnumbered [][]float64
	parity     [][]float64
	duplicate  [][]float64

	higherBits []bitset
}

type bitset []uint64

func newBitset(n int) bitset {
	return make(bitset, (n+63)/64)
}

func (b bitset) clone() bitset {
	out := make(bitset, len(b))
	copy(out, b)
	return out
}

func (b bitset) has(i int) bool {
	return b[i>>6]&(uint64(1)<<(uint(i)&63)) != 0
}

func (b bitset) set(i int) {
	b[i>>6] |= uint64(1) << (uint(i) & 63)
}

func (b bitset) andCount(other bitset) int {
	n := 0
	for i := range b {
		n += bits.OnesCount64(b[i] & other[i])
	}
	return n
}

func newModel(doc Document, opts Options) (*model, error) {
	m := &model{opts: opts, doc: doc}
	if err := m.validateAndNormalize(); err != nil {
		return nil, err
	}
	m.buildChoices()
	if err := m.buildUnary(); err != nil {
		return nil, err
	}
	m.buildFileEvidence()
	return m, nil
}

func (m *model) validateAndNormalize() error {
	m.pages = make([]Page, len(m.doc.Pages))
	copy(m.pages, m.doc.Pages)

	seenIDs := make(map[string]struct{}, len(m.pages))
	for i := range m.pages {
		p := &m.pages[i]
		if p.ID == "" {
			p.ID = fmt.Sprintf("page-%d", i)
		}
		if _, ok := seenIDs[p.ID]; ok {
			return fmt.Errorf("dataeng: duplicate page ID %q", p.ID)
		}
		seenIDs[p.ID] = struct{}{}
		if p.FileIndex < 0 {
			return fmt.Errorf("dataeng: page %q has negative FileIndex", p.ID)
		}
		if p.Role > RoleInsert {
			return fmt.Errorf("dataeng: page %q has unknown role %d", p.ID, uint8(p.Role))
		}
		if p.Side > SideBack {
			return fmt.Errorf("dataeng: page %q has unknown side %d", p.ID, uint8(p.Side))
		}
		for j := range p.Candidates {
			c := &p.Candidates[j]
			if c.Number <= 0 {
				return fmt.Errorf("dataeng: page %q has non-positive page number %d", p.ID, c.Number)
			}
			if math.IsNaN(c.Confidence) || math.IsInf(c.Confidence, 0) ||
				c.Confidence < 0 || c.Confidence > 1 {
				return fmt.Errorf("dataeng: page %q has invalid confidence %v", p.ID, c.Confidence)
			}
		}
	}

	missingSeen := make(map[int]struct{}, len(m.doc.MissingPages))
	for _, n := range m.doc.MissingPages {
		if n <= 0 {
			return fmt.Errorf("dataeng: missing page number must be positive, got %d", n)
		}
		if _, ok := missingSeen[n]; !ok {
			m.missing = append(m.missing, n)
			missingSeen[n] = struct{}{}
		}
	}
	sort.Ints(m.missing)
	return nil
}

func effectiveConfidence(c NumberCandidate) float64 {
	if c.Confidence == 0 {
		return 1
	}
	return c.Confidence
}

func (m *model) buildChoices() {
	m.choices = make([][]choice, len(m.pages))
	for i, p := range m.pages {
		m.choices[i] = []choice{{}}
		if p.Role != RoleContent {
			continue
		}

		best := make(map[int]NumberCandidate)
		for _, c := range p.Candidates {
			c.Confidence = effectiveConfidence(c)
			old, ok := best[c.Number]
			if !ok || c.Confidence > old.Confidence ||
				(c.Confidence == old.Confidence && c.Source < old.Source) {
				best[c.Number] = c
			}
		}
		numbers := make([]int, 0, len(best))
		for n := range best {
			numbers = append(numbers, n)
		}
		sort.Ints(numbers)
		for _, n := range numbers {
			c := best[n]
			m.choices[i] = append(m.choices[i], choice{
				hasNumber:  true,
				number:     n,
				confidence: c.Confidence,
				source:     c.Source,
			})
		}
		if len(m.choices[i]) > m.cMax {
			m.cMax = len(m.choices[i])
		}
	}
	if m.cMax == 0 {
		m.cMax = 1
	}
}

func (m *model) buildUnary() error {
	n := len(m.pages)
	m.ocr = make([][]float64, n)
	m.unnumbered = make([][]float64, n)
	m.parity = make([][]float64, n)
	m.duplicate = make([][]float64, n)

	type group struct {
		pages         []int
		numbers       map[int]int
		evidencePages int
		max           int
	}
	groups := make(map[string]*group)
	for i, p := range m.pages {
		if p.Role != RoleContent || p.Digest == "" {
			continue
		}
		g := groups[p.Digest]
		if g == nil {
			g = &group{numbers: make(map[int]int)}
			groups[p.Digest] = g
		}
		g.pages = append(g.pages, i)
		if len(p.Candidates) > 0 {
			g.evidencePages++
		}
	}
	for _, g := range groups {
		for _, i := range g.pages {
			for _, c := range m.choices[i] {
				if c.hasNumber {
					g.numbers[c.number]++
					if g.numbers[c.number] > g.max {
						g.max = g.numbers[c.number]
					}
				}
			}
		}
	}

	w := m.opts.Weights
	for i, p := range m.pages {
		nc := len(m.choices[i])
		m.ocr[i] = make([]float64, nc)
		m.unnumbered[i] = make([]float64, nc)
		m.parity[i] = make([]float64, nc)
		m.duplicate[i] = make([]float64, nc)

		for ci := 1; ci < nc; ci++ {
			c := m.choices[i][ci]
			m.ocr[i][ci] = w.OCR * (1 - c.confidence)
			if m.opts.Parity != ParityIgnored && p.Side != SideUnknown &&
				expectationForSide(p.Side, m.opts.Parity) != (c.number&1) {
				m.parity[i][ci] = w.Parity
			}
			if p.Digest != "" {
				g := groups[p.Digest]
				if g.evidencePages > 1 && g.max >= 2 {
					supporters := g.numbers[c.number] - 1
					if supporters < 0 {
						supporters = 0
					}
					support := float64(supporters) / float64(g.evidencePages-1)
					m.duplicate[i][ci] = w.Duplicate * (1 - support)
				}
			}
		}

		if p.Role == RoleContent && len(p.Candidates) > 0 {
			m.unnumbered[i][0] = w.Unnumbered
		}
	}
	return nil
}

func expectationForSide(side Side, rule ParityRule) int {
	switch rule {
	case FrontEvenBackOdd:
		if side == SideFront {
			return 0
		}
		return 1
	case ParityIgnored:
		return -1
	default:
		if side == SideFront {
			return 1
		}
		return 0
	}
}

func (m *model) buildFileEvidence() {
	n := len(m.pages)
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		ia, ib := order[a], order[b]
		if m.pages[ia].FileIndex != m.pages[ib].FileIndex {
			return m.pages[ia].FileIndex < m.pages[ib].FileIndex
		}
		return ia < ib
	})

	m.ranks = make([]int, n)
	for rank, idx := range order {
		m.ranks[idx] = rank
	}

	m.higherBits = make([]bitset, n)
	for i := range m.higherBits {
		m.higherBits[i] = newBitset(n)
	}
	for i := 0; i < n; i++ {
		for j := 0; j < n; j++ {
			if m.ranks[j] > m.ranks[i] {
				m.higherBits[i].set(j)
			}
		}
	}
}

func (m *model) unaryTotal(page, ci int) float64 {
	return m.ocr[page][ci] +
		m.unnumbered[page][ci] +
		m.parity[page][ci] +
		m.duplicate[page][ci]
}

func (m *model) sequenceCost(page, ci, lastNum, lastChoice int) (order, continuity float64) {
	if lastNum < 0 || lastNum >= len(m.pages) ||
		page >= len(m.pages) || m.pages[page].Role != RoleContent {
		return 0, 0
	}
	if lastChoice < 0 || lastChoice >= len(m.choices[lastNum]) {
		return 0, 0
	}
	c := m.choices[page][ci]
	if !c.hasNumber {
		return 0, 0
	}
	prev := m.pages[lastNum]
	pc := m.choices[lastNum][lastChoice]
	if !pc.hasNumber {
		return 0, 0
	}

	if prev.Digest != "" && prev.Digest == m.pages[page].Digest {
		// Two observations of the same physical page are allowed to carry
		// the same number without creating a repeated-page violation.
		return 0, 0
	}

	if c.number <= pc.number {
		return m.opts.Weights.PageNumber * float64(pc.number-c.number+1), 0
	}
	if !m.opts.RequireContiguous {
		return 0, 0
	}
	gap := c.number - pc.number - 1
	if gap <= 0 {
		return 0, 0
	}
	undeclared := gap - m.missingBetween(pc.number, c.number)
	if undeclared <= 0 {
		return 0, 0
	}
	return 0, m.opts.Weights.Continuity * float64(undeclared)
}

func (m *model) missingBetween(lo, hi int) int {
	if hi <= lo+1 || len(m.missing) == 0 {
		return 0
	}
	lower := sort.SearchInts(m.missing, lo+1)
	upper := sort.SearchInts(m.missing, hi)
	if upper < lower {
		return 0
	}
	return upper - lower
}

func (m *model) fileCost(mask bitset, page int) float64 {
	inv := int(m.higherBits[page].andCount(mask))
	return m.opts.Weights.FileOrder * float64(inv)
}

func (m *model) neededLast(page, ci, lastNum, lastChoice int) (int, int) {
	if m.pages[page].Role == RoleContent && m.choices[page][ci].hasNumber {
		return page, ci
	}
	return lastNum, lastChoice
}

func (m *model) evaluate(seq, choices []int) (Arrangement, error) {
	if len(seq) != len(m.pages) || len(choices) != len(seq) {
		return Arrangement{}, fmt.Errorf("dataeng: internal arrangement length mismatch")
	}

	arr := Arrangement{Pages: make([]Placement, 0, len(seq))}
	var bd CostBreakdown
	placed := newBitset(len(m.pages))
	seenPages := make([]bool, len(m.pages))
	lastNum, lastChoice := -1, 0
	firstByDigest := make(map[string]string, len(m.pages))

	for pos, page := range seq {
		if page < 0 || page >= len(m.pages) {
			return Arrangement{}, fmt.Errorf("dataeng: internal page index %d", page)
		}
		if seenPages[page] {
			return Arrangement{}, fmt.Errorf("dataeng: internal duplicate page index %d", page)
		}
		seenPages[page] = true
		ci := choices[pos]
		if ci < 0 || ci >= len(m.choices[page]) {
			return Arrangement{}, fmt.Errorf("dataeng: internal choice index %d", ci)
		}
		p := m.pages[page]
		c := m.choices[page][ci]

		bd.OCR += m.ocr[page][ci]
		bd.Unnumbered += m.unnumbered[page][ci]
		bd.Parity += m.parity[page][ci]
		bd.Duplicate += m.duplicate[page][ci]
		bd.FileOrder += m.fileCost(placed, page)
		order, continuity := m.sequenceCost(page, ci, lastNum, lastChoice)
		bd.PageNumber += order
		bd.Continuity += continuity

		dupOf := ""
		if p.Digest != "" {
			if first, ok := firstByDigest[p.Digest]; ok {
				dupOf = first
			} else {
				firstByDigest[p.Digest] = p.ID
			}
		}
		arr.Pages = append(arr.Pages, Placement{
			PageID:      p.ID,
			InputIndex:  page,
			FileIndex:   p.FileIndex,
			Role:        p.Role,
			Side:        p.Side,
			Digest:      p.Digest,
			Number:      c.number,
			HasNumber:   c.hasNumber,
			Confidence:  c.confidence,
			Source:      c.source,
			DuplicateOf: dupOf,
		})

		placed.set(page)
		lastNum, lastChoice = m.neededLast(page, ci, lastNum, lastChoice)
	}

	bd.Total = bd.OCR + bd.Unnumbered + bd.PageNumber + bd.Continuity +
		bd.Parity + bd.FileOrder + bd.Duplicate
	arr.Breakdown = bd
	arr.Cost = bd.Total
	return arr, nil
}

type solvedArrangement struct {
	arr     Arrangement
	seq     []int
	choices []int
}

func (m *model) solved(seq, choices []int) (solvedArrangement, error) {
	arr, err := m.evaluate(seq, choices)
	if err != nil {
		return solvedArrangement{}, err
	}
	return solvedArrangement{
		arr:     arr,
		seq:     append([]int(nil), seq...),
		choices: append([]int(nil), choices...),
	}, nil
}

func (m *model) arrangementSignature(s solvedArrangement) string {
	var b strings.Builder
	for i, page := range s.seq {
		if i > 0 {
			b.WriteByte('|')
		}
		fmt.Fprintf(&b, "%d:%d", page, s.choices[i])
	}
	return b.String()
}

func (m *model) lessSolved(a, b solvedArrangement) bool {
	if math.Abs(a.arr.Cost-b.arr.Cost) > costEpsilon {
		return a.arr.Cost < b.arr.Cost
	}
	for i := 0; i < len(a.seq) && i < len(b.seq); i++ {
		ra, rb := m.ranks[a.seq[i]], m.ranks[b.seq[i]]
		if ra != rb {
			return ra < rb
		}
		na, nb := m.choices[a.seq[i]][a.choices[i]].number, m.choices[b.seq[i]][b.choices[i]].number
		if na != nb {
			return na < nb
		}
	}
	if len(a.seq) != len(b.seq) {
		return len(a.seq) < len(b.seq)
	}
	// A final deterministic fallback for pages sharing FileIndex.
	for i := range a.seq {
		if a.seq[i] != b.seq[i] {
			return a.seq[i] < b.seq[i]
		}
	}
	return false
}

func (m *model) buildResult(cands []solvedArrangement, exhaustive, truncated bool) Result {
	sort.SliceStable(cands, func(i, j int) bool {
		return m.lessSolved(cands[i], cands[j])
	})

	seen := make(map[string]struct{}, len(cands))
	distinct := make([]solvedArrangement, 0, len(cands))
	for _, c := range cands {
		key := m.arrangementSignature(c)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		distinct = append(distinct, c)
	}
	if len(distinct) == 0 {
		return Result{Exhaustive: exhaustive, Truncated: truncated}
	}

	best := distinct[0].arr.Cost
	maxCost := best + m.opts.CostWindow + costEpsilon
	out := make([]Arrangement, 0, min(m.opts.MaxCandidates, len(distinct)))
	for _, c := range distinct {
		if c.arr.Cost > maxCost {
			break
		}
		if len(out) >= m.opts.MaxCandidates {
			truncated = true
			break
		}
		out = append(out, c.arr)
	}
	return Result{
		Candidates: out,
		Exhaustive: exhaustive,
		Conflict:   len(out) > 1,
		Truncated:  truncated,
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
