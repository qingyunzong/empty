package main

import (
	"errors"
	"fmt"
	"sort"
)

// CoverTicket 把单程票/区间票/通票统一建模为"覆盖给定日集合、限购一次"的车票。
type CoverTicket struct {
	ID    string `json:"id"`
	Kind  string `json:"kind,omitempty"`
	Price int    `json:"price"`
	Days  []int  `json:"days"`
}

// CoverProblem 固定出行日 + 可选车票(最多 22 种)。
type CoverProblem struct {
	Days    []int
	Tickets []CoverTicket
}

// CoverCert 覆盖证书:每张出行日由哪张已购车票覆盖。
type CoverCert struct {
	Cost      int            `json:"cost"`
	Count     int            `json:"count"`
	TicketIDs []string       `json:"ticketIds"`
	DayCover  map[int]string `json:"dayCover"`
}

type coverSol struct {
	cost  int
	count int
	ids   []string // 升序
}

// 目标序:费用最小 → 票数最少 → ID 序列字典序最小。
func betterCover(a, b *coverSol) bool {
	if a.cost != b.cost {
		return a.cost < b.cost
	}
	if a.count != b.count {
		return a.count < b.count
	}
	for i := range a.ids {
		if a.ids[i] != b.ids[i] {
			return a.ids[i] < b.ids[i]
		}
	}
	return false
}

// prepCover 校验输入,按 ID 排序车票,并把出行日映射为位掩码。
func prepCover(p CoverProblem) (req uint64, masks []uint64, prices []int, ids []string, dayIndex map[int]int, err error) {
	if len(p.Days) == 0 {
		return 0, nil, nil, nil, nil, errors.New("出行日集合为空")
	}
	if len(p.Days) > 64 {
		return 0, nil, nil, nil, nil, fmt.Errorf("出行日种类过多: %d > 64", len(p.Days))
	}
	if len(p.Tickets) == 0 {
		return 0, nil, nil, nil, nil, errors.New("车票列表为空")
	}
	if len(p.Tickets) > 22 {
		return 0, nil, nil, nil, nil, fmt.Errorf("车票种类过多: %d > 22", len(p.Tickets))
	}
	days := append([]int(nil), p.Days...)
	sort.Ints(days)
	dayIndex = make(map[int]int, len(days))
	for i, d := range days {
		if i > 0 && d == days[i-1] {
			return 0, nil, nil, nil, nil, fmt.Errorf("出行日重复: %d", d)
		}
		dayIndex[d] = i
		req |= 1 << uint(i)
	}
	ts := append([]CoverTicket(nil), p.Tickets...)
	sort.Slice(ts, func(i, j int) bool { return ts[i].ID < ts[j].ID })
	seen := make(map[string]bool, len(ts))
	for _, t := range ts {
		if t.ID == "" {
			return 0, nil, nil, nil, nil, errors.New("车票 ID 不能为空")
		}
		if seen[t.ID] {
			return 0, nil, nil, nil, nil, fmt.Errorf("车票 ID 重复: %s", t.ID)
		}
		seen[t.ID] = true
		if t.Price < 0 {
			return 0, nil, nil, nil, nil, fmt.Errorf("车票 %s 价格为负", t.ID)
		}
		var m uint64
		for _, d := range t.Days {
			if idx, ok := dayIndex[d]; ok {
				m |= 1 << uint(idx)
			}
		}
		masks = append(masks, m)
		prices = append(prices, t.Price)
		ids = append(ids, t.ID)
	}
	return req, masks, prices, ids, dayIndex, nil
}

// solveCoverBB 分支定界:包含/排除每张票,利用后缀并集与当前最优剪枝。
func solveCoverBB(req uint64, masks []uint64, prices []int, ids []string) *coverSol {
	n := len(masks)
	suffix := make([]uint64, n+1)
	for i := n - 1; i >= 0; i-- {
		suffix[i] = suffix[i+1] | masks[i]
	}
	var best *coverSol
	chosen := make([]int, 0, n)
	var rec func(i int, covered uint64, cost int)
	rec = func(i int, covered uint64, cost int) {
		if covered&req == req {
			s := &coverSol{cost: cost, count: len(chosen), ids: make([]string, 0, len(chosen))}
			for _, idx := range chosen {
				s.ids = append(s.ids, ids[idx])
			}
			if best == nil || betterCover(s, best) {
				best = s
			}
			return
		}
		if i == n {
			return
		}
		need := req &^ covered
		if suffix[i]&need != need {
			return // 剩余车票全部买下也覆盖不了
		}
		if best != nil && (cost > best.cost || (cost == best.cost && len(chosen) >= best.count)) {
			return // 费用或票数已不可能更优
		}
		chosen = append(chosen, i)
		rec(i+1, covered|masks[i], cost+prices[i])
		chosen = chosen[:len(chosen)-1]
		rec(i+1, covered, cost)
	}
	rec(0, 0, 0)
	return best
}

func buildCoverCert(sol *coverSol, masks []uint64, ids []string, dayIndex map[int]int, days []int) *CoverCert {
	cert := &CoverCert{
		Cost:      sol.cost,
		Count:     sol.count,
		TicketIDs: append([]string(nil), sol.ids...),
		DayCover:  make(map[int]string, len(days)),
	}
	chosenIdx := make([]int, len(sol.ids))
	for pos, id := range sol.ids {
		for i, tid := range ids {
			if tid == id {
				chosenIdx[pos] = i
				break
			}
		}
	}
	for _, d := range days {
		bit := uint64(1) << uint(dayIndex[d])
		for _, idx := range chosenIdx { // 按 ID 升序,取第一张覆盖该日的票
			if masks[idx]&bit != 0 {
				cert.DayCover[d] = ids[idx]
				break
			}
		}
	}
	return cert
}

// SolveCover 求覆盖全部出行日的最优购票组合。
func SolveCover(p CoverProblem) (*CoverCert, error) {
	req, masks, prices, ids, dayIndex, err := prepCover(p)
	if err != nil {
		return nil, err
	}
	sol := solveCoverBB(req, masks, prices, ids)
	if sol == nil {
		return nil, errors.New("不可行: 所有车票的覆盖日并集无法覆盖全部出行日")
	}
	return buildCoverCert(sol, masks, ids, dayIndex, p.Days), nil
}

// BruteForceCover 穷举全部 2^n 个购票子集核验最优解,返回最优证书与枚举的子集数。
func BruteForceCover(p CoverProblem) (*CoverCert, int, error) {
	req, masks, prices, ids, dayIndex, err := prepCover(p)
	if err != nil {
		return nil, 0, err
	}
	n := len(masks)
	total := 1 << uint(n)
	var best *coverSol
	for m := 0; m < total; m++ {
		var cov uint64
		cost, cnt := 0, 0
		for i := 0; i < n; i++ {
			if m>>uint(i)&1 == 1 {
				cov |= masks[i]
				cost += prices[i]
				cnt++
			}
		}
		if cov&req != req {
			continue
		}
		s := &coverSol{cost: cost, count: cnt, ids: make([]string, 0, cnt)}
		for i := 0; i < n; i++ {
			if m>>uint(i)&1 == 1 {
				s.ids = append(s.ids, ids[i])
			}
		}
		if best == nil || betterCover(s, best) {
			best = s
		}
	}
	if best == nil {
		return nil, total, errors.New("不可行: 所有车票的覆盖日并集无法覆盖全部出行日")
	}
	return buildCoverCert(best, masks, ids, dayIndex, p.Days), total, nil
}

// VerifyCover 校验覆盖证书:购票集合合法、费用一致、每个出行日都被所列车票覆盖。
func VerifyCover(p CoverProblem, c *CoverCert) error {
	_, masks, prices, ids, dayIndex, err := prepCover(p)
	if err != nil {
		return err
	}
	idxOf := make(map[string]int, len(ids))
	for i, id := range ids {
		idxOf[id] = i
	}
	if len(c.TicketIDs) != c.Count {
		return fmt.Errorf("证书票数 %d 与购票列表长度 %d 不一致", c.Count, len(c.TicketIDs))
	}
	chosen := make(map[string]bool, len(c.TicketIDs))
	cost := 0
	for _, id := range c.TicketIDs {
		idx, ok := idxOf[id]
		if !ok {
			return fmt.Errorf("证书包含未知车票: %s", id)
		}
		if chosen[id] {
			return fmt.Errorf("车票 %s 被重复购买(每票限购一次)", id)
		}
		chosen[id] = true
		cost += prices[idx]
	}
	if cost != c.Cost {
		return fmt.Errorf("证书费用 %d 与购票总价 %d 不一致", c.Cost, cost)
	}
	if len(c.DayCover) != len(p.Days) {
		return fmt.Errorf("证书覆盖天数 %d 与出行日数 %d 不一致", len(c.DayCover), len(p.Days))
	}
	for _, d := range p.Days {
		id, ok := c.DayCover[d]
		if !ok {
			return fmt.Errorf("出行日 %d 未被覆盖", d)
		}
		idx, ok := idxOf[id]
		if !ok || !chosen[id] {
			return fmt.Errorf("出行日 %d 使用了未购买的车票 %s", d, id)
		}
		if masks[idx]&(uint64(1)<<uint(dayIndex[d])) == 0 {
			return fmt.Errorf("车票 %s 并不覆盖出行日 %d", id, d)
		}
	}
	for d := range c.DayCover {
		if _, ok := dayIndex[d]; !ok {
			return fmt.Errorf("证书包含非出行日 %d", d)
		}
	}
	return nil
}
