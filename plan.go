package dataeng

// BlockPlan 描述一个连续块的规划结果。
type BlockPlan struct {
	// Start 与 End 是样本列中的半开区间下标 [Start, End)，Start < End。
	Start int
	End   int
	// Width 是该块差值的统一位宽 b（0..65）。
	Width int
	// Cost 是该块编码后的字节数，含 2 字节头、8 字节首值与差值负载。
	Cost int
}

// Samples 返回块内样本数。
func (p BlockPlan) Samples() int { return p.End - p.Start }

// BlockCost 是单块费用证书，逐字段给出字节数构成以便独立复核。
type BlockCost struct {
	Header  int // 固定 2 字节
	First   int // 固定 8 字节首值
	Payload int // 差值负载 ceil(b*(n-1)/8) 字节
	Total   int // 三项之和
}

// CostCertificate 是整列规划的费用证书：各项相加应等于总字节数。
type CostCertificate struct {
	Blocks     []BlockCost
	BlockCount int // 块数（空列为 0）
	TotalBytes int // 所有块 Total 之和
}

// Plan 是整列的最优连续分块方案。空列产生零块、零字节方案。
type Plan struct {
	Blocks []BlockPlan
	// Cuts 是块切点下标列表，即除列尾 n 之外的各块 End；无切点时为空切片。
	Cuts []int
}

// TotalBytes 返回方案的总编码字节数。
func (p Plan) TotalBytes() int {
	total := 0
	for _, block := range p.Blocks {
		total += block.Cost
	}
	return total
}

// BlockCount 返回块数。
func (p Plan) BlockCount() int { return len(p.Blocks) }

// Certificate 逐块列出费用构成，并汇总块数与总字节数。
func (p Plan) Certificate() CostCertificate {
	cert := CostCertificate{
		Blocks:     make([]BlockCost, len(p.Blocks)),
		BlockCount: len(p.Blocks),
	}
	for i, block := range p.Blocks {
		item := BlockCost{
			Header:  headerBytes,
			First:   firstBytes,
			Payload: blockPayloadBytes(block.Width, block.Samples()),
		}
		item.Total = item.Header + item.First + item.Payload
		cert.Blocks[i] = item
		cert.TotalBytes += item.Total
	}
	return cert
}

// planState 保存完整切点列表以支持字典序裁决。
type planState struct {
	cost   int
	blocks int
	width  int
	cuts   []int // 含各块 End，不含当前前缀长度 n
}

// stateBetter 实现 (费用, 块数, 切点字典序) 的严格序。
func stateBetter(a, b planState) bool {
	if a.cost != b.cost {
		return a.cost < b.cost
	}
	if a.blocks != b.blocks {
		return a.blocks < b.blocks
	}
	return cutsLexLess(a.cuts, b.cuts)
}

// cutsLexLess 比较两个等长（块数相同）切点列表的字典序：首位较小者胜。
func cutsLexLess(a, b []int) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// PlanBlocks 求总编码字节最少的连续分块。
//
// 约束：每块 1..64 条样本。目标依次为
//  1. 总编码字节最少；
//  2. 费用并列时块数最少；
//  3. 仍并列时切点列表字典序最小。
//
// 空列返回零块方案。
func PlanBlocks(samples []int64) Plan {
	n := len(samples)
	if n == 0 {
		return Plan{Blocks: []BlockPlan{}, Cuts: []int{}}
	}

	// dp[i] 为前缀 samples[:i] 的最优状态；dp[0] 为空前缀哨兵。
	dp := make([]planState, n+1)
	dp[0] = planState{cuts: []int{}}
	for i := 1; i <= n; i++ {
		dp[i] = planState{cost: -1}
	}

	for end := 1; end <= n; end++ {
		width := 0
		// start 从 end-1 向下扩展；差值 samples[start]-samples[start-1]
		// 在每次迭代开头纳入，维护块内最大位宽。
		for start := end - 1; start >= 0 && end-start <= MaxSamplesPerBlock; start-- {
			if start < end-1 {
				d, ok := intDelta(samples[start], samples[start+1])
				w := MaxBitWidth
				if ok {
					w = deltaBitWidth(d)
				}
				if w > width {
					width = w
				}
			}
			sampleCount := end - start
			cost := blockCost(width, sampleCount)
			prefix := dp[start]
			candidate := planState{
				cost:   prefix.cost + cost,
				blocks: prefix.blocks + 1,
				width:  width,
				cuts:   append(append([]int{}, prefix.cuts...), end),
			}
			// 切点列表不含列尾 end 本身作为“内部切点”：当 end==n 时它是列尾，
			// 但 DP 中间状态需要它继续向后比较，最后统一剔除列尾。
			if dp[end].cost < 0 || stateBetter(candidate, dp[end]) {
				dp[end] = candidate
			}
		}
	}

	final := dp[n]
	// 剔除列尾切点 n，得到内部切点列表。
	cuts := make([]int, 0, len(final.cuts))
	for _, cut := range final.cuts {
		if cut != n {
			cuts = append(cuts, cut)
		}
	}

	bounds := append(append([]int{}, cuts...), n)
	blocks := make([]BlockPlan, 0, len(bounds))
	start := 0
	for _, end := range bounds {
		width := blockBitWidth(samples[start:end])
		blocks = append(blocks, BlockPlan{
			Start: start,
			End:   end,
			Width: width,
			Cost:  blockCost(width, end-start),
		})
		start = end
	}
	return Plan{Blocks: blocks, Cuts: cuts}
}
