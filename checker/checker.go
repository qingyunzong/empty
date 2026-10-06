// Package checker 按票据代际重建库读日志状态并校验不变量。
//
// 日志为行格式（空行与 # 开头的注释行被忽略）：
//
//	CAP <n>            调整当刻上限为 n（n >= 0）
//	REQ <ticket> <n>   申请：为票据开启新一代，申请 n 份额度（n > 0）
//	GRT <ticket>       授予：将申请中的票据授予，计入在途授予总额
//	CXL <ticket>       取消：仅对未授予的票据有效，取消不释放任何额度
//	REL <ticket>       释放：释放已授予的票据；重复释放报错
//
// 不变量：任意时刻在途授予总额不得超过当刻上限。
package checker

import (
	"bufio"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// Op 是日志事件的操作类型。
type Op int

const (
	OpCap Op = iota
	OpReq
	OpGrt
	OpCxl
	OpRel
)

// Event 是一条解析后的日志事件，Line 为 1 起始的原始行号。
type Event struct {
	Line   int
	Op     Op
	Ticket string
	Amount int
	Raw    string
}

func (e Event) String() string { return fmt.Sprintf("L%d %s", e.Line, e.Raw) }

// 票据生命周期状态。
const (
	stNone = iota
	stRequested
	stGranted
)

// 上一代关闭方式。
const (
	closeNever = iota
	closeCanceled
	closeReleased
)

type ticket struct {
	state     int
	amount    int
	gen       int // 当前代际，REQ 开启新一代
	lastClose int
	history   []Event // 跨代际的完整事件历史，用于因果链
}

// Violation 是检查中发现的首个错误，Chain 为完整因果链。
type Violation struct {
	Line  int
	Msg   string
	Chain []string
}

func (v *Violation) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "L%d: %s", v.Line, v.Msg)
	if len(v.Chain) > 0 {
		b.WriteString("\n因果链:")
		for _, c := range v.Chain {
			b.WriteString("\n  " + c)
		}
	}
	return b.String()
}

// Parse 解析日志文本为事件序列；语法错误直接报错并注明行号。
func Parse(r io.Reader) ([]Event, error) {
	var events []Event
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		raw := strings.TrimSpace(sc.Text())
		if raw == "" || strings.HasPrefix(raw, "#") {
			continue
		}
		fields := strings.Fields(raw)
		ev := Event{Line: lineNo, Raw: raw}
		bad := func(format string, args ...any) ([]Event, error) {
			return nil, fmt.Errorf("L%d: %s", lineNo, fmt.Sprintf(format, args...))
		}
		switch strings.ToUpper(fields[0]) {
		case "CAP":
			if len(fields) != 2 {
				return bad("CAP 需要 1 个参数: %q", raw)
			}
			n, err := strconv.Atoi(fields[1])
			if err != nil || n < 0 {
				return bad("CAP 上限非法: %q", fields[1])
			}
			ev.Op, ev.Amount = OpCap, n
		case "REQ":
			if len(fields) != 3 {
				return bad("REQ 需要 2 个参数: %q", raw)
			}
			n, err := strconv.Atoi(fields[2])
			if err != nil || n <= 0 {
				return bad("REQ 额度必须为正整数: %q", fields[2])
			}
			ev.Op, ev.Ticket, ev.Amount = OpReq, fields[1], n
		case "GRT", "CXL", "REL":
			if len(fields) != 2 {
				return bad("%s 需要 1 个参数: %q", fields[0], raw)
			}
			ev.Ticket = fields[1]
			switch fields[0] {
			case "GRT":
				ev.Op = OpGrt
			case "CXL":
				ev.Op = OpCxl
			default:
				ev.Op = OpRel
			}
		default:
			return bad("未知操作 %q", fields[0])
		}
		events = append(events, ev)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return events, nil
}

// Checker 按事件顺序重建状态并校验不变量。
type Checker struct {
	cap        int
	total      int
	tickets    map[string]*ticket
	outGrant   map[string]Event // 当前在途授予：票据 -> 其 GRT 事件
	capHistory []Event
}

func New() *Checker {
	return &Checker{
		tickets:  make(map[string]*ticket),
		outGrant: make(map[string]Event),
	}
}

// Total 返回当刻在途授予总额。
func (c *Checker) Total() int { return c.total }

// Cap 返回当刻上限。
func (c *Checker) Cap() int { return c.cap }

// Apply 应用一条事件；若违反规则或不变量，返回首个错误（含因果链）。
func (c *Checker) Apply(ev Event) *Violation {
	switch ev.Op {
	case OpCap:
		if ev.Amount < c.total {
			return c.capViolation(ev,
				fmt.Sprintf("上限降为 %d，低于当刻在途授予总额 %d", ev.Amount, c.total))
		}
		c.cap = ev.Amount
		c.capHistory = append(c.capHistory, ev)
		return nil
	}

	t := c.tickets[ev.Ticket]
	if t == nil && ev.Op == OpReq {
		t = &ticket{}
		c.tickets[ev.Ticket] = t
	}

	switch ev.Op {
	case OpReq:
		if t.state != stNone {
			return c.ticketViolation(ev, t,
				fmt.Sprintf("票据 %s 第 %d 代尚未关闭，重复申请", ev.Ticket, t.gen))
		}
		t.gen++
		t.state = stRequested
		t.amount = ev.Amount
		t.lastClose = closeNever
		t.history = append(t.history, ev)

	case OpGrt:
		if t == nil || t.state == stNone {
			return c.ticketViolation(ev, t,
				fmt.Sprintf("票据 %s 未申请，不能授予", ev.Ticket))
		}
		if t.state == stGranted {
			return c.ticketViolation(ev, t,
				fmt.Sprintf("票据 %s 第 %d 代已授予，重复授予", ev.Ticket, t.gen))
		}
		if c.total+t.amount > c.cap {
			return c.capViolation(ev,
				fmt.Sprintf("授予票据 %s（%d 份）后在途总额 %d 超出当刻上限 %d",
					ev.Ticket, t.amount, c.total+t.amount, c.cap))
		}
		t.state = stGranted
		c.total += t.amount
		c.outGrant[ev.Ticket] = ev
		t.history = append(t.history, ev)

	case OpCxl:
		if t == nil || t.state == stNone {
			return c.ticketViolation(ev, t,
				fmt.Sprintf("票据 %s 无在册申请，不能取消", ev.Ticket))
		}
		if t.state == stGranted {
			return c.ticketViolation(ev, t,
				fmt.Sprintf("票据 %s 第 %d 代已授予，取消不释放，须用 REL 释放", ev.Ticket, t.gen))
		}
		// 取消未授予：仅撤销申请，不释放任何额度。
		t.state = stNone
		t.lastClose = closeCanceled
		t.history = append(t.history, ev)

	case OpRel:
		if t == nil {
			return c.ticketViolation(ev, nil,
				fmt.Sprintf("票据 %s 从未申请，不能释放", ev.Ticket))
		}
		switch t.state {
		case stGranted:
			t.state = stNone
			t.lastClose = closeReleased
			c.total -= t.amount
			delete(c.outGrant, ev.Ticket)
			t.history = append(t.history, ev)
		case stRequested:
			return c.ticketViolation(ev, t,
				fmt.Sprintf("票据 %s 第 %d 代尚未授予，不能释放", ev.Ticket, t.gen))
		default:
			if t.lastClose == closeReleased {
				return c.ticketViolation(ev, t,
					fmt.Sprintf("票据 %s 第 %d 代已释放，重复释放", ev.Ticket, t.gen))
			}
			return c.ticketViolation(ev, t,
				fmt.Sprintf("票据 %s 第 %d 代已取消，不能释放", ev.Ticket, t.gen))
		}
	}
	return nil
}

// ticketViolation 生成票据类错误，因果链为该票据跨代际的完整历史。
func (c *Checker) ticketViolation(ev Event, t *ticket, msg string) *Violation {
	var chain []string
	if t != nil {
		for _, h := range t.history {
			chain = append(chain, "票据 "+ev.Ticket+": "+h.String())
		}
	}
	chain = append(chain, "触发: "+ev.String())
	return &Violation{Line: ev.Line, Msg: msg, Chain: chain}
}

// capViolation 生成上限类错误，因果链为上限变迁、全部在途授予与触发事件。
func (c *Checker) capViolation(ev Event, msg string) *Violation {
	var chain []string
	for _, h := range c.capHistory {
		chain = append(chain, "上限变迁: "+h.String())
	}
	ids := make([]string, 0, len(c.outGrant))
	for id := range c.outGrant {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		chain = append(chain, "在途授予: "+c.outGrant[id].String())
	}
	chain = append(chain, "触发: "+ev.String())
	return &Violation{Line: ev.Line, Msg: msg, Chain: chain}
}

// CheckEvents 顺序应用全部事件，返回首个错误；全部合法则返回 nil。
func CheckEvents(events []Event) *Violation {
	c := New()
	for _, ev := range events {
		if v := c.Apply(ev); v != nil {
			return v
		}
	}
	return nil
}
