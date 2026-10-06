package main

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// ActTicket 乘车触发激活的车票:首次乘车日激活,激活后 ValidDays 天有效,
// 有效期内最多使用 MaxUses 天(覆盖上限),每票限购一次。
type ActTicket struct {
	ID        string `json:"id"`
	Kind      string `json:"kind,omitempty"`
	Price     int    `json:"price"`
	ValidDays int    `json:"validDays"`
	MaxUses   int    `json:"maxUses"`
}

// ActProblem 固定出行日序列 + 可激活车票。
type ActProblem struct {
	Days    []int
	Tickets []ActTicket
}

// ActCert 逐日使用证书:每天使用哪张票、每张票何时激活。
type ActCert struct {
	Cost       int            `json:"cost"`
	Count      int            `json:"count"`
	TicketIDs  []string       `json:"ticketIds"`
	ActivateOn map[string]int `json:"activateOn"`
	DayUse     map[int]string `json:"dayUse"`
}

type actEntry struct{ idx, expiry, left int }

type actPlan struct {
	cost  int
	count int
	ids   []string // 升序
	use   []int    // 每个剩余出行日使用的车票下标
}

// 目标序:费用最小 → 票数最少 → ID 序列最小 → 逐日使用序列最小(保证唯一解)。
func betterActPlan(a, b *actPlan) bool {
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
	for i := range a.use {
		if a.use[i] != b.use[i] {
			return a.use[i] < b.use[i]
		}
	}
	return false
}

func prepAct(p ActProblem) (days []int, prices, valid, uses []int, ids []string, err error) {
	if len(p.Days) == 0 {
		return nil, nil, nil, nil, nil, errors.New("出行日集合为空")
	}
	if len(p.Days) > 64 {
		return nil, nil, nil, nil, nil, fmt.Errorf("出行日过多: %d > 64", len(p.Days))
	}
	if len(p.Tickets) == 0 {
		return nil, nil, nil, nil, nil, errors.New("车票列表为空")
	}
	if len(p.Tickets) > 22 {
		return nil, nil, nil, nil, nil, fmt.Errorf("车票种类过多: %d > 22", len(p.Tickets))
	}
	days = append([]int(nil), p.Days...)
	sort.Ints(days)
	for i, d := range days {
		if i > 0 && d == days[i-1] {
			return nil, nil, nil, nil, nil, fmt.Errorf("出行日重复: %d", d)
		}
	}
	ts := append([]ActTicket(nil), p.Tickets...)
	sort.Slice(ts, func(i, j int) bool { return ts[i].ID < ts[j].ID })
	seen := make(map[string]bool, len(ts))
	for _, t := range ts {
		if t.ID == "" {
			return nil, nil, nil, nil, nil, errors.New("车票 ID 不能为空")
		}
		if seen[t.ID] {
			return nil, nil, nil, nil, nil, fmt.Errorf("车票 ID 重复: %s", t.ID)
		}
		seen[t.ID] = true
		if t.Price < 0 {
			return nil, nil, nil, nil, nil, fmt.Errorf("车票 %s 价格为负", t.ID)
		}
		if t.ValidDays < 1 {
			return nil, nil, nil, nil, nil, fmt.Errorf("车票 %s 有效天数必须 >= 1", t.ID)
		}
		if t.MaxUses < 1 {
			return nil, nil, nil, nil, nil, fmt.Errorf("车票 %s 覆盖上限必须 >= 1", t.ID)
		}
		prices = append(prices, t.Price)
		valid = append(valid, t.ValidDays)
		uses = append(uses, t.MaxUses)
		ids = append(ids, t.ID)
	}
	return days, prices, valid, uses, ids, nil
}

func actKey(i int, used uint32, act []actEntry) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d|%d|", i, used)
	for _, a := range act {
		fmt.Fprintf(&b, "%d,%d,%d;", a.idx, a.expiry, a.left)
	}
	return b.String()
}

func insertEntry(act []actEntry, e actEntry) []actEntry {
	out := make([]actEntry, 0, len(act)+1)
	inserted := false
	for _, a := range act {
		if !inserted && e.idx < a.idx {
			out = append(out, e)
			inserted = true
		}
		out = append(out, a)
	}
	if !inserted {
		out = append(out, e)
	}
	return out
}

func decEntry(act []actEntry, k int) []actEntry {
	out := make([]actEntry, len(act))
	copy(out, act)
	out[k].left--
	return out
}

func insertString(sorted []string, s string) []string {
	out := make([]string, 0, len(sorted)+1)
	inserted := false
	for _, v := range sorted {
		if !inserted && s < v {
			out = append(out, s)
			inserted = true
		}
		out = append(out, v)
	}
	if !inserted {
		out = append(out, s)
	}
	return out
}

// solveAct 记忆化搜索:按时间顺序处理出行日,每天选择使用已激活车票或激活一张新票。
// 状态 = (天数下标, 已购票集合, 已激活车票的(有效期至, 剩余次数)),未来最优与历史无关,可安全记忆化。
func solveAct(days, prices, valid, uses []int, ids []string) *actPlan {
	n := len(ids)
	type result struct{ plan *actPlan }
	memo := make(map[string]result)
	var f func(i int, used uint32, act []actEntry) *actPlan
	f = func(i int, used uint32, act []actEntry) *actPlan {
		if i == len(days) {
			return &actPlan{}
		}
		d := days[i]
		filt := make([]actEntry, 0, len(act))
		for _, a := range act {
			if a.expiry >= d && a.left > 0 {
				filt = append(filt, a)
			}
		}
		act = filt
		key := actKey(i, used, act)
		if r, ok := memo[key]; ok {
			return r.plan
		}
		var best *actPlan
		consider := func(p *actPlan) {
			if p != nil && (best == nil || betterActPlan(p, best)) {
				best = p
			}
		}
		// 选择一:使用一张已激活且当日有效、剩余次数充足的车票。
		for k, a := range act {
			sub := f(i+1, used, decEntry(act, k))
			if sub == nil {
				continue
			}
			consider(&actPlan{
				cost:  sub.cost,
				count: sub.count,
				ids:   sub.ids,
				use:   append([]int{a.idx}, sub.use...),
			})
		}
		// 选择二:激活一张未购买的车票(当日首次乘车即激活)。
		for t := 0; t < n; t++ {
			if used>>uint(t)&1 == 1 {
				continue
			}
			newAct := insertEntry(act, actEntry{idx: t, expiry: d + valid[t] - 1, left: uses[t] - 1})
			sub := f(i+1, used|1<<uint(t), newAct)
			if sub == nil {
				continue
			}
			consider(&actPlan{
				cost:  sub.cost + prices[t],
				count: sub.count + 1,
				ids:   insertString(sub.ids, ids[t]),
				use:   append([]int{t}, sub.use...),
			})
		}
		memo[key] = result{best}
		return best
	}
	return f(0, 0, nil)
}

func buildActCert(plan *actPlan, days []int, ids []string) *ActCert {
	cert := &ActCert{
		Cost:       plan.cost,
		Count:      plan.count,
		TicketIDs:  append([]string(nil), plan.ids...),
		ActivateOn: make(map[string]int, plan.count),
		DayUse:     make(map[int]string, len(days)),
	}
	usedDays := make(map[int][]int)
	for k, tidx := range plan.use {
		d := days[k]
		cert.DayUse[d] = ids[tidx]
		usedDays[tidx] = append(usedDays[tidx], d)
	}
	for tidx, ds := range usedDays {
		cert.ActivateOn[ids[tidx]] = ds[0] // days 升序,首次使用日即激活日
	}
	return cert
}

// SolveActivate 求购票与激活的联合最优方案。
func SolveActivate(p ActProblem) (*ActCert, error) {
	days, prices, valid, uses, ids, err := prepAct(p)
	if err != nil {
		return nil, err
	}
	plan := solveAct(days, prices, valid, uses, ids)
	if plan == nil {
		return nil, errors.New("不可行: 现有车票的有效期与覆盖上限无法覆盖全部出行日")
	}
	return buildActCert(plan, days, ids), nil
}

// BruteForceActivate 短行程穷举核验:枚举全部购票子集 × 全部逐日分配方案
// (分配方案隐含了每张票的激活时刻=其首个使用日),返回最优证书与检查过的方案数。
func BruteForceActivate(p ActProblem) (*ActCert, int64, error) {
	days, prices, valid, uses, ids, err := prepAct(p)
	if err != nil {
		return nil, 0, err
	}
	n, d := len(ids), len(days)
	var best *actPlan
	var checked int64
	total := 1 << uint(n)
	for m := 1; m < total; m++ {
		var sub []int
		cost := 0
		for t := 0; t < n; t++ {
			if m>>uint(t)&1 == 1 {
				sub = append(sub, t)
				cost += prices[t]
			}
		}
		if best != nil && (cost > best.cost || (cost == best.cost && len(sub) >= best.count)) {
			continue
		}
		k := len(sub)
		assign := make([]int, d) // assign[j] ∈ [0,k):第 j 个出行日使用子集中第几张票
		for {
			checked++
			cnt := make([]int, k)
			mn := make([]int, k)
			mx := make([]int, k)
			for j := 0; j < d; j++ {
				a := assign[j]
				if cnt[a] == 0 {
					mn[a], mx[a] = days[j], days[j]
				} else {
					if days[j] < mn[a] {
						mn[a] = days[j]
					}
					if days[j] > mx[a] {
						mx[a] = days[j]
					}
				}
				cnt[a]++
			}
			ok := true
			for j := 0; j < k; j++ {
				if cnt[j] == 0 {
					continue // 未使用的票仅增加费用/票数,不可能最优,但保留以保证穷举完备
				}
				t := sub[j]
				if cnt[j] > uses[t] || mx[j]-mn[j] > valid[t]-1 {
					ok = false
					break
				}
			}
			if ok {
				plan := &actPlan{cost: cost, count: k, use: make([]int, d)}
				for _, t := range sub {
					plan.ids = append(plan.ids, ids[t])
				}
				for j := 0; j < d; j++ {
					plan.use[j] = sub[assign[j]]
				}
				if best == nil || betterActPlan(plan, best) {
					best = plan
				}
			}
			pos := d - 1
			for pos >= 0 {
				assign[pos]++
				if assign[pos] < k {
					break
				}
				assign[pos] = 0
				pos--
			}
			if pos < 0 {
				break
			}
		}
	}
	if best == nil {
		return nil, checked, errors.New("不可行: 现有车票的有效期与覆盖上限无法覆盖全部出行日")
	}
	return buildActCert(best, days, ids), checked, nil
}

// VerifyActivate 校验逐日使用证书:购票集合、费用、激活日、有效期窗口与覆盖上限。
func VerifyActivate(p ActProblem, c *ActCert) error {
	days, prices, valid, uses, ids, err := prepAct(p)
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
	if len(c.DayUse) != len(days) {
		return fmt.Errorf("证书使用天数 %d 与出行日数 %d 不一致", len(c.DayUse), len(days))
	}
	daySet := make(map[int]bool, len(days))
	for _, d := range days {
		daySet[d] = true
	}
	perTicket := make(map[int][]int)
	for d, id := range c.DayUse {
		if !daySet[d] {
			return fmt.Errorf("证书包含非出行日 %d", d)
		}
		idx, ok := idxOf[id]
		if !ok || !chosen[id] {
			return fmt.Errorf("出行日 %d 使用了未购买的车票 %s", d, id)
		}
		perTicket[idx] = append(perTicket[idx], d)
	}
	for _, d := range days {
		if _, ok := c.DayUse[d]; !ok {
			return fmt.Errorf("出行日 %d 未被覆盖", d)
		}
	}
	for _, id := range c.TicketIDs {
		idx := idxOf[id]
		ds := perTicket[idx]
		if len(ds) == 0 {
			return fmt.Errorf("车票 %s 已购买但从未使用", id)
		}
		mn, mx := ds[0], ds[0]
		for _, d := range ds[1:] {
			if d < mn {
				mn = d
			}
			if d > mx {
				mx = d
			}
		}
		if act, ok := c.ActivateOn[id]; !ok || act != mn {
			return fmt.Errorf("车票 %s 激活日应为首次乘车日 %d,证书为 %v", id, mn, c.ActivateOn[id])
		}
		if mx-mn > valid[idx]-1 {
			return fmt.Errorf("车票 %s 使用跨度 %d 天超出激活后有效期 %d 天", id, mx-mn+1, valid[idx])
		}
		if len(ds) > uses[idx] {
			return fmt.Errorf("车票 %s 使用 %d 天超出覆盖上限 %d", id, len(ds), uses[idx])
		}
	}
	for id := range c.ActivateOn {
		if !chosen[id] {
			return fmt.Errorf("证书为未购车票 %s 记录了激活日", id)
		}
	}
	return nil
}
