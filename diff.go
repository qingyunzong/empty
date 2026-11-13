package dataeng

import (
	"sort"
	"strconv"
	"strings"
)

const (
	defaultSimilarityThreshold = 0.55
	defaultMaxStructuralRun    = 24
)

type diffConfig struct {
	similarityThreshold float64
	maxStructuralRun    int
}

func defaultDiffConfig() diffConfig {
	return diffConfig{
		similarityThreshold: defaultSimilarityThreshold,
		maxStructuralRun:    defaultMaxStructuralRun,
	}
}

type preparedSide struct {
	blocks []Block
	paths  []string
	ids    []string
}

func prepareSide(snapshot Snapshot) preparedSide {
	blocks := dedupeContentBlocks(snapshot.ContentBlocks())
	paths := normalizedContentPaths(blocks)
	return preparedSide{
		blocks: blocks,
		paths:  paths,
		ids:    blockIDs(blocks, paths),
	}
}

func blockIDs(blocks []Block, paths []string) []string {
	ids := make([]string, len(blocks))
	counts := make(map[string]int, len(blocks))
	for i, block := range blocks {
		var base string
		switch {
		case strings.TrimSpace(block.ID) != "":
			base = strings.TrimSpace(block.ID)
		case paths[i] != "":
			base = "path:" + paths[i]
		case collapseWhitespace(block.Text) != "":
			base = "text:" + shortHash(collapseWhitespace(block.Text))
		default:
			base = "block:" + strconv.Itoa(i)
		}
		counts[base]++
		if counts[base] > 1 {
			ids[i] = base + "#" + strconv.Itoa(counts[base])
		} else {
			ids[i] = base
		}
	}
	return ids
}

func dedupeContentBlocks(blocks []Block) []Block {
	out := make([]Block, 0, len(blocks))
	indexByKey := make(map[string]int, len(blocks))
	for _, block := range blocks {
		key := blockDedupeKey(block)
		if index, ok := indexByKey[key]; ok {
			out[index] = preferBlock(out[index], block)
			continue
		}
		indexByKey[key] = len(out)
		out = append(out, block)
	}
	return out
}

func blockDedupeKey(block Block) string {
	if id := strings.TrimSpace(block.ID); id != "" {
		return "id\x00" + id
	}
	if path := strings.TrimSpace(block.Path); path != "" {
		return "path\x00" + path
	}
	if text := collapseWhitespace(block.Text); text != "" {
		return "text\x00" + text
	}
	return "empty"
}

// preferBlock chooses one observation when a single crawl generation contains
// several copies of the same logical block. The newest publication evidence
// wins; ties keep the later crawl observation.
func preferBlock(current, candidate Block) Block {
	currentTime := current.EffectivePublishTime()
	candidateTime := candidate.EffectivePublishTime()
	if currentTime.After(candidateTime) {
		return current
	}
	return candidate
}

// Diff compares two crawls and returns structured body events. Blocks marked
// as advertisements, navigation or boilerplate are ignored completely, so
// their insertion, removal or movement cannot create body changes. Paragraph
// splits and merges produce split/merge events with source mappings instead of
// delete/add pairs. Body edits and order changes are separate events.
//
// Diff is stateless and de-duplicates events within its result. Use a Ledger
// when multiple comparisons from the same crawl generation must emit each
// add/delete/modify event only once.
func Diff(oldSnapshot, newSnapshot Snapshot) Result {
	return diffWithConfig(oldSnapshot, newSnapshot, defaultDiffConfig())
}

// Compare is an alias for Diff.
func Compare(oldSnapshot, newSnapshot Snapshot) Result {
	return Diff(oldSnapshot, newSnapshot)
}

// DiffSnapshots is an alias for Diff.
func DiffSnapshots(oldSnapshot, newSnapshot Snapshot) Result {
	return Diff(oldSnapshot, newSnapshot)
}

// DiffBlocks compares two ordered block lists with no snapshot metadata.
func DiffBlocks(oldBlocks, newBlocks []Block) Result {
	return Diff(Snapshot{Blocks: oldBlocks}, Snapshot{Blocks: newBlocks})
}

type Option func(*diffConfig)

// WithSimilarityThreshold controls how similar two unmatched paragraphs must
// be before they are paired as a modification instead of delete+add. Values
// outside (0,1] leave the default unchanged.
func WithSimilarityThreshold(threshold float64) Option {
	return func(c *diffConfig) {
		if threshold > 0 && threshold <= 1 {
			c.similarityThreshold = threshold
		}
	}
}

// WithMaxStructuralRun bounds how many adjacent paragraphs may be considered
// for a single split or merge. It prevents quadratic work on pathological
// pages while still handling ordinary paragraph restructuring.
func WithMaxStructuralRun(n int) Option {
	return func(c *diffConfig) {
		if n >= 2 {
			c.maxStructuralRun = n
		}
	}
}

type match struct {
	oldIndex int
	newIndex int
}

type structuralRun struct {
	indexes []int
	start   int
	end     int
}

func diffWithConfig(oldSnapshot, newSnapshot Snapshot, cfg diffConfig) Result {
	oldSide := prepareSide(oldSnapshot)
	newSide := prepareSide(newSnapshot)

	generation := newSnapshot.Generation
	if generation == "" {
		generation = oldSnapshot.Generation
	}

	builder := &diffBuilder{
		cfg:        cfg,
		generation: generation,
		old:        oldSide,
		new:        newSide,
		oldMatched: make([]bool, len(oldSide.blocks)),
		newMatched: make([]bool, len(newSide.blocks)),
	}
	builder.match()
	result := Result{Generation: generation, Events: builder.events}
	result.Events = dedupeEvents(result.Events)
	sortEvents(result.Events)
	return result
}

type diffBuilder struct {
	cfg        diffConfig
	generation string
	old        preparedSide
	new        preparedSide

	oldMatched []bool
	newMatched []bool
	pairs      []match
	events     []Event
}

func (b *diffBuilder) match() {
	b.matchByID()
	b.matchByPathAndText()
	b.matchByExactText()
	b.detectStructuralChanges()
	b.matchFuzzyWithThreshold(0.80)
	b.matchByPath()
	b.matchFuzzy()
	b.emitModifications()
	b.emitAddsAndDeletes()
	b.emitReorder()
}

func (b *diffBuilder) markPair(oldIndex, newIndex int) {
	if oldIndex < 0 || oldIndex >= len(b.oldMatched) ||
		newIndex < 0 || newIndex >= len(b.newMatched) {
		return
	}
	if b.oldMatched[oldIndex] || b.newMatched[newIndex] {
		return
	}
	b.oldMatched[oldIndex] = true
	b.newMatched[newIndex] = true
	b.pairs = append(b.pairs, match{oldIndex: oldIndex, newIndex: newIndex})
}

func (b *diffBuilder) matchByID() {
	byID := make(map[string][]int)
	for i, block := range b.old.blocks {
		if id := strings.TrimSpace(block.ID); id != "" {
			byID[id] = append(byID[id], i)
		}
	}
	for j, block := range b.new.blocks {
		id := strings.TrimSpace(block.ID)
		if id == "" {
			continue
		}
		candidates := byID[id]
		best := -1
		bestScore := -1.0
		for _, i := range candidates {
			if b.oldMatched[i] {
				continue
			}
			score := textSimilarity(
				collapseWhitespace(b.old.blocks[i].Text),
				collapseWhitespace(block.Text),
			)
			if b.old.paths[i] == b.new.paths[j] {
				score += 1
			}
			if score > bestScore {
				best, bestScore = i, score
			}
		}
		if best >= 0 {
			b.markPair(best, j)
		}
	}
}

func (b *diffBuilder) matchByPathAndText() {
	index := make(map[string][]int)
	for i, block := range b.old.blocks {
		key := pathAndTextKey(b.old.paths[i], block.Text)
		index[key] = append(index[key], i)
	}
	for j, block := range b.new.blocks {
		if b.newMatched[j] {
			continue
		}
		key := pathAndTextKey(b.new.paths[j], block.Text)
		for _, i := range index[key] {
			if !b.oldMatched[i] {
				b.markPair(i, j)
				break
			}
		}
	}
}

func pathAndTextKey(path, text string) string {
	return path + "\x00" + collapseWhitespace(text)
}

func (b *diffBuilder) matchByExactText() {
	byText := make(map[string][]int)
	for i, block := range b.old.blocks {
		text := collapseWhitespace(block.Text)
		if text == "" {
			continue
		}
		byText[text] = append(byText[text], i)
	}
	for j, block := range b.new.blocks {
		if b.newMatched[j] {
			continue
		}
		text := collapseWhitespace(block.Text)
		if text == "" {
			continue
		}
		candidates := byText[text]
		best := -1
		bestDistance := int(^uint(0) >> 1)
		for _, i := range candidates {
			if b.oldMatched[i] {
				continue
			}
			distance := absInt(i - j)
			if distance < bestDistance {
				best, bestDistance = i, distance
			}
		}
		if best >= 0 {
			b.markPair(best, j)
		}
	}
}

func (b *diffBuilder) detectStructuralChanges() {
	oldRuns := b.unmatchedRuns(b.oldMatched)
	newRuns := b.unmatchedRuns(b.newMatched)
	if len(oldRuns) == 0 || len(newRuns) == 0 {
		return
	}

	type candidate struct {
		oldRun structuralRun
		newRun structuralRun
		score  float64
	}
	candidates := make([]candidate, 0)
	for _, oldRun := range oldRuns {
		if len(oldRun.indexes) > b.cfg.maxStructuralRun {
			continue
		}
		oldCompact := b.runCompact(b.old.blocks, oldRun.indexes)
		if oldCompact == "" {
			continue
		}
		for _, newRun := range newRuns {
			if len(newRun.indexes) > b.cfg.maxStructuralRun {
				continue
			}
			if len(oldRun.indexes) == 1 && len(newRun.indexes) == 1 {
				continue
			}
			newCompact := b.runCompact(b.new.blocks, newRun.indexes)
			if newCompact == "" || oldCompact != newCompact {
				continue
			}
			distance := absInt(oldRun.start-newRun.start) +
				absInt(oldRun.end-newRun.end)
			// Prefer a run at the same place, then the one with the most
			// similar paragraph counts.
			score := float64(distance) +
				0.01*float64(absInt(len(oldRun.indexes)-len(newRun.indexes)))
			candidates = append(candidates, candidate{
				oldRun: oldRun,
				newRun: newRun,
				score:  score,
			})
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].oldRun.start != candidates[j].oldRun.start {
			return candidates[i].oldRun.start < candidates[j].oldRun.start
		}
		return candidates[i].score < candidates[j].score
	})

	oldUsed := make([]bool, len(b.old.blocks))
	newUsed := make([]bool, len(b.new.blocks))
	for _, c := range candidates {
		usable := true
		for _, i := range c.oldRun.indexes {
			if oldUsed[i] || b.oldMatched[i] {
				usable = false
				break
			}
		}
		if !usable {
			continue
		}
		for _, j := range c.newRun.indexes {
			if newUsed[j] || b.newMatched[j] {
				usable = false
				break
			}
		}
		if !usable {
			continue
		}

		for _, i := range c.oldRun.indexes {
			oldUsed[i] = true
			b.oldMatched[i] = true
		}
		for _, j := range c.newRun.indexes {
			newUsed[j] = true
			b.newMatched[j] = true
		}
		switch {
		case len(c.oldRun.indexes) == 1:
			b.emitSplit(c.oldRun.indexes[0], c.newRun.indexes)
		case len(c.newRun.indexes) == 1:
			b.emitMerge(c.oldRun.indexes, c.newRun.indexes[0])
		default:
			b.emitRestructure(c.oldRun.indexes, c.newRun.indexes)
		}
	}
}

func (b *diffBuilder) unmatchedRuns(matched []bool) []structuralRun {
	runs := make([]structuralRun, 0)
	for i := 0; i < len(matched); {
		if matched[i] {
			i++
			continue
		}
		start := i
		for i < len(matched) && !matched[i] {
			i++
		}
		indexes := make([]int, 0, i-start)
		for k := start; k < i; k++ {
			indexes = append(indexes, k)
		}
		runs = append(runs, structuralRun{indexes: indexes, start: start, end: i})
	}
	return runs
}

func (b *diffBuilder) runCompact(blocks []Block, indexes []int) string {
	var builder strings.Builder
	for _, i := range indexes {
		builder.WriteString(squashText(blocks[i].Text))
	}
	return builder.String()
}

func (b *diffBuilder) emitSplit(oldIndex int, newIndexes []int) {
	oldBlock := b.old.blocks[oldIndex]
	oldID := b.old.ids[oldIndex]
	targets := make([]Block, 0, len(newIndexes))
	targetIDs := make([]string, 0, len(newIndexes))
	for _, j := range newIndexes {
		targets = append(targets, b.new.blocks[j])
		targetIDs = append(targetIDs, b.new.ids[j])
	}

	compact, origins := compactText(oldBlock.Text)
	cursor := 0
	mapping := make([]Provenance, 0, len(targets))
	for k, target := range targets {
		targetCompact := squashText(target.Text)
		end := cursor + runeLen(targetCompact)
		if end > len(compact) {
			end = len(compact)
		}
		fragment := sourceFragment(oldBlock, oldID, origins, cursor, end)
		mapping = append(mapping, Provenance{
			BlockID: targetIDs[k],
			Sources: []SourceFragment{fragment},
		})
		cursor = end
	}

	event := Event{
		ID:             newEventID(b.generation, EventSplit, oldID+"=>"+joinIDs(targetIDs)),
		Kind:           EventSplit,
		Generation:     b.generation,
		BlockID:        oldID,
		OldID:          oldID,
		Old:            blockCopy(oldBlock),
		Sources:        []string{oldID},
		Targets:        targetIDs,
		Mapping:        mapping,
		ContentChanged: true,
	}
	b.events = append(b.events, event)
}

func (b *diffBuilder) emitMerge(oldIndexes []int, newIndex int) {
	newBlock := b.new.blocks[newIndex]
	newID := b.new.ids[newIndex]
	sourceIDs := make([]string, 0, len(oldIndexes))
	mappingSources := make([]SourceFragment, 0, len(oldIndexes))
	for _, i := range oldIndexes {
		source := b.old.blocks[i]
		sourceID := b.old.ids[i]
		sourceIDs = append(sourceIDs, sourceID)
		fragment := SourceFragment{
			BlockID: sourceID,
			Start:   0,
			End:     runeLen(source.Text),
		}
		if source.Range.Valid() {
			fragment.Document = source.Range
		}
		mappingSources = append(mappingSources, fragment)
	}
	event := Event{
		ID:         newEventID(b.generation, EventMerge, joinIDs(sourceIDs)+"=>"+newID),
		Kind:       EventMerge,
		Generation: b.generation,
		BlockID:    newID,
		NewID:      newID,
		New:        blockCopy(newBlock),
		Sources:    sourceIDs,
		Targets:    []string{newID},
		Mapping: []Provenance{{
			BlockID: newID,
			Sources: mappingSources,
		}},
		ContentChanged: true,
	}
	b.events = append(b.events, event)
}

// emitRestructure handles a many-to-many run whose compact text is unchanged.
// It is still represented as a split-like restructuring event so callers never
// see a delete/add pair for a pure paragraph boundary change.
func (b *diffBuilder) emitRestructure(oldIndexes, newIndexes []int) {
	sourceIDs := make([]string, 0, len(oldIndexes))
	targetIDs := make([]string, 0, len(newIndexes))
	for _, i := range oldIndexes {
		sourceIDs = append(sourceIDs, b.old.ids[i])
	}
	for _, j := range newIndexes {
		targetIDs = append(targetIDs, b.new.ids[j])
	}

	compactChars := make([]compactChar, 0)
	var compactBuilder strings.Builder
	for _, i := range oldIndexes {
		compact, origins := compactText(b.old.blocks[i].Text)
		compactBuilder.WriteString(compact)
		for _, origin := range origins {
			compactChars = append(compactChars, compactChar{blockIndex: i, localOffset: origin})
		}
	}
	compactLen := runeLen(compactBuilder.String())
	cursor := 0
	mapping := make([]Provenance, 0, len(newIndexes))
	for _, j := range newIndexes {
		end := cursor + runeLen(squashText(b.new.blocks[j].Text))
		if end > compactLen {
			end = compactLen
		}
		fragments := fragmentsForCompactChars(compactChars, cursor, end,
			b.old.blocks, b.old.ids)
		mapping = append(mapping, Provenance{BlockID: b.new.ids[j], Sources: fragments})
		cursor = end
	}

	event := Event{
		ID:             newEventID(b.generation, EventSplit, joinIDs(sourceIDs)+"=>"+joinIDs(targetIDs)),
		Kind:           EventSplit,
		Generation:     b.generation,
		BlockID:        strings.Join(sourceIDs, ","),
		OldID:          strings.Join(sourceIDs, ","),
		Sources:        sourceIDs,
		Targets:        targetIDs,
		Mapping:        mapping,
		ContentChanged: true,
	}
	b.events = append(b.events, event)
}

type compactChar struct {
	blockIndex  int
	localOffset int
}

func fragmentsForCompactChars(chars []compactChar, start, end int, blocks []Block, ids []string) []SourceFragment {
	if start < 0 {
		start = 0
	}
	if end > len(chars) {
		end = len(chars)
	}
	if start >= end {
		return nil
	}
	fragments := make([]SourceFragment, 0, 1)
	currentBlock := chars[start].blockIndex
	first := chars[start].localOffset
	last := first
	for i := start + 1; i < end; i++ {
		if chars[i].blockIndex != currentBlock {
			fragments = append(fragments, fragmentFromOffsets(
				blocks[currentBlock], ids[currentBlock], first, last+1))
			currentBlock = chars[i].blockIndex
			first = chars[i].localOffset
		}
		last = chars[i].localOffset
	}
	fragments = append(fragments, fragmentFromOffsets(
		blocks[currentBlock], ids[currentBlock], first, last+1))
	return fragments
}

func fragmentFromOffsets(block Block, blockID string, start, end int) SourceFragment {
	fragment := SourceFragment{BlockID: blockID, Start: start, End: end}
	if block.Range.Valid() {
		fragment.Document = TextSpan{
			Start: block.Range.Start + start,
			End:   block.Range.Start + end,
		}
	}
	return fragment
}

func (b *diffBuilder) matchByPath() {
	byPath := make(map[string][]int)
	for i := range b.old.blocks {
		if b.oldMatched[i] || b.old.paths[i] == "" {
			continue
		}
		byPath[b.old.paths[i]] = append(byPath[b.old.paths[i]], i)
	}
	for j := range b.new.blocks {
		if b.newMatched[j] || b.new.paths[j] == "" {
			continue
		}
		candidates := byPath[b.new.paths[j]]
		best := -1
		bestScore := -1.0
		for _, i := range candidates {
			if b.oldMatched[i] {
				continue
			}
			if b.hasConflictingIDs(i, j) {
				continue
			}
			score := textSimilarity(
				collapseWhitespace(b.old.blocks[i].Text),
				collapseWhitespace(b.new.blocks[j].Text),
			)
			score += pathProximityBonus(b.old.blocks[i].Path, b.new.blocks[j].Path)
			if score > bestScore {
				best, bestScore = i, score
			}
		}
		if best >= 0 {
			b.markPair(best, j)
		}
	}
}

func (b *diffBuilder) matchFuzzy() {
	b.matchFuzzyWithThreshold(b.cfg.similarityThreshold)
}

func (b *diffBuilder) matchFuzzyWithThreshold(threshold float64) {
	type candidate struct {
		oldIndex int
		newIndex int
		score    float64
	}
	candidates := make([]candidate, 0)
	for i, oldBlock := range b.old.blocks {
		if b.oldMatched[i] {
			continue
		}
		oldText := collapseWhitespace(oldBlock.Text)
		for j, newBlock := range b.new.blocks {
			if b.newMatched[j] {
				continue
			}
			if b.hasConflictingIDs(i, j) {
				continue
			}
			newText := collapseWhitespace(newBlock.Text)
			if oldText == "" || newText == "" {
				continue
			}
			score := textSimilarity(oldText, newText)
			if b.old.paths[i] != "" && b.old.paths[i] == b.new.paths[j] && score < 1 {
				score += 0.02
			}
			if score >= threshold {
				candidates = append(candidates, candidate{
					oldIndex: i,
					newIndex: j,
					score:    score,
				})
			}
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		di := absInt(candidates[i].oldIndex - candidates[i].newIndex)
		dj := absInt(candidates[j].oldIndex - candidates[j].newIndex)
		if di != dj {
			return di < dj
		}
		return candidates[i].oldIndex < candidates[j].oldIndex
	})
	for _, candidate := range candidates {
		if b.oldMatched[candidate.oldIndex] || b.newMatched[candidate.newIndex] {
			continue
		}
		b.markPair(candidate.oldIndex, candidate.newIndex)
	}
}

// hasConflictingIDs reports whether both sides carry explicit, stable block
// IDs and those IDs disagree. In that case the blocks are different logical
// nodes; a low-similarity text replacement must be delete+add, not modify.
func (b *diffBuilder) hasConflictingIDs(oldIndex, newIndex int) bool {
	oldID := strings.TrimSpace(b.old.blocks[oldIndex].ID)
	newID := strings.TrimSpace(b.new.blocks[newIndex].ID)
	return oldID != "" && newID != "" && oldID != newID
}

func (b *diffBuilder) emitModifications() {
	for _, pair := range b.pairs {
		oldBlock := b.old.blocks[pair.oldIndex]
		newBlock := b.new.blocks[pair.newIndex]
		if collapseWhitespace(oldBlock.Text) == collapseWhitespace(newBlock.Text) {
			continue
		}
		blockID := b.old.ids[pair.oldIndex]
		oldID := blockID
		newID := b.new.ids[pair.newIndex]
		b.events = append(b.events, Event{
			ID:             newEventID(b.generation, EventModify, blockID),
			Kind:           EventModify,
			Generation:     b.generation,
			BlockID:        blockID,
			OldID:          oldID,
			NewID:          newID,
			Old:            blockCopy(oldBlock),
			New:            blockCopy(newBlock),
			ContentChanged: true,
		})
	}
}

func (b *diffBuilder) emitAddsAndDeletes() {
	for i, block := range b.old.blocks {
		if b.oldMatched[i] {
			continue
		}
		id := b.old.ids[i]
		b.events = append(b.events, Event{
			ID:             newEventID(b.generation, EventDelete, id),
			Kind:           EventDelete,
			Generation:     b.generation,
			BlockID:        id,
			OldID:          id,
			Old:            blockCopy(block),
			ContentChanged: true,
		})
	}
	for j, block := range b.new.blocks {
		if b.newMatched[j] {
			continue
		}
		id := b.new.ids[j]
		b.events = append(b.events, Event{
			ID:             newEventID(b.generation, EventAdd, id),
			Kind:           EventAdd,
			Generation:     b.generation,
			BlockID:        id,
			NewID:          id,
			New:            blockCopy(block),
			ContentChanged: true,
		})
	}
}

func (b *diffBuilder) emitReorder() {
	if len(b.pairs) < 2 {
		return
	}
	byOld := append([]match(nil), b.pairs...)
	sort.SliceStable(byOld, func(i, j int) bool { return byOld[i].oldIndex < byOld[j].oldIndex })
	byNew := append([]match(nil), b.pairs...)
	sort.SliceStable(byNew, func(i, j int) bool { return byNew[i].newIndex < byNew[j].newIndex })

	ids := make(map[string]string, len(b.pairs))
	for _, pair := range b.pairs {
		ids[pairKey(pair)] = b.old.ids[pair.oldIndex]
	}
	beforeOrder := make([]string, 0, len(byOld))
	oldRank := make(map[string]int, len(byOld))
	for rank, pair := range byOld {
		id := ids[pairKey(pair)]
		beforeOrder = append(beforeOrder, id)
		oldRank[id] = rank
	}
	afterOrder := make([]string, 0, len(byNew))
	orderChanges := make([]OrderChange, 0)
	for rank, pair := range byNew {
		id := ids[pairKey(pair)]
		afterOrder = append(afterOrder, id)
		if previous, ok := oldRank[id]; ok && previous != rank {
			orderChanges = append(orderChanges, OrderChange{
				BlockID:  id,
				OldIndex: previous,
				NewIndex: rank,
			})
		}
	}
	if len(orderChanges) == 0 {
		return
	}
	moved := make([]string, 0, len(orderChanges))
	for _, change := range orderChanges {
		moved = append(moved, change.BlockID)
	}
	b.events = append(b.events, Event{
		ID:           newEventID(b.generation, EventReorder, joinIDs(moved)+"|"+strings.Join(afterOrder, ",")),
		Kind:         EventReorder,
		Generation:   b.generation,
		BlockID:      moved[0],
		BeforeOrder:  beforeOrder,
		AfterOrder:   afterOrder,
		OrderChanges: orderChanges,
		OrderChanged: true,
	})
}

func pairKey(pair match) string {
	return strconv.Itoa(pair.oldIndex) + ":" + strconv.Itoa(pair.newIndex)
}

func pathProximityBonus(oldPath, newPath string) float64 {
	if oldPath == "" || newPath == "" {
		return 0
	}
	if samePathParent(oldPath, newPath) {
		return 0.1
	}
	return 0
}

func samePathParent(a, b string) bool {
	as := parseDOMPath(a)
	bs := parseDOMPath(b)
	if len(as) == 0 || len(bs) == 0 {
		return false
	}
	return pathKey(as[:len(as)-1]) == pathKey(bs[:len(bs)-1])
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func blockCopy(block Block) *Block {
	cp := block
	if block.PublishEvidence != nil {
		cp.PublishEvidence = append([]PublishEvidence(nil), block.PublishEvidence...)
	}
	return &cp
}
