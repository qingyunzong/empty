// Package genlog 生成随机合法库读日志，并提供单点破坏器用于验收。
package genlog

import (
	"fmt"
	"math/rand"
	"strconv"
	"strings"

	"libread/checker"
)

// MaxCap 是生成日志中上限的最大值（破坏器注入的超大额度远超此值）。
const MaxCap = 1000

// Generate 生成 steps 步随机合法日志。保证日志中至少存在一次完整的
// 申请-授予-释放生命周期，且结尾仍有在途授予，便于各类破坏器适用。
func Generate(rng *rand.Rand, steps int) []string {
	cap_ := 50 + rng.Intn(MaxCap-50)
	total := 0
	pending := map[string]int{}
	granted := map[string]int{}
	var closed []string // 已关闭、可复用开启新代际的票据
	nextID := 0
	fresh := func() string {
		id := fmt.Sprintf("T%d", nextID)
		nextID++
		return id
	}

	lines := []string{fmt.Sprintf("CAP %d", cap_)}

	keysOf := func(m map[string]int) []string {
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		return keys
	}
	closeTicket := func(id string) {
		closed = append(closed, id)
	}

	type action struct {
		weight int
		run    func()
	}

	for i := 0; i < steps; i++ {
		var acts []action

		acts = append(acts, action{3, func() {
			var id string
			if len(closed) > 0 && rng.Intn(2) == 0 {
				j := rng.Intn(len(closed))
				id = closed[j]
				closed = append(closed[:j], closed[j+1:]...)
			} else {
				id = fresh()
			}
			amt := 1 + rng.Intn(20)
			pending[id] = amt
			lines = append(lines, fmt.Sprintf("REQ %s %d", id, amt))
		}})

		if len(pending) > 0 {
			acts = append(acts, action{3, func() {
				var grantable []string
				for id, amt := range pending {
					if total+amt <= cap_ {
						grantable = append(grantable, id)
					}
				}
				if len(grantable) == 0 {
					return
				}
				id := grantable[rng.Intn(len(grantable))]
				total += pending[id]
				granted[id] = pending[id]
				delete(pending, id)
				lines = append(lines, "GRT "+id)
			}})
			acts = append(acts, action{1, func() {
				ids := keysOf(pending)
				id := ids[rng.Intn(len(ids))]
				delete(pending, id)
				closeTicket(id)
				lines = append(lines, "CXL "+id)
			}})
		}

		if len(granted) > 0 {
			acts = append(acts, action{2, func() {
				ids := keysOf(granted)
				id := ids[rng.Intn(len(ids))]
				total -= granted[id]
				delete(granted, id)
				closeTicket(id)
				lines = append(lines, "REL "+id)
			}})
		}

		acts = append(acts, action{1, func() {
			newCap := total + rng.Intn(MaxCap-total+1)
			cap_ = newCap
			lines = append(lines, fmt.Sprintf("CAP %d", cap_))
		}})

		sum := 0
		for _, a := range acts {
			sum += a.weight
		}
		roll := rng.Intn(sum)
		for _, a := range acts {
			if roll < a.weight {
				a.run()
				break
			}
			roll -= a.weight
		}
	}

	// 结尾：保证一个在途授予与一个完整生命周期（供破坏器取样）。
	if need := total + 10; cap_ < need {
		lines = append(lines, fmt.Sprintf("CAP %d", need))
	}
	a, b := fresh(), fresh()
	lines = append(lines,
		fmt.Sprintf("REQ %s 5", a), "GRT "+a,
		fmt.Sprintf("REQ %s 5", b), "GRT "+b, "REL "+b,
	)
	return lines
}

// Corruption 表示一种单点破坏：仅改动日志的一处。
type Corruption struct {
	Name string
	// Apply 返回破坏后的日志；ok 为 false 表示该破坏对本日志不适用。
	Apply func(lines []string, rng *rand.Rand) (out []string, ok bool)
}

func opOf(line string) string {
	f := strings.Fields(line)
	if len(f) == 0 {
		return ""
	}
	return f[0]
}

func ticketOf(line string) string {
	f := strings.Fields(line)
	if len(f) < 2 {
		return ""
	}
	return f[1]
}

func opIndices(lines []string, op string) []int {
	var idx []int
	for i, l := range lines {
		if opOf(l) == op {
			idx = append(idx, i)
		}
	}
	return idx
}

func insertAfter(lines []string, i int, extra ...string) []string {
	out := make([]string, 0, len(lines)+len(extra))
	out = append(out, lines[:i+1]...)
	out = append(out, extra...)
	out = append(out, lines[i+1:]...)
	return out
}

// nextMention 返回 lines 中 i 之后首条涉及票据 id 的行号，无则返回 -1。
func nextMention(lines []string, i int, id string) int {
	for j := i + 1; j < len(lines); j++ {
		if ticketOf(lines[j]) == id {
			return j
		}
	}
	return -1
}

// All 返回全部单点破坏器。
func All() []Corruption {
	return []Corruption{
		{
			Name: "重复释放",
			Apply: func(lines []string, rng *rand.Rand) ([]string, bool) {
				idx := opIndices(lines, "REL")
				if len(idx) == 0 {
					return nil, false
				}
				i := idx[rng.Intn(len(idx))]
				return insertAfter(lines, i, lines[i]), true
			},
		},
		{
			Name: "删除授予",
			Apply: func(lines []string, rng *rand.Rand) ([]string, bool) {
				var cand []int
				for _, i := range opIndices(lines, "GRT") {
					j := nextMention(lines, i, ticketOf(lines[i]))
					if j >= 0 && opOf(lines[j]) == "REL" {
						cand = append(cand, i)
					}
				}
				if len(cand) == 0 {
					return nil, false
				}
				i := cand[rng.Intn(len(cand))]
				out := make([]string, 0, len(lines)-1)
				out = append(out, lines[:i]...)
				out = append(out, lines[i+1:]...)
				return out, true
			},
		},
		{
			Name: "虚报申请额度",
			Apply: func(lines []string, rng *rand.Rand) ([]string, bool) {
				var cand []int
				for _, i := range opIndices(lines, "REQ") {
					j := nextMention(lines, i, ticketOf(lines[i]))
					if j >= 0 && opOf(lines[j]) == "GRT" {
						cand = append(cand, i)
					}
				}
				if len(cand) == 0 {
					return nil, false
				}
				i := cand[rng.Intn(len(cand))]
				out := append([]string(nil), lines...)
				out[i] = fmt.Sprintf("REQ %s %d", ticketOf(lines[i]), 1<<30)
				return out, true
			},
		},
		{
			Name: "上限低于在途",
			Apply: func(lines []string, rng *rand.Rand) ([]string, bool) {
				events, err := checker.Parse(strings.NewReader(strings.Join(lines, "\n")))
				if err != nil {
					return nil, false
				}
				c := checker.New()
				for _, ev := range events {
					if c.Apply(ev) != nil {
						return nil, false // 仅适用于合法日志
					}
				}
				if c.Total() == 0 {
					return nil, false
				}
				return append(append([]string(nil), lines...), "CAP 0"), true
			},
		},
		{
			Name: "释放陌生票据",
			Apply: func(lines []string, rng *rand.Rand) ([]string, bool) {
				maxID := -1
				for _, l := range lines {
					id := ticketOf(l)
					if n, err := strconv.Atoi(strings.TrimPrefix(id, "T")); err == nil && n > maxID {
						maxID = n
					}
				}
				ghost := fmt.Sprintf("T%d", maxID+1000)
				return append(append([]string(nil), lines...), "REL "+ghost), true
			},
		},
		{
			Name: "取消已授予",
			Apply: func(lines []string, rng *rand.Rand) ([]string, bool) {
				idx := opIndices(lines, "GRT")
				if len(idx) == 0 {
					return nil, false
				}
				i := idx[rng.Intn(len(idx))]
				return insertAfter(lines, i, "CXL "+ticketOf(lines[i])), true
			},
		},
		{
			Name: "重复申请",
			Apply: func(lines []string, rng *rand.Rand) ([]string, bool) {
				idx := opIndices(lines, "REQ")
				if len(idx) == 0 {
					return nil, false
				}
				i := idx[rng.Intn(len(idx))]
				return insertAfter(lines, i, lines[i]), true
			},
		},
	}
}

// Corrupt 随机选取一种适用的单点破坏并应用，返回破坏后的日志与破坏名。
func Corrupt(lines []string, rng *rand.Rand) (out []string, name string, ok bool) {
	cs := All()
	perm := rng.Perm(len(cs))
	for _, k := range perm {
		if bad, applied := cs[k].Apply(lines, rng); applied {
			return bad, cs[k].Name, true
		}
	}
	return nil, "", false
}
