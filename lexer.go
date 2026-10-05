// Package streamlex 提供基于有限自动机（DFA）表的流式词法分析器。
//
// 多条规则竞争时采用最长匹配；长度相同则按规则声明顺序优先。
// 输入按块（chunk）喂入：块尾的匹配仍可能随后续输入延长，因此
// 只有当所有自动机都走入死状态（匹配不可能再延长），或收到 End
// 结束信号时，才能确定并发出 token。结束信号才确定尾项。
package streamlex

import (
	"errors"
	"fmt"
)

// Rule 是一条词法规则，以确定有限自动机表的形式给出。
// Trans[s] 为状态 s 的转移表（字节 -> 目标状态），缺失的转移表示死路；
// Accept[s] 为真表示状态 s 是接受态。自动机不得接受空串。
type Rule struct {
	Name   string
	Start  int32
	Trans  []map[byte]int32
	Accept []bool
}

// Literal 构造只匹配字面串 s 的规则表。
func Literal(name, s string) Rule {
	if s == "" {
		panic("streamlex: empty literal")
	}
	trans := make([]map[byte]int32, len(s)+1)
	for i := range trans {
		trans[i] = map[byte]int32{}
	}
	for i := 0; i < len(s); i++ {
		trans[i][s[i]] = int32(i + 1)
	}
	accept := make([]bool, len(s)+1)
	accept[len(s)] = true
	return Rule{Name: name, Start: 0, Trans: trans, Accept: accept}
}

// Token 是词法分析产出的一项，Pos 为在整个输入流中的绝对字节偏移。
type Token struct {
	Rule int
	Name string
	Pos  int
	Text string
}

// Error 表示在 Offset 处没有任何规则能匹配出一个 token。
type Error struct {
	Offset int
}

func (e *Error) Error() string {
	return fmt.Sprintf("streamlex: no rule matches at offset %d", e.Offset)
}

// ErrClosed 表示在 End 之后仍继续喂入或重复结束。
var ErrClosed = errors.New("streamlex: lexer is closed")

// Lexer 是流式词法分析器。用法：New 创建，反复 Feed 喂入输入块，
// 最后调用 End 发出结束信号并冲刷尾部 token。
type Lexer struct {
	rules []Rule

	buf  []byte // 尚未切出 token 的字节
	base int    // buf[0] 在整流中的绝对偏移

	// 增量扫描状态：states[i] 为规则 i 消费完 buf[:scan] 后所处的状态，
	// -1 表示该规则已死；lastPos/lastRule 记录最近一次接受位置。
	scan     int
	states   []int32
	lastPos  int
	lastRule int

	eof bool
	err error
}

// New 以声明顺序给出规则创建分析器；表不一致或规则可匹配空串时 panic。
func New(rules ...Rule) *Lexer {
	if len(rules) == 0 {
		panic("streamlex: no rules")
	}
	for i := range rules {
		r := &rules[i]
		if len(r.Trans) != len(r.Accept) {
			panic("streamlex: rule " + r.Name + ": Trans/Accept length mismatch")
		}
		if r.Start < 0 || int(r.Start) >= len(r.Trans) {
			panic("streamlex: rule " + r.Name + ": bad start state")
		}
		if r.Accept[r.Start] {
			panic("streamlex: rule " + r.Name + ": matches empty string")
		}
		for _, row := range r.Trans {
			for _, next := range row {
				if next < 0 || int(next) >= len(r.Trans) {
					panic("streamlex: rule " + r.Name + ": transition target out of range")
				}
			}
		}
	}
	l := &Lexer{rules: rules}
	l.resetScan()
	return l
}

func (l *Lexer) resetScan() {
	l.scan = 0
	l.lastPos = -1
	l.lastRule = -1
	if l.states == nil {
		l.states = make([]int32, len(l.rules))
	}
	for i := range l.rules {
		l.states[i] = l.rules[i].Start
	}
}

// Feed 喂入一块输入，返回本次得以确定的 token（可能为空）。
// 一旦发生错误，分析器进入错误态，后续调用都返回同一错误。
func (l *Lexer) Feed(chunk []byte) ([]Token, error) {
	if l.err != nil {
		return nil, l.err
	}
	if l.eof {
		return nil, ErrClosed
	}
	l.buf = append(l.buf, chunk...)
	return l.run(false)
}

// End 发出结束信号：流已完结，缓冲区内按最长匹配确定的尾项
// 此刻才能最终确定。返回剩余全部 token。End 之后分析器关闭。
func (l *Lexer) End() ([]Token, error) {
	if l.err != nil {
		return nil, l.err
	}
	if l.eof {
		return nil, ErrClosed
	}
	l.eof = true
	return l.run(true)
}

// run 推进扫描。eof 为真时，到达缓冲区末尾即可敲定尾项。
func (l *Lexer) run(eof bool) ([]Token, error) {
	var out []Token
	for {
		for l.scan < len(l.buf) {
			b := l.buf[l.scan]
			alive := false
			for i := range l.rules {
				if l.states[i] < 0 {
					continue
				}
				next, ok := l.rules[i].Trans[l.states[i]][b]
				if !ok {
					l.states[i] = -1
					continue
				}
				l.states[i] = next
				alive = true
			}
			if !alive {
				// 所有自动机都死了：最近接受位置不可能再延长，敲定。
				if l.lastPos < 0 {
					l.err = &Error{Offset: l.base}
					return out, l.err
				}
				out = append(out, l.emit())
				continue
			}
			l.scan++
			// 前缀 buf[:scan] 上若有规则接受，按声明顺序取第一条；
			// scan 单调递增，后到的接受总是更长的匹配。
			for i := range l.rules {
				if st := l.states[i]; st >= 0 && l.rules[i].Accept[st] {
					l.lastPos, l.lastRule = l.scan, i
					break
				}
			}
		}
		if !eof || len(l.buf) == 0 {
			return out, nil
		}
		// 结束信号：缓冲区里尚存活的匹配到此为止，敲定尾项。
		if l.lastPos < 0 {
			l.err = &Error{Offset: l.base}
			return out, l.err
		}
		out = append(out, l.emit())
	}
}

// emit 切出 buf[:lastPos] 作为 token，消费之并重置扫描状态。
func (l *Lexer) emit() Token {
	tok := Token{
		Rule: l.lastRule,
		Name: l.rules[l.lastRule].Name,
		Pos:  l.base,
		Text: string(l.buf[:l.lastPos]),
	}
	l.buf = l.buf[l.lastPos:]
	l.base += l.lastPos
	l.resetScan()
	return tok
}
