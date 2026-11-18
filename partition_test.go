package formal

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"sync"
	"testing"
)

func TestExhaustiveSmallKeySpace(t *testing.T) {
	keys := []string{"", "a", "aa", "b", "z"}
	const maxLoad = 3
	combinations := 1
	for range keys {
		combinations *= maxLoad + 1
	}

	for mask := 0; mask < combinations; mask++ {
		freq := make(map[string]int64, len(keys))
		value := mask
		for _, key := range keys {
			n := value % (maxLoad + 1)
			value /= maxLoad + 1
			if n > 0 {
				freq[key] = int64(n)
			}
		}
		for partitions := 1; partitions <= 4; partitions++ {
			name := fmt.Sprintf("mask=%d/partitions=%d", mask, partitions)
			cfg := DefaultConfig(partitions)
			cfg.MaxSaltBuckets = partitions
			plan, err := BuildPlan(freq, cfg)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if err := plan.Validate(); err != nil {
				t.Fatalf("%s: validate: %v", name, err)
			}
			checkPlanAgainstFrequency(t, name, plan, freq)
		}
	}
}

func checkPlanAgainstFrequency(t *testing.T, name string, plan *Plan, freq map[string]int64) {
	t.Helper()
	var expectedTotal int64
	naiveLoad := make([]int64, len(plan.Partitions))
	naiveRange := make([]int64, len(plan.Partitions))
	naiveSplit := make([]int64, len(plan.Partitions))

	keys := make([]string, 0, len(freq))
	for key := range freq {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		load := freq[key]
		if load == 0 {
			continue
		}
		expectedTotal += load
		shares, ok := plan.Placement(key)
		if !ok {
			t.Fatalf("%s: key %q missing from placement", name, key)
		}
		var placementSum int64
		for _, share := range shares {
			placementSum += share.Load
			naiveLoad[share.Partition] += share.Load
			if share.Salted {
				naiveSplit[share.Partition] += share.Load
			} else {
				naiveRange[share.Partition] += share.Load
			}
		}
		if placementSum != load {
			t.Fatalf("%s: key %q placement load %d != frequency %d", name, key, placementSum, load)
		}

		routed := make([]int64, len(plan.Partitions))
		for occurrence := uint64(0); occurrence < uint64(load); occurrence++ {
			route, ok := plan.RouteOccurrence(key, occurrence)
			if !ok {
				t.Fatalf("%s: key %q occurrence %d missing", name, key, occurrence)
			}
			routed[route.Partition]++
			if route.Salted {
				restored, salt, ok := RestoreSaltedKey(route.SaltedKey())
				if !ok || restored != key || salt != route.Salt {
					t.Fatalf("%s: salted route did not restore: %+v", name, route)
				}
			}
		}
		for part, n := range routed {
			if n != sharesLoadOn(shares, part) {
				t.Fatalf("%s: key %q occurrence routing on partition %d = %d, shares = %d",
					name, key, part, n, sharesLoadOn(shares, part))
			}
		}
		if len(shares) == 1 {
			if part := plan.Partitions[shares[0].Partition]; !part.Contains(key) {
				t.Fatalf("%s: key %q routed outside range %q..%q", name, key, part.Start, part.End)
			}
		}
	}

	if plan.TotalLoad != expectedTotal {
		t.Fatalf("%s: total load %d != %d", name, plan.TotalLoad, expectedTotal)
	}
	if plan.MaxLoad != maxOf(plan.Loads()) {
		t.Fatalf("%s: max load mismatch", name)
	}
	for i, part := range plan.Partitions {
		if part.Load != naiveLoad[i] ||
			part.RangeLoad != naiveRange[i] ||
			part.SplitLoad != naiveSplit[i] {
			t.Fatalf("%s: partition %d load=(%d,%d,%d), naive=(%d,%d,%d)",
				name, i, part.Load, part.RangeLoad, part.SplitLoad,
				naiveLoad[i], naiveRange[i], naiveSplit[i])
		}
	}

	expected := naiveLoad
	actual := plan.Loads()
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("%s: plan loads %v != naive %v", name, actual, expected)
	}
}

func sharesLoadOn(shares []RouteLoad, partition int) int64 {
	var n int64
	for _, share := range shares {
		if share.Partition == partition {
			n += share.Load
		}
	}
	return n
}

func maxOf(values []int64) int64 {
	var m int64
	for _, value := range values {
		if value > m {
			m = value
		}
	}
	return m
}

func TestBoundariesAreCompleteForFewKeys(t *testing.T) {
	for _, freq := range []map[string]int64{
		{},
		{"only": 7},
		{"a": 1, "z": 1},
		{"a": 3, "m": 2, "z": 1},
	} {
		for partitions := 1; partitions <= 7; partitions++ {
			cfg := DefaultConfig(partitions)
			plan, err := BuildPlan(freq, cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err := plan.Validate(); err != nil {
				t.Fatalf("%v partitions=%d: %v", freq, partitions, err)
			}
			if len(plan.Partitions) != partitions {
				t.Fatalf("%v: got %d partitions, want %d", freq, len(plan.Partitions), partitions)
			}
			for i := 1; i < len(plan.Partitions); i++ {
				if plan.Partitions[i-1].End != plan.Partitions[i].Start {
					t.Fatalf("gap between %d and %d", i-1, i)
				}
			}
			for key := range freq {
				if _, ok := plan.Placement(key); !ok {
					t.Fatalf("key %q has no placement", key)
				}
			}
		}
	}
}

func TestHotKeySaltSplitAndRestore(t *testing.T) {
	freq := map[string]int64{
		"hot": 100,
		"a":   10,
		"b":   10,
		"c":   10,
	}
	cfg := DefaultConfig(4)
	cfg.MaxSaltBuckets = 4
	plan, err := BuildPlan(freq, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Splits) != 1 {
		t.Fatalf("got %d splits, want one", len(plan.Splits))
	}
	split := plan.Splits[0]
	if split.Key != "hot" || len(split.Buckets) < 2 {
		t.Fatalf("unexpected split: %+v", split)
	}
	var total int64
	partitions := make(map[int]struct{})
	for _, bucket := range split.Buckets {
		total += bucket.Load
		partitions[bucket.Partition] = struct{}{}
		route := Route{Key: split.Key, Partition: bucket.Partition, Salted: true, Salt: bucket.Salt}
		key, salt, ok := RestoreSaltedKey(route.SaltedKey())
		if !ok || key != "hot" || salt != bucket.Salt {
			t.Fatalf("restore failed for %+v", route)
		}
		restored, ok := plan.RestoreSalted(route.SaltedKey())
		if !ok || restored != route {
			t.Fatalf("plan restore %+v != %+v", restored, route)
		}
	}
	if total != 100 {
		t.Fatalf("split load %d != 100", total)
	}
	if len(partitions) != len(split.Buckets) {
		t.Fatalf("hot key spread over %d partitions, want %d", len(partitions), len(split.Buckets))
	}
	if err := plan.Validate(); err != nil {
		t.Fatal(err)
	}
	routes, ok := plan.Routes("hot")
	if !ok || len(routes) != len(split.Buckets) {
		t.Fatalf("Routes returned %d routes, want %d", len(routes), len(split.Buckets))
	}
}

func TestHotSplitUsesEnoughBucketsToMinimizePeak(t *testing.T) {
	freq := map[string]int64{
		"hot": 20,
		"a":   5,
		"b":   5,
		"c":   5,
		"d":   5,
	}
	cfg := DefaultConfig(4)
	cfg.MaxSaltBuckets = 4
	plan, err := BuildPlan(freq, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Splits) != 1 || len(plan.Splits[0].Buckets) < 2 {
		t.Fatalf("hot key was not split: %+v", plan.Splits)
	}
	if plan.MaxLoad != 10 {
		t.Fatalf("max load %d, want the ideal 10 (loads=%v)", plan.MaxLoad, plan.Loads())
	}
}

func TestSmallExtremeSkewIsSplit(t *testing.T) {
	plan, err := BuildPlan(map[string]int64{"only": 2}, DefaultConfig(4))
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Splits) != 1 || len(plan.Splits[0].Buckets) != 2 {
		t.Fatalf("small extreme skew was not split: %+v", plan.Splits)
	}
	if plan.MaxLoad != 1 {
		t.Fatalf("max load %d, want 1", plan.MaxLoad)
	}
}

func TestSaltKeyInjective(t *testing.T) {
	keys := []string{"", "a", "a:b", "~s1:1:eA", "汉/字", "\x00\xff"}
	seen := make(map[string]struct{})
	for _, key := range keys {
		for salt := uint32(0); salt < 8; salt++ {
			encoded := SaltKey(key, salt)
			if _, exists := seen[encoded]; exists {
				t.Fatalf("duplicate encoding for %q/%d", key, salt)
			}
			seen[encoded] = struct{}{}
			gotKey, gotSalt, ok := RestoreSaltedKey(encoded)
			if !ok || gotKey != key || gotSalt != salt {
				t.Fatalf("round trip %q/%d = %q/%d/%v", key, salt, gotKey, gotSalt, ok)
			}
		}
	}
	if _, _, ok := RestoreSaltedKey("not-salted"); ok {
		t.Fatal("accepted invalid salted key")
	}
	if _, _, ok := RestoreSaltedKey("~s1:not-a-salt:eA"); ok {
		t.Fatal("accepted invalid salt")
	}
}

func TestDeterministicPlan(t *testing.T) {
	freq := map[string]int64{"a": 2, "b": 14, "c": 3, "d": 9, "e": 1, "f": 7}
	cfg := DefaultConfig(4)
	first, err := BuildPlan(freq, cfg)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		next, err := BuildPlan(freq, cfg)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(first, next) {
			t.Fatalf("plan is not deterministic\nfirst=%+v\nnext=%+v", first, next)
		}
	}
}

func TestIdempotentEventsAndNoDoubleCounting(t *testing.T) {
	cfg := DefaultConfig(3)
	p, err := NewPartitioner(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		if !p.AddEvent(Event{ID: "one", Key: "a", Weight: 4}) && i == 0 {
			t.Fatal("first event was rejected")
		}
	}
	if err := p.ObserveN("b", 5); err != nil {
		t.Fatal(err)
	}
	if err := p.ObserveN("b", -1); err == nil {
		t.Fatal("negative weight was accepted")
	}
	p.Observe("c")

	snap := p.Snapshot()
	if snap.Total != 10 || snap.Counts["a"] != 4 || snap.Counts["b"] != 5 || snap.Counts["c"] != 1 {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}
	for i := 0; i < 10; i++ {
		plan, err := p.Plan()
		if err != nil {
			t.Fatal(err)
		}
		if plan.TotalLoad != 10 {
			t.Fatalf("plan %d counted %d units, want 10", i, plan.TotalLoad)
		}
	}
}

func TestInterleavedArrivalsAndPlans(t *testing.T) {
	cfg := DefaultConfig(5)
	cfg.MaxSaltBuckets = 5
	p, err := NewPartitioner(cfg)
	if err != nil {
		t.Fatal(err)
	}

	const events = 2000
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < events; i++ {
			id := fmt.Sprintf("event-%d", i)
			p.AddEvent(Event{ID: id, Key: fmt.Sprintf("key-%d", i%17), Weight: 1})
			p.AddEvent(Event{ID: id, Key: fmt.Sprintf("key-%d", i%17), Weight: 1})
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			plan, err := p.Plan()
			if err != nil {
				t.Errorf("plan: %v", err)
				return
			}
			if err := plan.Validate(); err != nil {
				t.Errorf("interleaved plan invalid: %v", err)
				return
			}
			var sum int64
			for _, part := range plan.Partitions {
				sum += part.Load
			}
			if sum != plan.TotalLoad || plan.TotalLoad > events {
				t.Errorf("plan counted %d/%d", sum, plan.TotalLoad)
				return
			}
		}
	}()
	wg.Wait()

	final, err := p.Plan()
	if err != nil {
		t.Fatal(err)
	}
	if final.TotalLoad != events {
		t.Fatalf("final total %d != %d unique events", final.TotalLoad, events)
	}
	if err := final.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestMigrationDoesNotCountSamePartitionGrowth(t *testing.T) {
	freq := map[string]int64{}
	for i := 0; i < 12; i++ {
		freq[fmt.Sprintf("k%02d", i)] = 10
	}
	prev, err := BuildPlan(freq, DefaultConfig(4))
	if err != nil {
		t.Fatal(err)
	}

	nextFreq := make(map[string]int64, len(freq))
	for key, load := range freq {
		nextFreq[key] = load
	}
	last := "k11"
	lastPartition := -1
	for _, part := range prev.Partitions {
		if part.Contains(last) {
			lastPartition = part.ID
			break
		}
	}
	nextFreq[last]++
	cfg := DefaultConfig(4)
	cfg.Previous = prev
	plan, err := BuildPlan(nextFreq, cfg)
	if err != nil {
		t.Fatal(err)
	}
	partAfter := -1
	for _, part := range plan.Partitions {
		if part.Contains(last) {
			partAfter = part.ID
			break
		}
	}
	if partAfter == lastPartition && plan.Migration.MovedLoad != 0 {
		t.Fatalf("same-partition growth counted as migration: %+v", plan.Migration)
	}
	if plan.Migration.MovedLoad > plan.TotalLoad {
		t.Fatalf("migration exceeds total: %+v", plan.Migration)
	}
}

func TestMigrationIsDeterministic(t *testing.T) {
	base := map[string]int64{}
	for i := 0; i < 40; i++ {
		base[fmt.Sprintf("key-%02d", i)] = int64((i*7)%13 + 1)
	}
	prev, err := BuildPlan(base, DefaultConfig(6))
	if err != nil {
		t.Fatal(err)
	}
	next := make(map[string]int64, len(base))
	for key, load := range base {
		next[key] = load
	}
	next["key-03"] += 50
	next["key-21"] += 20
	cfg := DefaultConfig(6)
	cfg.Previous = prev
	first, err := BuildPlan(next, cfg)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		again, err := BuildPlan(next, cfg)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(first, again) {
			t.Fatal("migration-aware plan is not deterministic")
		}
	}
	if first.Migration.MovedLoad < 0 || first.Migration.MovedLoad > first.TotalLoad {
		t.Fatalf("invalid migration: %+v", first.Migration)
	}
}

func TestMigrationFromHotSplitPlan(t *testing.T) {
	freq := map[string]int64{
		"hot": 80,
		"a":   8,
		"b":   8,
		"c":   8,
		"d":   8,
	}
	cfg := DefaultConfig(4)
	cfg.MaxSaltBuckets = 4
	prev, err := BuildPlan(freq, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(prev.Splits) != 1 {
		t.Fatal("test requires a split previous plan")
	}

	cfg.Previous = prev
	next, err := BuildPlan(freq, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if next.PreviousVersion != prev.Version {
		t.Fatalf("previous version %d != %d", next.PreviousVersion, prev.Version)
	}
	if next.Migration.MovedLoad != 0 || next.Migration.MovedKeys != 0 {
		t.Fatalf("unchanged hot plan migrated: %+v", next.Migration)
	}
	if !reflect.DeepEqual(prev.Loads(), next.Loads()) {
		t.Fatalf("unchanged data changed loads: %v -> %v", prev.Loads(), next.Loads())
	}
}

func TestObserveMapResetAndSetPrevious(t *testing.T) {
	p, err := NewPartitioner(DefaultConfig(2))
	if err != nil {
		t.Fatal(err)
	}
	if err := p.ObserveMap(map[string]int64{"a": 3, "b": 4}); err != nil {
		t.Fatal(err)
	}
	if got := p.Config(); got.Partitions != 2 {
		t.Fatalf("config partitions = %d", got.Partitions)
	}
	plan, err := p.Plan()
	if err != nil {
		t.Fatal(err)
	}
	if plan.TotalLoad != 7 {
		t.Fatalf("load = %d", plan.TotalLoad)
	}
	p.SetPrevious(plan)
	next, err := p.Plan()
	if err != nil {
		t.Fatal(err)
	}
	if next.PreviousVersion != plan.Version {
		t.Fatalf("SetPrevious was not used: %+v", next.Migration)
	}
	p.Reset()
	empty, err := p.Plan()
	if err != nil {
		t.Fatal(err)
	}
	if empty.TotalLoad != 0 || len(empty.Partitions) != 2 {
		t.Fatalf("unexpected reset plan: %+v", empty)
	}
}

func TestRandomizedPlansMatchNaiveRouting(t *testing.T) {
	rng := rand.New(rand.NewSource(20261119))
	for trial := 0; trial < 300; trial++ {
		freq := make(map[string]int64)
		keys := rng.Intn(9)
		for i := 0; i < keys; i++ {
			freq[fmt.Sprintf("%c-%d", 'a'+rng.Intn(6), i)] = int64(rng.Intn(30))
		}
		partitions := 1 + rng.Intn(6)
		cfg := DefaultConfig(partitions)
		cfg.MaxSaltBuckets = 1 + rng.Intn(6)
		plan, err := BuildPlan(freq, cfg)
		if err != nil {
			t.Fatalf("trial %d freq=%v cfg=%+v: %v", trial, freq, cfg, err)
		}
		if err := plan.Validate(); err != nil {
			t.Fatalf("trial %d freq=%v cfg=%+v: %v\nplan=%+v", trial, freq, cfg, err, plan)
		}
		checkPlanAgainstFrequency(t, fmt.Sprintf("trial=%d", trial), plan, freq)
	}
}

func TestConfigValidation(t *testing.T) {
	if _, err := NewPartitioner(Config{}); err == nil {
		t.Fatal("zero partitions accepted")
	}
	if _, err := NewPartitioner(Config{Partitions: 4, HotKeyFactor: -1}); err != nil {
		t.Fatalf("default factor should be accepted: %v", err)
	}
}

func TestShardAssignmentMatchesBruteForceOptimum(t *testing.T) {
	rng := rand.New(rand.NewSource(77))
	for trial := 0; trial < 500; trial++ {
		partitions := 1 + rng.Intn(4)
		shardCount := rng.Intn(8)
		base := make([]int64, partitions)
		for i := range base {
			base[i] = int64(rng.Intn(12))
		}
		shards := make([]internalShard, shardCount)
		for i := range shards {
			shards[i] = internalShard{
				key:  fmt.Sprintf("k%02d", i),
				salt: uint32(i),
				load: int64(1 + rng.Intn(9)),
			}
		}

		loads, _ := assignShards(base, shards, nil, partitions)
		got := maxTotal(base, loads)
		want := bruteForceShardMax(base, shards, 0, make([]int64, partitions))
		if got != want {
			t.Fatalf("trial=%d partitions=%d base=%v shards=%v: got max %d, optimum %d",
				trial, partitions, base, shardLoadsOf(shards), got, want)
		}
	}
}

func bruteForceShardMax(base []int64, shards []internalShard, index int, loads []int64) int64 {
	if index == len(shards) {
		return maxTotal(base, loads)
	}
	best := int64(1<<62 - 1)
	for part := range loads {
		loads[part] += shards[index].load
		if value := bruteForceShardMax(base, shards, index+1, loads); value < best {
			best = value
		}
		loads[part] -= shards[index].load
	}
	return best
}

func shardLoadsOf(shards []internalShard) []int64 {
	loads := make([]int64, len(shards))
	for i := range shards {
		loads[i] = shards[i].load
	}
	return loads
}

func TestSmallPlanPeakMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(991))
	for trial := 0; trial < 200; trial++ {
		partitions := 2 + rng.Intn(3)
		keyCount := 1 + rng.Intn(6)
		freq := make(map[string]int64, keyCount)
		for i := 0; i < keyCount; i++ {
			freq[fmt.Sprintf("k%d", i)] = int64(1 + rng.Intn(12))
		}
		cfg := DefaultConfig(partitions)
		cfg.MaxSaltBuckets = partitions
		plan, err := BuildPlan(freq, cfg)
		if err != nil {
			t.Fatal(err)
		}
		if len(plan.Splits) != 1 {
			continue
		}
		heavy := plan.Splits[0]
		normal := make([]int64, 0, len(freq)-1)
		normalKeys := make([]string, 0, len(freq))
		for key := range freq {
			normalKeys = append(normalKeys, key)
		}
		sort.Strings(normalKeys)
		for _, key := range normalKeys {
			if key != heavy.Key {
				normal = append(normal, freq[key])
			}
		}
		optimum := brutePlanPeak(normal, heavy.Load, partitions, len(heavy.Buckets))
		if plan.MaxLoad != optimum {
			t.Fatalf("trial=%d freq=%v partitions=%d: plan max=%d optimum=%d (loads=%v splits=%+v)",
				trial, freq, partitions, plan.MaxLoad, optimum, plan.Loads(), plan.Splits)
		}
	}
}

func brutePlanPeak(normal []int64, hotLoad int64, partitions, maxBuckets int) int64 {
	best := int64(1<<62 - 1)
	groups := make([]int64, partitions)
	prefix := make([]int64, len(normal)+1)
	for i, load := range normal {
		prefix[i+1] = prefix[i] + load
	}
	var split func(group, start int)
	split = func(group, start int) {
		if group == partitions {
			if start == len(normal) {
				best = minInt64(best, bruteHotPlacement(groups, hotLoad, maxBuckets))
			}
			return
		}
		for end := start; end <= len(normal); end++ {
			groups[group] = prefix[end] - prefix[start]
			split(group+1, end)
		}
	}
	split(0, 0)
	return best
}

func bruteHotPlacement(groups []int64, hotLoad int64, maxBuckets int) int64 {
	best := int64(1<<62 - 1)
	for buckets := 2; buckets <= maxBuckets; buckets++ {
		loads := append([]int64(nil), groups...)
		base := hotLoad / int64(buckets)
		rem := hotLoad % int64(buckets)
		bucketLoads := make([]int64, buckets)
		for i := range bucketLoads {
			bucketLoads[i] = base
			if int64(i) < rem {
				bucketLoads[i]++
			}
		}
		var place func(int)
		place = func(index int) {
			if index == len(bucketLoads) {
				best = minInt64(best, maxOf(loads))
				return
			}
			for part := range loads {
				loads[part] += bucketLoads[index]
				place(index + 1)
				loads[part] -= bucketLoads[index]
			}
		}
		place(0)
	}
	return best
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
