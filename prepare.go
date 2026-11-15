package dataeng

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

type block struct {
	key          string
	entityIDs    []string
	groupIDs     []string
	recordIdx    []int
	earliest     time.Time
	latest       time.Time
	classWeights []float64
	weight       float64
}

type prepared struct {
	records []Record
	blocks  []block
	classes []string

	totalWeight float64
	target      Target
	targetCells [3][]float64
	targetSplit [3]float64

	metric           Metric
	epsilon          float64
	allowEmptySplits bool
	hasTime          bool
}

func prepare(records []Record, cfg Config) (*prepared, error) {
	if len(records) == 0 {
		return nil, fmt.Errorf("%w: no records", ErrInvalidInput)
	}

	metric := cfg.Metric
	if metric == "" {
		metric = L1
	}
	switch metric {
	case L1, L2, Linf:
	default:
		return nil, fmt.Errorf("%w: unknown metric %q", ErrInvalidInput, metric)
	}

	eps := cfg.Epsilon
	if eps <= 0 {
		eps = 1e-12
	}

	rows := make([]Record, len(records))
	copy(rows, records)
	ids := make(map[string]struct{}, len(rows))
	hasTime := false
	for i := range rows {
		if rows[i].ID == "" {
			base := fmt.Sprintf("record-%06d", i)
			id := base
			for n := 1; ; n++ {
				if _, exists := ids[id]; !exists {
					break
				}
				id = fmt.Sprintf("%s-%d", base, n)
			}
			rows[i].ID = id
		}
		if _, exists := ids[rows[i].ID]; exists {
			return nil, fmt.Errorf("%w: duplicate record ID %q", ErrInvalidInput, rows[i].ID)
		}
		ids[rows[i].ID] = struct{}{}

		if rows[i].Weight == 0 {
			rows[i].Weight = 1
		}
		if rows[i].Weight < 0 || math.IsNaN(rows[i].Weight) || math.IsInf(rows[i].Weight, 0) {
			return nil, fmt.Errorf("%w: record %q has invalid weight %v", ErrInvalidInput, rows[i].ID, rows[i].Weight)
		}
		if !rows[i].Time.IsZero() {
			hasTime = true
		}
	}

	blocks, err := buildBlocks(rows)
	if err != nil {
		return nil, err
	}

	classes, target, err := resolveClassesAndTarget(rows, cfg)
	if err != nil {
		return nil, err
	}
	classIndex := make(map[string]int, len(classes))
	for i, class := range classes {
		classIndex[class] = i
	}

	var totalWeight float64
	for i := range blocks {
		blocks[i].classWeights = make([]float64, len(classes))
		for _, idx := range blocks[i].recordIdx {
			totalWeight += rows[idx].Weight
			blocks[i].weight += rows[idx].Weight
			blocks[i].classWeights[classIndex[rows[idx].Class]] += rows[idx].Weight
		}
	}
	if totalWeight <= 0 {
		return nil, fmt.Errorf("%w: total record weight must be positive", ErrInvalidInput)
	}

	var targetCells [3][]float64
	var targetSplit [3]float64
	for s, name := range SplitOrder {
		targetCells[s] = make([]float64, len(classes))
		for k, class := range classes {
			targetCells[s][k] = target[name][class]
			targetSplit[s] += targetCells[s][k]
		}
	}

	return &prepared{
		records:          rows,
		blocks:           blocks,
		classes:          classes,
		totalWeight:      totalWeight,
		target:           target,
		targetCells:      targetCells,
		targetSplit:      targetSplit,
		metric:           metric,
		epsilon:          eps,
		allowEmptySplits: cfg.AllowEmptySplits,
		hasTime:          hasTime,
	}, nil
}

func buildBlocks(records []Record) ([]block, error) {
	nodeIDs := make(map[string]int)
	var kinds []uint8 // 0 entity, 1 group, 2 record
	var raws []string

	addNode := func(kind uint8, raw string) int {
		key := string(rune('0'+kind)) + "\x00" + raw
		if id, ok := nodeIDs[key]; ok {
			return id
		}
		id := len(raws)
		nodeIDs[key] = id
		kinds = append(kinds, kind)
		raws = append(raws, raw)
		return id
	}

	dsu := newDSU(1)
	recordNodes := make([][]int, len(records))
	for i, record := range records {
		groups := recordGroups(record)
		nodes := make([]int, 0, 1+len(groups))
		if record.Entity != "" {
			nodes = append(nodes, addNode(0, record.Entity))
		}
		for _, group := range groups {
			nodes = append(nodes, addNode(1, group))
		}
		if len(nodes) == 0 {
			nodes = append(nodes, addNode(2, record.ID))
		}
		for j := 1; j < len(nodes); j++ {
			dsu.union(nodes[0], nodes[j])
		}
		recordNodes[i] = nodes
	}

	type component struct {
		entities map[string]struct{}
		groups   map[string]struct{}
		records  []int
	}
	components := make(map[int]*component)
	for i, nodes := range recordNodes {
		root := dsu.find(nodes[0])
		c := components[root]
		if c == nil {
			c = &component{
				entities: make(map[string]struct{}),
				groups:   make(map[string]struct{}),
			}
			components[root] = c
		}
		c.records = append(c.records, i)
		for _, node := range nodes {
			switch kinds[node] {
			case 0:
				c.entities[raws[node]] = struct{}{}
			case 1:
				c.groups[raws[node]] = struct{}{}
			}
		}
	}

	blocks := make([]block, 0, len(components))
	for _, c := range components {
		b := block{
			entityIDs: sortedKeys(c.entities),
			groupIDs:  sortedKeys(c.groups),
			recordIdx: append([]int(nil), c.records...),
		}
		sort.Slice(b.recordIdx, func(i, j int) bool {
			return records[b.recordIdx[i]].ID < records[b.recordIdx[j]].ID
		})
		switch {
		case len(b.groupIDs) > 0:
			b.key = b.groupIDs[0]
		case len(b.entityIDs) > 0:
			b.key = b.entityIDs[0]
		default:
			ids := make([]string, len(b.recordIdx))
			for i, idx := range b.recordIdx {
				ids[i] = records[idx].ID
			}
			b.key = ids[0]
		}
		b.earliest = records[b.recordIdx[0]].Time
		b.latest = b.earliest
		for _, idx := range b.recordIdx[1:] {
			t := records[idx].Time
			if t.Before(b.earliest) {
				b.earliest = t
			}
			if t.After(b.latest) {
				b.latest = t
			}
		}
		blocks = append(blocks, b)
	}

	sort.Slice(blocks, func(i, j int) bool {
		if blocks[i].key != blocks[j].key {
			return blocks[i].key < blocks[j].key
		}
		return firstRecordID(records, blocks[i]) < firstRecordID(records, blocks[j])
	})
	return blocks, nil
}

func firstRecordID(records []Record, b block) string {
	return records[b.recordIdx[0]].ID
}

func recordGroups(record Record) []string {
	if record.Group == "" && len(record.Groups) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(record.Groups)+1)
	groups := make([]string, 0, len(record.Groups)+1)
	if record.Group != "" {
		seen[record.Group] = struct{}{}
		groups = append(groups, record.Group)
	}
	for _, group := range record.Groups {
		if group == "" {
			continue
		}
		if _, exists := seen[group]; exists {
			continue
		}
		seen[group] = struct{}{}
		groups = append(groups, group)
	}
	return groups
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func resolveClassesAndTarget(records []Record, cfg Config) ([]string, Target, error) {
	classSet := make(map[string]struct{}, len(records))
	for _, record := range records {
		classSet[record.Class] = struct{}{}
	}
	for split, cells := range cfg.Target {
		if _, err := canonicalSplit(split); err != nil {
			return nil, nil, err
		}
		for class := range cells {
			classSet[class] = struct{}{}
		}
	}
	if len(cfg.Target) == 0 {
		for class := range cfg.ClassShares {
			classSet[class] = struct{}{}
		}
	}
	classes := make([]string, 0, len(classSet))
	for class := range classSet {
		classes = append(classes, class)
	}
	sort.Strings(classes)

	if len(cfg.Target) > 0 {
		mode := cfg.TargetMode
		if mode == "" {
			mode = TargetMass
		}
		if mode != TargetMass && mode != TargetConditional {
			return nil, nil, fmt.Errorf("%w: unknown target mode %q", ErrInvalidInput, mode)
		}
		canonicalized := make(map[SplitName]map[string]float64, len(SplitOrder))
		for _, split := range SplitOrder {
			canonicalized[split] = make(map[string]float64)
		}
		for split, cells := range cfg.Target {
			name, err := canonicalSplit(split)
			if err != nil {
				return nil, nil, err
			}
			for class, value := range cells {
				if value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
					return nil, nil, fmt.Errorf("%w: invalid target for %s/%q: %v", ErrInvalidInput, name, class, value)
				}
				canonicalized[name][class] += value
			}
		}
		if mode == TargetConditional {
			splitShares, err := normalizedSplitShares(cfg.SplitShares)
			if err != nil {
				return nil, nil, err
			}
			var rowSums [3]float64
			for s, split := range SplitOrder {
				for _, class := range classes {
					rowSums[s] += canonicalized[split][class]
				}
				if rowSums[s] == 0 && splitShares[split] > 0 {
					return nil, nil, fmt.Errorf("%w: conditional target for %s is empty", ErrInvalidInput, split)
				}
			}
			target := make(Target, len(SplitOrder))
			for s, split := range SplitOrder {
				target[split] = make(map[string]float64, len(classes))
				for _, class := range classes {
					if rowSums[s] > 0 {
						target[split][class] = splitShares[split] * canonicalized[split][class] / rowSums[s]
					} else {
						target[split][class] = 0
					}
				}
			}
			return classes, target, nil
		}
		var sum float64
		for _, split := range SplitOrder {
			for _, class := range classes {
				sum += canonicalized[split][class]
			}
		}
		if sum <= 0 {
			return nil, nil, fmt.Errorf("%w: target has no positive mass", ErrInvalidInput)
		}
		target := make(Target, len(SplitOrder))
		for _, split := range SplitOrder {
			target[split] = make(map[string]float64, len(classes))
			for _, class := range classes {
				target[split][class] = canonicalized[split][class] / sum
			}
		}
		return classes, target, nil
	}

	splitShares, err := normalizedSplitShares(cfg.SplitShares)
	if err != nil {
		return nil, nil, err
	}
	classShares, err := normalizedClassShares(cfg.ClassShares, records, classes)
	if err != nil {
		return nil, nil, err
	}

	target := make(Target, len(SplitOrder))
	for _, split := range SplitOrder {
		target[split] = make(map[string]float64, len(classes))
		for _, class := range classes {
			target[split][class] = splitShares[split] * classShares[class]
		}
	}
	return classes, target, nil
}

func canonicalSplit(split SplitName) (SplitName, error) {
	switch strings.ToLower(strings.TrimSpace(string(split))) {
	case "train", "training":
		return Train, nil
	case "validation", "valid", "val", "dev", "development":
		return Validation, nil
	case "test", "testing", "holdout":
		return Test, nil
	default:
		return "", fmt.Errorf("%w: unknown split %q", ErrInvalidInput, split)
	}
}

func normalizedSplitShares(shares map[SplitName]float64) (map[SplitName]float64, error) {
	if len(shares) == 0 {
		return map[SplitName]float64{Train: 0.8, Validation: 0.1, Test: 0.1}, nil
	}
	out := make(map[SplitName]float64, len(SplitOrder))
	for _, split := range SplitOrder {
		out[split] = 0
	}
	for split, value := range shares {
		name, err := canonicalSplit(split)
		if err != nil {
			return nil, err
		}
		if value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, fmt.Errorf("%w: invalid split share for %s: %v", ErrInvalidInput, name, value)
		}
		out[name] += value
	}
	var sum float64
	for _, split := range SplitOrder {
		sum += out[split]
	}
	if sum <= 0 {
		return nil, fmt.Errorf("%w: split shares have no positive mass", ErrInvalidInput)
	}
	for name, value := range out {
		out[name] = value / sum
	}
	return out, nil
}

func normalizedClassShares(shares map[string]float64, records []Record, classes []string) (map[string]float64, error) {
	if len(shares) == 0 {
		weights := make(map[string]float64, len(classes))
		indices := make([]int, len(records))
		for i := range indices {
			indices[i] = i
		}
		sort.Slice(indices, func(i, j int) bool {
			return records[indices[i]].ID < records[indices[j]].ID
		})
		for _, idx := range indices {
			weights[records[idx].Class] += records[idx].Weight
		}
		var sum float64
		for _, class := range classes {
			sum += weights[class]
		}
		if sum <= 0 {
			return nil, fmt.Errorf("%w: no class weight", ErrInvalidInput)
		}
		for _, class := range classes {
			weights[class] /= sum
		}
		return weights, nil
	}

	out := make(map[string]float64, len(classes))
	var sum float64
	for _, class := range classes {
		value := shares[class]
		if value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, fmt.Errorf("%w: invalid class share for %q: %v", ErrInvalidInput, class, value)
		}
		out[class] = value
		sum += value
	}
	if sum <= 0 {
		return nil, fmt.Errorf("%w: class shares have no positive mass", ErrInvalidInput)
	}
	for class, value := range out {
		out[class] = value / sum
	}
	return out, nil
}

type dsu struct {
	parent []int
	rank   []uint8
}

func newDSU(n int) *dsu {
	if n < 1 {
		n = 1
	}
	parent := make([]int, n)
	for i := range parent {
		parent[i] = i
	}
	return &dsu{parent: parent, rank: make([]uint8, n)}
}

func (d *dsu) find(x int) int {
	d.grow(x + 1)
	for d.parent[x] != x {
		d.parent[x] = d.parent[d.parent[x]]
		x = d.parent[x]
	}
	return x
}

func (d *dsu) union(a, b int) {
	d.grow(max(a, b) + 1)
	a, b = d.find(a), d.find(b)
	if a == b {
		return
	}
	if d.rank[a] < d.rank[b] {
		a, b = b, a
	}
	d.parent[b] = a
	if d.rank[a] == d.rank[b] {
		d.rank[a]++
	}
}

func (d *dsu) grow(n int) {
	if n <= len(d.parent) {
		return
	}
	old := len(d.parent)
	d.parent = append(d.parent, make([]int, n-old)...)
	d.rank = append(d.rank, make([]uint8, n-old)...)
	for i := old; i < n; i++ {
		d.parent[i] = i
	}
}
