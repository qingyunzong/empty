package formal

import (
	"fmt"
	"sort"
)

// Range is a half-open key interval [Start, End). The final range of a plan is
// unbounded.
type Range struct {
	Start     string
	End       string
	Unbounded bool
}

// Contains reports whether key is in the range.
func (r Range) Contains(key string) bool {
	if key < r.Start {
		return false
	}
	return r.Unbounded || key < r.End
}

// Partition is one physical partition. RangeLoad is the load of ordinary keys
// in its range; SplitLoad is the load of salted hot-key buckets assigned to
// it. Load is their sum.
type Partition struct {
	ID           int
	Start        string
	End          string
	EndUnbounded bool
	RangeLoad    int64
	SplitLoad    int64
	Load         int64
}

// Range returns the partition interval.
func (p Partition) Range() Range {
	return Range{Start: p.Start, End: p.End, Unbounded: p.EndUnbounded}
}

// Contains reports whether an ordinary key belongs to the partition's range.
// It does not account for hot-key overrides; use Plan.Placement for routing.
func (p Partition) Contains(key string) bool {
	return p.Range().Contains(key)
}

// SaltBucket is one salted sub-partition of a hot key.
type SaltBucket struct {
	Salt      uint32
	Partition int
	Load      int64
}

// KeySplit describes all sub-partitions of a hot key.
type KeySplit struct {
	Key     string
	Load    int64
	Buckets []SaltBucket
}

// KeyLoad is the observed load of one key in the planning snapshot.
type KeyLoad struct {
	Key  string
	Load int64
}

// Route identifies one placement of a key.
type Route struct {
	Key       string
	Partition int
	Salted    bool
	Salt      uint32
}

// RouteLoad is one load share of a key.
type RouteLoad struct {
	Route
	Load int64
}

// Migration describes how much observed load changed partition compared with
// the previous plan.
type Migration struct {
	FromVersion  uint64
	ComparedKeys int
	MovedKeys    int
	MovedLoad    int64
}

// Plan is an immutable routing and load plan. Partitions are ordered by key
// range and cover the complete key space exactly once.
type Plan struct {
	Version         uint64
	PreviousVersion uint64
	Partitions      []Partition
	Splits          []KeySplit
	Keys            []KeyLoad
	TotalLoad       int64
	MaxLoad         int64
	Migration       Migration
}

type keyLoad struct {
	key  string
	load int64
}

type internalShard struct {
	key  string
	salt uint32
	load int64
	hot  int
}

type group struct {
	start int
	end   int
	load  int64
}

type candidate struct {
	partitions []Partition
	splits     []KeySplit
	baseLoads  []int64
	total      int64
	max        int64
	migration  Migration
}

type score struct {
	max       int64
	migration int64
}

func betterScore(a, b score) bool {
	if b.max != a.max {
		return a.max < b.max
	}
	return a.migration < b.migration
}

func buildPlan(counts map[string]int64, cfg Config, revision uint64) (*Plan, error) {
	cfg, err := cfg.normalized()
	if err != nil {
		return nil, err
	}

	keys := sortedKeys(counts)
	var total int64
	for _, key := range keys {
		total += counts[key]
	}

	p := cfg.Partitions
	target := float64(total) / float64(p)
	hotThreshold := cfg.HotKeyFactor * target

	normal := make([]keyLoad, 0, len(keys))
	hotKeys := make([]keyLoad, 0)
	for _, key := range keys {
		load := counts[key]
		if p > 1 && cfg.MaxSaltBuckets > 1 && load >= cfg.MinHotLoad &&
			float64(load) > hotThreshold {
			hotKeys = append(hotKeys, keyLoad{key: key, load: load})
			continue
		}
		normal = append(normal, keyLoad{key: key, load: load})
	}

	var best *candidate
	maxBuckets := func(load int64) int {
		return maxInt(2, minInt(cfg.MaxSaltBuckets, minInt(p, int(load))))
	}
	wide := make([]int, len(hotKeys))
	adaptive := make([]int, len(hotKeys))
	previous := make([]int, len(hotKeys))
	for i, hot := range hotKeys {
		wide[i] = maxBuckets(hot.load)
		adaptive[i] = wide[i]
		if target >= 1 {
			adaptive[i] = maxInt(2, minInt(int((hot.load+int64(target)-1)/int64(target)), wide[i]))
		}
		previous[i] = adaptive[i]
		if cfg.Previous != nil {
			if n := previousSplitBuckets(cfg.Previous, hot.key); n >= 2 {
				previous[i] = minInt(n, wide[i])
			}
		}
	}

	variants := [][]int{adaptive, wide}
	if cfg.Previous != nil {
		variants = append(variants, previous)
	}
	var bestBuckets []int
	for _, buckets := range variants {
		cand := evaluateVariant(keys, counts, normal, hotKeys, buckets, cfg, total)
		if best == nil || betterScore(score{cand.max, cand.migration.MovedLoad}, score{best.max, best.migration.MovedLoad}) {
			best = cand
			bestBuckets = append([]int(nil), buckets...)
		}
	}

	shardCount := 0
	for _, n := range wide {
		shardCount += n
	}
	if len(hotKeys) > 0 && len(hotKeys) <= 4 && shardCount <= 12 {
		maxWide := 0
		for _, n := range wide {
			if n > maxWide {
				maxWide = n
			}
		}
		if maxWide <= 16 {
			for pass := 0; pass < 3; pass++ {
				improved := false
				for i := range hotKeys {
					current := bestBuckets[i]
					for buckets := 2; buckets <= wide[i]; buckets++ {
						if buckets == current {
							continue
						}
						trial := append([]int(nil), bestBuckets...)
						trial[i] = buckets
						cand := evaluateVariant(keys, counts, normal, hotKeys, trial, cfg, total)
						if betterScore(score{cand.max, cand.migration.MovedLoad}, score{best.max, best.migration.MovedLoad}) {
							best = cand
							bestBuckets = trial
							current = buckets
							improved = true
						}
					}
				}
				if !improved {
					break
				}
			}
		}
	}

	plan := &Plan{
		Version:    revision,
		Partitions: best.partitions,
		Splits:     best.splits,
		TotalLoad:  best.total,
		MaxLoad:    best.max,
		Migration:  best.migration,
	}
	if cfg.Previous != nil {
		plan.PreviousVersion = cfg.Previous.Version
	}
	plan.Keys = make([]KeyLoad, 0, len(keys))
	for _, key := range keys {
		plan.Keys = append(plan.Keys, KeyLoad{Key: key, Load: counts[key]})
	}
	if err := plan.Validate(); err != nil {
		return nil, err
	}
	return plan, nil
}

func previousSplitBuckets(plan *Plan, key string) int {
	for i := range plan.Splits {
		if plan.Splits[i].Key == key {
			return len(plan.Splits[i].Buckets)
		}
	}
	return 0
}

func evaluateVariant(keys []string, counts map[string]int64, normal, hotKeys []keyLoad,
	bucketCounts []int, cfg Config, total int64) *candidate {

	splits := make([]KeySplit, len(hotKeys))
	shards := make([]internalShard, 0)
	for i, hot := range hotKeys {
		buckets := minInt(bucketCounts[i], int(hot.load))
		buckets = maxInt(2, buckets)
		split := KeySplit{Key: hot.key, Load: hot.load, Buckets: make([]SaltBucket, buckets)}
		base := hot.load / int64(buckets)
		rem := hot.load % int64(buckets)
		for b := 0; b < buckets; b++ {
			bucketLoad := base
			if int64(b) < rem {
				bucketLoad++
			}
			split.Buckets[b] = SaltBucket{Salt: uint32(b), Load: bucketLoad}
			shards = append(shards, internalShard{
				key:  hot.key,
				salt: uint32(b),
				load: bucketLoad,
				hot:  i,
			})
		}
		splits[i] = split
	}

	if exhaustiveGroupSearchFeasible(len(normal), cfg.Partitions, len(shards)) {
		return evaluateGroupsExhaustively(keys, counts, normal, splits, shards, cfg, total)
	}

	var best *candidate
	for _, usedGroups := range groupCountCandidates(len(normal), cfg.Partitions) {
		baseLoads := make([]int64, cfg.Partitions)
		for iter := 0; iter < 4; iter++ {
			shardLoads, assignments := assignShards(baseLoads, shards, cfg.Previous, cfg.Partitions)
			groups := partitionRanges(normal, cfg.Partitions, usedGroups, shardLoads, cfg.Previous)
			cand := materialize(keys, counts, normal, splits, shards, assignments, groups, usedGroups,
				shardLoads, cfg.Partitions, total, cfg.Previous)
			if best == nil || betterScore(score{cand.max, cand.migration.MovedLoad}, score{best.max, best.migration.MovedLoad}) {
				best = cand
			}
			if equalInt64s(baseLoads, cand.baseLoads) {
				break
			}
			baseLoads = cand.baseLoads
		}
	}
	return best
}

func exhaustiveGroupSearchFeasible(normalKeys, partitions, shards int) bool {
	return normalKeys <= 10 && partitions <= 6 && shards <= 12
}

func evaluateGroupsExhaustively(keys []string, counts map[string]int64, normal []keyLoad,
	splits []KeySplit, shards []internalShard, cfg Config, total int64) *candidate {

	var best *candidate
	consider := func(groups []group, used int) {
		base := make([]int64, cfg.Partitions)
		for i := 0; i < used; i++ {
			base[i] = groups[i].load
		}
		shardLoads, assignments := assignShards(base, shards, cfg.Previous, cfg.Partitions)
		cand := materialize(keys, counts, normal, splits, shards, assignments, groups, used,
			shardLoads, cfg.Partitions, total, cfg.Previous)
		if best == nil || betterScore(score{cand.max, cand.migration.MovedLoad}, score{best.max, best.migration.MovedLoad}) {
			best = cand
		}
	}

	count := len(normal)
	if count == 0 {
		consider(make([]group, cfg.Partitions), 0)
		return best
	}

	prefix := make([]int64, count+1)
	for i, item := range normal {
		prefix[i+1] = prefix[i] + item.load
	}
	maxGroups := minInt(cfg.Partitions, count)
	groups := make([]group, cfg.Partitions)
	for used := 1; used <= maxGroups; used++ {
		var walk func(groupIndex, start int)
		walk = func(groupIndex, start int) {
			if groupIndex == used-1 {
				groups[groupIndex] = group{start: start, end: count, load: prefix[count] - prefix[start]}
				consider(groups, used)
				return
			}
			lastEnd := count - (used - groupIndex - 1)
			for end := start + 1; end <= lastEnd; end++ {
				groups[groupIndex] = group{start: start, end: end, load: prefix[end] - prefix[start]}
				walk(groupIndex+1, end)
			}
		}
		walk(0, 0)
	}
	return best
}

func groupCountCandidates(normalKeys, partitions int) []int {
	maxGroups := minInt(partitions, normalKeys)
	if maxGroups == 0 {
		return []int{0}
	}
	if partitions <= 12 && normalKeys <= 64 {
		result := make([]int, 0, maxGroups)
		for groups := 1; groups <= maxGroups; groups++ {
			result = append(result, groups)
		}
		return result
	}
	return []int{maxGroups}
}

func equalInt64s(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func assignShards(base []int64, shards []internalShard, prev *Plan, partitions int) ([]int64, []int) {
	order := make([]int, len(shards))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(i, j int) bool {
		a, b := shards[order[i]], shards[order[j]]
		if a.load != b.load {
			return a.load > b.load
		}
		if a.key != b.key {
			return a.key < b.key
		}
		return a.salt < b.salt
	})

	loads := make([]int64, partitions)
	assignments := make([]int, len(shards))
	for _, index := range order {
		shard := shards[index]
		bestPart := 0
		var bestMax, bestNew, bestMigration int64
		bestSet := false
		for part := 0; part < partitions; part++ {
			newShardLoad := loads[part] + shard.load
			newTotal := base[part] + newShardLoad
			newMax := maxTotalExcept(base, loads, part, newTotal, -1, 0)
			move := int64(0)
			if prev != nil && previousPartition(prev, shard.key, shard.salt) != part {
				move = 1
			}
			if !bestSet ||
				newMax < bestMax ||
				(newMax == bestMax && newTotal < bestNew) ||
				(newMax == bestMax && newTotal == bestNew && move < bestMigration) ||
				(newMax == bestMax && newTotal == bestNew && move == bestMigration && part < bestPart) {
				bestSet = true
				bestPart = part
				bestMax = newMax
				bestNew = newTotal
				bestMigration = move
			}
		}
		loads[bestPart] += shard.load
		assignments[index] = bestPart
	}

	improveShardAssignment(base, loads, assignments, shards, prev)
	if exactShardsFeasible(len(shards), partitions) {
		loads, assignments = exactShardAssignment(base, shards, prev, partitions, loads, assignments)
	}
	return loads, assignments
}

func exactShardsFeasible(shards, partitions int) bool {
	if shards > 12 || partitions > 8 {
		return false
	}
	nodes := int64(1)
	for i := 0; i < shards; i++ {
		nodes *= int64(partitions)
		if nodes > 2_000_000 {
			return false
		}
	}
	return true
}

func exactShardAssignment(base []int64, shards []internalShard, prev *Plan, partitions int,
	initialLoads []int64, initialAssign []int) ([]int64, []int) {

	order := make([]int, len(shards))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(i, j int) bool {
		a, b := shards[order[i]], shards[order[j]]
		if a.load != b.load {
			return a.load > b.load
		}
		if a.key != b.key {
			return a.key < b.key
		}
		return a.salt < b.salt
	})

	bestLoads := append([]int64(nil), initialLoads...)
	bestAssign := append([]int(nil), initialAssign...)
	bestMax := maxTotal(base, bestLoads)
	bestMig := migrationForAssignment(prev, shards, bestAssign)

	loads := make([]int64, partitions)
	assign := make([]int, len(shards))
	var dfs func(int, int64)
	dfs = func(index int, migrated int64) {
		currentMax := maxTotal(base, loads)
		if currentMax > bestMax || (currentMax == bestMax && migrated >= bestMig) {
			return
		}
		if index == len(order) {
			bestMax = currentMax
			bestMig = migrated
			bestLoads = append(bestLoads[:0], loads...)
			copy(bestAssign, assign)
			return
		}

		shardIndex := order[index]
		shard := shards[shardIndex]
		tried := make(map[[2]int64]struct{}, partitions)
		for part := 0; part < partitions; part++ {
			move := int64(0)
			if prev != nil && previousPartition(prev, shard.key, shard.salt) != part {
				move = shard.load
			}
			key := [2]int64{base[part] + loads[part], move}
			if _, seen := tried[key]; seen {
				continue
			}
			tried[key] = struct{}{}
			loads[part] += shard.load
			assign[shardIndex] = part
			dfs(index+1, migrated+move)
			loads[part] -= shard.load
		}
	}
	dfs(0, 0)
	return bestLoads, bestAssign
}

func migrationForAssignment(prev *Plan, shards []internalShard, assignments []int) int64 {
	if prev == nil {
		return 0
	}
	var migrated int64
	for i, shard := range shards {
		if previousPartition(prev, shard.key, shard.salt) != assignments[i] {
			migrated += shard.load
		}
	}
	return migrated
}

func improveShardAssignment(base, loads []int64, assignments []int, shards []internalShard, prev *Plan) {
	for pass := 0; pass < len(shards)*2+1; pass++ {
		changed := false
		currentMax := maxTotal(base, loads)
		for shardIndex, shard := range shards {
			from := assignments[shardIndex]
			if base[from]+loads[from] != currentMax {
				continue
			}
			bestPart := from
			bestMax := currentMax
			bestMove := shardMigration(prev, shard, from)
			for part := range loads {
				if part == from {
					continue
				}
				newFrom := base[from] + loads[from] - shard.load
				newTo := base[part] + loads[part] + shard.load
				newMax := maxTotalExcept(base, loads, from, newFrom, part, newTo)
				move := shardMigration(prev, shard, part)
				if newMax < bestMax || (newMax == bestMax && move < bestMove) {
					bestPart = part
					bestMax = newMax
					bestMove = move
				}
			}
			if bestPart != from {
				loads[from] -= shard.load
				loads[bestPart] += shard.load
				assignments[shardIndex] = bestPart
				changed = true
			}
		}
		if !changed {
			break
		}
	}
}

func shardMigration(prev *Plan, shard internalShard, part int) int64 {
	if prev == nil {
		return 0
	}
	if previousPartition(prev, shard.key, shard.salt) == part {
		return 0
	}
	return 1
}

func maxTotal(base, shardLoads []int64) int64 {
	var m int64
	for i := range base {
		n := base[i] + shardLoads[i]
		if n > m {
			m = n
		}
	}
	return m
}

func maxTotalExcept(base, shardLoads []int64, i1 int, v1 int64, i2 int, v2 int64) int64 {
	var m int64
	for i := range base {
		n := base[i] + shardLoads[i]
		switch i {
		case i1:
			n = v1
		case i2:
			n = v2
		}
		if n > m {
			m = n
		}
	}
	return m
}

func partitionRanges(normal []keyLoad, partitions, groupsCount int, shardLoads []int64, prev *Plan) []group {
	count := len(normal)
	groups := make([]group, partitions)
	if count == 0 {
		return groups
	}

	groupsCount = maxInt(1, minInt(groupsCount, minInt(partitions, count)))
	prefix := make([]int64, count+1)
	for i, item := range normal {
		prefix[i+1] = prefix[i] + item.load
	}

	if int64(groupsCount)*int64(count)*int64(count) <= 20_000_000 {
		return exactGroups(normal, prefix, partitions, groupsCount, shardLoads, prev)
	}
	return greedyGroups(normal, prefix, partitions, groupsCount)
}

type dpCost struct {
	max int64
	mig int64
}

func exactGroups(normal []keyLoad, prefix []int64, partitions, groupsCount int, shardLoads []int64, prev *Plan) []group {
	count := len(normal)
	inf := int64(1<<62 - 1)
	dp := make([][]dpCost, groupsCount+1)
	back := make([][]int, groupsCount+1)
	for g := range dp {
		dp[g] = make([]dpCost, count+1)
		back[g] = make([]int, count+1)
		for i := 0; i <= count; i++ {
			dp[g][i] = dpCost{max: inf, mig: inf}
			back[g][i] = -1
		}
	}
	dp[0][0] = dpCost{}

	var migPrefix [][]int64
	if prev != nil {
		migPrefix = make([][]int64, partitions)
		for part := 0; part < partitions; part++ {
			migPrefix[part] = make([]int64, count+1)
			for i, item := range normal {
				migPrefix[part][i+1] = migPrefix[part][i]
				if previousPartition(prev, item.key, 0) != part {
					migPrefix[part][i+1] += item.load
				}
			}
		}
	}

	for g := 1; g <= groupsCount; g++ {
		for i := g; i <= count; i++ {
			for j := g - 1; j < i; j++ {
				if dp[g-1][j].max == inf {
					continue
				}
				load := prefix[i] - prefix[j] + shardLoads[g-1]
				cost := dpCost{
					max: maxInt64Value(dp[g-1][j].max, load),
					mig: dp[g-1][j].mig,
				}
				if prev != nil {
					cost.mig += migPrefix[g-1][i] - migPrefix[g-1][j]
				}
				if cost.max < dp[g][i].max ||
					(cost.max == dp[g][i].max && cost.mig < dp[g][i].mig) {
					dp[g][i] = cost
					back[g][i] = j
				}
			}
		}
	}

	result := make([]group, partitions)
	i := count
	for g := groupsCount; g >= 1; g-- {
		j := back[g][i]
		if j < 0 {
			j = g - 1
		}
		result[g-1] = group{start: j, end: i, load: prefix[i] - prefix[j]}
		i = j
	}
	return result
}

func greedyGroups(normal []keyLoad, prefix []int64, partitions, groupsCount int) []group {
	count := len(normal)
	result := make([]group, partitions)
	start := 0
	for g := 0; g < groupsCount; g++ {
		remainingGroups := groupsCount - g
		maxEnd := count - remainingGroups + 1
		end := start + 1
		if g == groupsCount-1 {
			end = count
		} else {
			remainingLoad := prefix[count] - prefix[start]
			target := prefix[start] + (remainingLoad+int64(remainingGroups)-1)/int64(remainingGroups)
			for end < maxEnd && prefix[end] < target {
				end++
			}
		}
		if end < start+1 {
			end = start + 1
		}
		result[g] = group{start: start, end: end, load: prefix[end] - prefix[start]}
		start = end
	}
	for g := groupsCount; g < partitions; g++ {
		result[g] = group{start: count, end: count}
	}
	return result
}

func maxInt64Value(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func materialize(allKeys []string, counts map[string]int64, normal []keyLoad, splits []KeySplit,
	shards []internalShard, assignments []int, groups []group, usedGroups int, shardLoads []int64,
	partitions int, total int64, prev *Plan) *candidate {

	parts := make([]Partition, partitions)
	baseLoads := make([]int64, partitions)
	for g := 0; g < partitions; g++ {
		parts[g] = Partition{ID: g, SplitLoad: shardLoads[g], Load: shardLoads[g]}
		if g < usedGroups {
			baseLoads[g] = groups[g].load
			parts[g].RangeLoad = groups[g].load
			parts[g].Load += groups[g].load
		}
	}

	if usedGroups == 0 {
		cur := ""
		for g := 0; g < partitions; g++ {
			parts[g].Start = cur
			if g+1 == partitions {
				parts[g].EndUnbounded = true
			} else {
				cur = cur + "\x00"
				parts[g].End = cur
			}
		}
	} else {
		tailStart := ""
		if usedGroups < partitions && len(allKeys) > 0 {
			tailStart = allKeys[len(allKeys)-1] + "\x00"
		}
		for g := 0; g < partitions; g++ {
			if g < usedGroups {
				if g == 0 {
					parts[g].Start = ""
				} else {
					parts[g].Start = normal[groups[g].start].key
				}
				if g+1 < usedGroups {
					parts[g].End = normal[groups[g+1].start].key
				} else if usedGroups < partitions {
					parts[g].End = tailStart
				} else {
					parts[g].EndUnbounded = true
				}
			} else {
				if g == usedGroups {
					parts[g].Start = tailStart
				} else {
					parts[g].Start = parts[g-1].End
				}
				if g+1 == partitions {
					parts[g].EndUnbounded = true
				} else {
					parts[g].End = parts[g].Start + "\x00"
				}
			}
		}
	}

	outSplits := make([]KeySplit, len(splits))
	for i, split := range splits {
		outSplits[i] = KeySplit{Key: split.Key, Load: split.Load, Buckets: make([]SaltBucket, len(split.Buckets))}
		copy(outSplits[i].Buckets, split.Buckets)
	}
	for i, shard := range shards {
		part := assignments[i]
		outSplits[shard.hot].Buckets[shard.salt].Partition = part
	}

	maxLoad := int64(0)
	for i := range parts {
		if parts[i].Load > maxLoad {
			maxLoad = parts[i].Load
		}
	}

	cand := &candidate{
		partitions: parts,
		splits:     outSplits,
		baseLoads:  baseLoads,
		total:      total,
		max:        maxLoad,
	}
	if prev != nil {
		cand.migration = computeMigration(prev, parts, outSplits, allKeys, counts)
	}
	return cand
}

func computeMigration(prev *Plan, parts []Partition, splits []KeySplit, keys []string, counts map[string]int64) Migration {
	mig := Migration{FromVersion: prev.Version}
	splitMap := make(map[string]*KeySplit, len(splits))
	for i := range splits {
		splitMap[splits[i].Key] = &splits[i]
	}
	for _, key := range keys {
		oldShares := prev.keyShares(key)
		if len(oldShares) == 0 {
			continue
		}
		mig.ComparedKeys++
		newShares := sharesForPlan(parts, splitMap, key, counts[key])
		overlap := int64(0)
		changed := len(newShares) != len(oldShares)
		for part, load := range newShares {
			if load > oldShares[part] {
				overlap += oldShares[part]
			} else {
				overlap += load
			}
			if _, exists := oldShares[part]; !exists {
				changed = true
			}
		}
		for part := range oldShares {
			if _, ok := newShares[part]; !ok {
				changed = true
			}
		}
		if !changed {
			continue
		}
		if counts[key] > overlap {
			mig.MovedLoad += counts[key] - overlap
		}
		mig.MovedKeys++
	}
	return mig
}

func sharesForPlan(parts []Partition, splitMap map[string]*KeySplit, key string, load int64) map[int]int64 {
	shares := make(map[int]int64)
	if split := splitMap[key]; split != nil {
		for _, bucket := range split.Buckets {
			shares[bucket.Partition] += bucket.Load
		}
		return shares
	}
	shares[partitionOf(parts, key)] = load
	return shares
}

func (p *Plan) keyShares(key string) map[int]int64 {
	shares := make(map[int]int64)
	for i := range p.Splits {
		if p.Splits[i].Key == key {
			for _, bucket := range p.Splits[i].Buckets {
				shares[bucket.Partition] += bucket.Load
			}
			return shares
		}
	}
	load, ok := p.keyLoad(key)
	if !ok {
		return nil
	}
	shares[partitionOf(p.Partitions, key)] = load
	return shares
}

func (p *Plan) keyLoad(key string) (int64, bool) {
	i := sort.Search(len(p.Keys), func(i int) bool { return p.Keys[i].Key >= key })
	if i < len(p.Keys) && p.Keys[i].Key == key {
		return p.Keys[i].Load, true
	}
	return 0, false
}

func partitionOf(parts []Partition, key string) int {
	i := sort.Search(len(parts), func(i int) bool {
		if parts[i].EndUnbounded {
			return true
		}
		return key < parts[i].End
	})
	if i >= len(parts) {
		return len(parts) - 1
	}
	return i
}

// Placement returns all salted or range placements of key and their load
// shares. A normal key has one placement; a hot key has one per salt bucket.
func (p *Plan) Placement(key string) ([]RouteLoad, bool) {
	load, observed := p.keyLoad(key)
	for i := range p.Splits {
		if p.Splits[i].Key != key {
			continue
		}
		out := make([]RouteLoad, 0, len(p.Splits[i].Buckets))
		for _, bucket := range p.Splits[i].Buckets {
			out = append(out, RouteLoad{
				Route: Route{Key: key, Partition: bucket.Partition, Salted: true, Salt: bucket.Salt},
				Load:  bucket.Load,
			})
		}
		return out, true
	}
	if !observed {
		return nil, false
	}
	return []RouteLoad{{
		Route: Route{Key: key, Partition: partitionOf(p.Partitions, key)},
		Load:  load,
	}}, true
}

// Ownership is an alias for Placement.
func (p *Plan) Ownership(key string) ([]RouteLoad, bool) {
	return p.Placement(key)
}

// Routes returns every placement of key without load shares.
func (p *Plan) Routes(key string) ([]Route, bool) {
	shares, ok := p.Placement(key)
	if !ok {
		return nil, false
	}
	routes := make([]Route, len(shares))
	for i, share := range shares {
		routes[i] = share.Route
	}
	return routes, true
}

// RestoreSalted maps an encoded salted key back to its route. It returns false
// when the key is not a salted sub-partition in this plan.
func (p *Plan) RestoreSalted(salted string) (Route, bool) {
	key, salt, ok := RestoreSaltedKey(salted)
	if !ok {
		return Route{}, false
	}
	for i := range p.Splits {
		if p.Splits[i].Key != key {
			continue
		}
		for _, bucket := range p.Splits[i].Buckets {
			if bucket.Salt == salt {
				return Route{Key: key, Partition: bucket.Partition, Salted: true, Salt: salt}, true
			}
		}
	}
	return Route{}, false
}

// PartitionsFor returns the distinct partitions holding any load of key.
func (p *Plan) PartitionsFor(key string) []int {
	shares, ok := p.Placement(key)
	if !ok {
		return nil
	}
	seen := make(map[int]struct{}, len(shares))
	result := make([]int, 0, len(shares))
	for _, share := range shares {
		if _, exists := seen[share.Partition]; exists {
			continue
		}
		seen[share.Partition] = struct{}{}
		result = append(result, share.Partition)
	}
	sort.Ints(result)
	return result
}

// Route returns the canonical (salt zero for hot keys) placement of key.
// Callers splitting a hot key's occurrences must use RouteOccurrence.
func (p *Plan) Route(key string) (Route, bool) {
	return p.RouteOccurrence(key, 0)
}

// RouteOccurrence returns the deterministic placement of the occurrence-th
// unit of key. Occurrences are zero-based and are spread round-robin over salt
// buckets, matching the bucket loads in the plan.
func (p *Plan) RouteOccurrence(key string, occurrence uint64) (Route, bool) {
	for i := range p.Splits {
		if p.Splits[i].Key != key {
			continue
		}
		buckets := p.Splits[i].Buckets
		bucket := buckets[occurrence%uint64(len(buckets))]
		return Route{Key: key, Partition: bucket.Partition, Salted: true, Salt: bucket.Salt}, true
	}
	if _, ok := p.keyLoad(key); !ok {
		return Route{}, false
	}
	return Route{Key: key, Partition: partitionOf(p.Partitions, key)}, true
}

// RouteRecord is an alias for RouteOccurrence.
func (p *Plan) RouteRecord(key string, ordinal uint64) (Route, bool) {
	return p.RouteOccurrence(key, ordinal)
}

// Loads returns the load of every partition in ID order.
func (p *Plan) Loads() []int64 {
	loads := make([]int64, len(p.Partitions))
	for i, part := range p.Partitions {
		loads[i] = part.Load
	}
	return loads
}

// Boundaries returns partition start keys in strictly increasing order.
func (p *Plan) Boundaries() []string {
	starts := make([]string, len(p.Partitions))
	for i, part := range p.Partitions {
		starts[i] = part.Start
	}
	return starts
}

// PartitionAt returns the range partition containing key, ignoring hot-key
// overrides.
func (p *Plan) PartitionAt(key string) (int, bool) {
	if len(p.Partitions) == 0 {
		return 0, false
	}
	return partitionOf(p.Partitions, key), true
}

// Validate checks ordering, complete coverage, load conservation, salt
// uniqueness and partition references.
func (p *Plan) Validate() error {
	if p == nil {
		return fmt.Errorf("formal: nil plan")
	}
	if len(p.Partitions) == 0 {
		return fmt.Errorf("formal: plan has no partitions")
	}
	if p.Partitions[0].Start != "" {
		return fmt.Errorf("formal: first partition starts at %q, want minimum key", p.Partitions[0].Start)
	}
	var sum int64
	for i := range p.Partitions {
		part := &p.Partitions[i]
		if part.ID != i {
			return fmt.Errorf("formal: partition %d has ID %d", i, part.ID)
		}
		if part.RangeLoad < 0 || part.SplitLoad < 0 || part.Load < 0 {
			return fmt.Errorf("formal: partition %d has negative load", i)
		}
		if part.Load != part.RangeLoad+part.SplitLoad {
			return fmt.Errorf("formal: partition %d load %d != %d + %d", i, part.Load, part.RangeLoad, part.SplitLoad)
		}
		if part.EndUnbounded {
			if i != len(p.Partitions)-1 {
				return fmt.Errorf("formal: partition %d is unbounded before the last partition", i)
			}
		} else {
			if part.End <= part.Start {
				return fmt.Errorf("formal: partition %d has empty or reversed range [%q,%q)", i, part.Start, part.End)
			}
			if i+1 < len(p.Partitions) && p.Partitions[i+1].Start != part.End {
				return fmt.Errorf("formal: gap or overlap between partitions %d and %d", i, i+1)
			}
		}
		if i+1 < len(p.Partitions) && p.Partitions[i+1].Start <= part.Start {
			return fmt.Errorf("formal: partition starts are not strictly increasing at %d", i)
		}
		sum += part.Load
	}
	if !p.Partitions[len(p.Partitions)-1].EndUnbounded {
		return fmt.Errorf("formal: final partition is bounded")
	}
	if sum != p.TotalLoad {
		return fmt.Errorf("formal: partition load %d != total load %d", sum, p.TotalLoad)
	}

	seenKeys := make(map[string]struct{}, len(p.Splits))
	splitMap := make(map[string]*KeySplit, len(p.Splits))
	for _, split := range p.Splits {
		if split.Load <= 0 {
			return fmt.Errorf("formal: split %q has non-positive load", split.Key)
		}
		if len(split.Buckets) < 2 {
			return fmt.Errorf("formal: split %q has fewer than two buckets", split.Key)
		}
		if _, exists := seenKeys[split.Key]; exists {
			return fmt.Errorf("formal: duplicate split for key %q", split.Key)
		}
		seenKeys[split.Key] = struct{}{}
		splitMap[split.Key] = &split
		var bucketSum int64
		seenSalt := make(map[uint32]struct{}, len(split.Buckets))
		for _, bucket := range split.Buckets {
			if bucket.Partition < 0 || bucket.Partition >= len(p.Partitions) {
				return fmt.Errorf("formal: split %q references partition %d", split.Key, bucket.Partition)
			}
			if bucket.Load < 0 {
				return fmt.Errorf("formal: split %q has negative bucket load", split.Key)
			}
			if _, exists := seenSalt[bucket.Salt]; exists {
				return fmt.Errorf("formal: split %q has duplicate salt %d", split.Key, bucket.Salt)
			}
			seenSalt[bucket.Salt] = struct{}{}
			bucketSum += bucket.Load
		}
		if bucketSum != split.Load {
			return fmt.Errorf("formal: split %q bucket load %d != key load %d", split.Key, bucketSum, split.Load)
		}
	}

	var keyTotal int64
	rangeLoads := make([]int64, len(p.Partitions))
	splitLoads := make([]int64, len(p.Partitions))
	for i, item := range p.Keys {
		if item.Load <= 0 {
			return fmt.Errorf("formal: key %q has non-positive load", item.Key)
		}
		if i > 0 && p.Keys[i-1].Key >= item.Key {
			return fmt.Errorf("formal: keys are not strictly sorted at %q", item.Key)
		}
		keyTotal += item.Load
		if split := splitMap[item.Key]; split != nil {
			if split.Load != item.Load {
				return fmt.Errorf("formal: split %q load %d != key load %d", item.Key, split.Load, item.Load)
			}
			for _, bucket := range split.Buckets {
				splitLoads[bucket.Partition] += bucket.Load
			}
			continue
		}
		rangeLoads[partitionOf(p.Partitions, item.Key)] += item.Load
	}
	if keyTotal != p.TotalLoad {
		return fmt.Errorf("formal: key load %d != total load %d", keyTotal, p.TotalLoad)
	}
	for i := range p.Partitions {
		if rangeLoads[i] != p.Partitions[i].RangeLoad {
			return fmt.Errorf("formal: partition %d range load %d != key ownership %d",
				i, p.Partitions[i].RangeLoad, rangeLoads[i])
		}
		if splitLoads[i] != p.Partitions[i].SplitLoad {
			return fmt.Errorf("formal: partition %d split load %d != key ownership %d",
				i, p.Partitions[i].SplitLoad, splitLoads[i])
		}
	}
	return nil
}

func previousPartition(prev *Plan, key string, salt uint32) int {
	for i := range prev.Splits {
		if prev.Splits[i].Key != key {
			continue
		}
		for _, bucket := range prev.Splits[i].Buckets {
			if bucket.Salt == salt {
				return bucket.Partition
			}
		}
		if salt == 0 && len(prev.Splits[i].Buckets) > 0 {
			return prev.Splits[i].Buckets[0].Partition
		}
		return -1
	}
	return partitionOf(prev.Partitions, key)
}

func (p *Plan) String() string {
	return fmt.Sprintf("plan v%d: %d partitions, load=%d max=%d", p.Version, len(p.Partitions), p.TotalLoad, p.MaxLoad)
}

func (s SaltBucket) String() string {
	return fmt.Sprintf("salt=%s partition=%d load=%d", saltLabel(s.Salt), s.Partition, s.Load)
}
