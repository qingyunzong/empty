package dataeng

import (
	"math"
	"math/rand"
	"testing"
)

// evaluateCuts 依据内部切点计算 (总费用, 块数, 切点列表) 三元组。
func evaluateCuts(samples []int64, cuts []int) (cost, blocks int, lex []int) {
	bounds := append(append([]int{}, cuts...), len(samples))
	start := 0
	for _, end := range bounds {
		width := blockBitWidth(samples[start:end])
		cost += blockCost(width, end-start)
		start = end
	}
	return cost, len(bounds), append([]int{}, cuts...)
}

// bruteForcePlan 枚举全部切点组合，按 (费用, 块数, 切点字典序) 取最优。
func bruteForcePlan(samples []int64) (minCost, minBlocks int, minCuts []int) {
	n := len(samples)
	minCost = math.MaxInt
	var recurse func(pos int, cuts []int, runLength int)
	recurse = func(pos int, cuts []int, runLength int) {
		if pos == n {
			if runLength == 0 || runLength > MaxSamplesPerBlock {
				return
			}
			cost, blocks, lex := evaluateCuts(samples, cuts)
			if cost < minCost ||
				(cost == minCost && blocks < minBlocks) ||
				(cost == minCost && blocks == minBlocks && cutsLexLess(lex, minCuts)) {
				minCost = cost
				minBlocks = blocks
				minCuts = append([]int{}, cuts...)
			}
			return
		}
		// pos 为已放置样本数；决定第 pos 个样本（下标 pos）如何归属。
		// 选项 A：并入当前块（块长未达上限时）。
		if runLength < MaxSamplesPerBlock {
			recurse(pos+1, cuts, runLength+1)
		}
		// 选项 B：在它之前开新块（切点为 pos），首块除外。
		if pos > 0 {
			recurse(pos+1, append(append([]int{}, cuts...), pos), 1)
		}
	}
	recurse(1, []int{}, 1) // 样本 0 固定属于首块
	return minCost, minBlocks, minCuts
}

func TestPlanMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	// 短列：全部切分参考，覆盖溢出差与非整字节填充。
	for trial := 0; trial < 400; trial++ {
		n := 1 + rng.Intn(10)
		samples := make([]int64, n)
		for i := range samples {
			switch rng.Intn(6) {
			case 0:
				samples[i] = math.MinInt64
			case 1:
				samples[i] = math.MaxInt64
			case 2:
				samples[i] = int64(rng.Intn(5)) // 小值，制造零位宽与窄位宽
			default:
				samples[i] = rng.Int63() - rng.Int63()
			}
		}

		plan := PlanBlocks(samples)
		wantCost, wantBlocks, wantCuts := bruteForcePlan(samples)

		if plan.TotalBytes() != wantCost {
			t.Fatalf("n=%d samples=%v cost=%d want=%d", n, samples, plan.TotalBytes(), wantCost)
		}
		if plan.BlockCount() != wantBlocks {
			t.Fatalf("n=%d blocks=%d want=%d", n, plan.BlockCount(), wantBlocks)
		}
		if !intsEqualInt(plan.Cuts, wantCuts) {
			t.Fatalf("n=%d cuts=%v want=%v", n, plan.Cuts, wantCuts)
		}

		// 方案必须连续覆盖整列且块长合法。
		assertPlanShape(t, samples, plan)
		// 费用证书逐字段自洽。
		assertCertificate(t, plan)

		// 端到端往返。
		encoded, err := EncodePlan(samples, plan)
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		if len(encoded) != wantCost {
			t.Fatalf("encoded len=%d want=%d", len(encoded), wantCost)
		}
		decoded, err := Decode(encoded)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		if !intsEqual(decoded, samples) {
			t.Fatalf("round trip mismatch: %d want %d", decoded, samples)
		}
	}
}

func TestPlanSingleSample(t *testing.T) {
	plan := PlanBlocks([]int64{123})
	if plan.BlockCount() != 1 || len(plan.Cuts) != 0 {
		t.Fatalf("single sample plan = %+v", plan)
	}
	block := plan.Blocks[0]
	if block.Width != 0 || block.Cost != blockOverhead {
		t.Fatalf("single block = %+v", block)
	}
}

func TestPlanMaxBlockBoundary(t *testing.T) {
	// 65 个恒等样本：单块上限 64，至少两块；恒等值 b=0。
	samples := make([]int64, 65)
	plan := PlanBlocks(samples)
	if plan.BlockCount() != 2 {
		t.Fatalf("blocks=%d want 2", plan.BlockCount())
	}
	// 所有 1+64 .. 64+1 切分费用相同、块数相同，字典序最小的首切点为 1。
	if plan.Cuts[0] != 1 {
		t.Fatalf("first cut=%d want 1", plan.Cuts[0])
	}
	for _, block := range plan.Blocks {
		if block.Width != 0 {
			t.Fatalf("width=%d want 0", block.Width)
		}
	}
}

func TestTieBreakFewerBlocksThenLex(t *testing.T) {
	// 构造费用并列场景，交由暴力参考断言裁决；此处再固定验证一条规则：
	// 同费用同块数时，首切点更小者字典序优先。
	samples := []int64{0, 0, 0, 0}
	plan := PlanBlocks(samples)
	_, _, wantCuts := bruteForcePlan(samples)
	if !intsEqualInt(plan.Cuts, wantCuts) {
		t.Fatalf("cuts=%v want=%v", plan.Cuts, wantCuts)
	}
}

func TestLargeColumnRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(77))
	samples := make([]int64, 500)
	prev := int64(0)
	for i := range samples {
		if i%37 == 0 {
			prev = rng.Int63() - rng.Int63()
		}
		samples[i] = prev
		prev += int64(rng.Intn(7) - 3)
	}
	plan := PlanBlocks(samples)
	assertPlanShape(t, samples, plan)
	encoded, _, err := EncodeColumn(samples)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(encoded) != plan.TotalBytes() {
		t.Fatalf("bytes=%d plan total=%d", len(encoded), plan.TotalBytes())
	}
	decoded, err := Decode(encoded)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !intsEqual(decoded, samples) {
		t.Fatal("large column round trip mismatch")
	}
}

func assertPlanShape(t *testing.T, samples []int64, plan Plan) {
	t.Helper()
	if len(plan.Blocks) == 0 {
		t.Fatal("empty plan for non-empty column")
	}
	start := 0
	for i, block := range plan.Blocks {
		if block.Start != start {
			t.Fatalf("block %d start=%d want %d", i, block.Start, start)
		}
		if block.End <= block.Start || block.End > len(samples) {
			t.Fatalf("block %d invalid range [%d,%d)", i, block.Start, block.End)
		}
		if block.Samples() > MaxSamplesPerBlock {
			t.Fatalf("block %d too large", i)
		}
		width := blockBitWidth(samples[block.Start:block.End])
		if width != block.Width {
			t.Fatalf("block %d width=%d recomputed=%d", i, block.Width, width)
		}
		if block.Cost != blockCost(width, block.Samples()) {
			t.Fatalf("block %d cost=%d recomputed=%d", i, block.Cost, blockCost(width, block.Samples()))
		}
		start = block.End
	}
	if start != len(samples) {
		t.Fatalf("plan ends at %d, want %d", start, len(samples))
	}
}

func assertCertificate(t *testing.T, plan Plan) {
	t.Helper()
	cert := plan.Certificate()
	if cert.BlockCount != len(plan.Blocks) {
		t.Fatalf("cert block count=%d want=%d", cert.BlockCount, len(plan.Blocks))
	}
	total := 0
	for i, item := range cert.Blocks {
		if item.Header != headerBytes || item.First != firstBytes {
			t.Fatalf("block %d fixed cost wrong: %+v", i, item)
		}
		if item.Total != item.Header+item.First+item.Payload {
			t.Fatalf("block %d total not self-consistent: %+v", i, item)
		}
		if item.Total != plan.Blocks[i].Cost {
			t.Fatalf("block %d cert total=%d plan cost=%d", i, item.Total, plan.Blocks[i].Cost)
		}
		total += item.Total
	}
	if total != cert.TotalBytes || total != plan.TotalBytes() {
		t.Fatalf("cert total=%d computed=%d plan=%d", cert.TotalBytes, total, plan.TotalBytes())
	}
}

func intsEqualInt(a, b []int) bool {
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
