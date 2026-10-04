// Package logparse 提供流式日志导入解析。
//
// 记录（Record）由一条起始行和随后的若干续行组成，起始行与续行由
// 有限的规则表（[]Rule）判定。解析器通过 Write 以任意字节切块喂入，
// 产出的记录与诊断与切块方式无关；末行可以没有换行符，由 Close 收尾。
//
// 语义要点：
//   - 起始行：闭合上一条记录并开启新记录。
//   - 续行：追加到当前记录；若当前没有打开的记录则报“孤立续行”诊断并丢弃。
//   - 普通行（既不匹配起始也不匹配续行）：自身成为一条单行的普通记录，
//     不为后续续行提供锚点。
//   - 长度超限行：闭合当前记录后进入丢弃状态，直到下一条未超限的起始行
//     出现为止；整段被丢弃的字节范围以一条 DiagLineTooLong 诊断保留。
package logparse

import (
	"fmt"
	"regexp"
)

// Rule 描述一类记录的起始行与续行判定。
type Rule struct {
	Name         string
	Start        *regexp.Regexp // 匹配起始行
	Continuation *regexp.Regexp // 匹配续行
}

// Options 配置解析器。
type Options struct {
	Rules         []Rule // 有限规则表，按序匹配，起始判定优先于续行判定
	MaxLineLength int    // 单行最大字节数（不含换行符），0 表示不限
}

// Record 是一条解析出的日志记录。
type Record struct {
	Rule  string   // 命中规则的名称；普通行为 ""
	Lines []string // 各行内容，不含行尾换行符
	Start int64    // 首行第一个字节的偏移
	End   int64    // 末行内容之后一个字节的偏移（不含换行符）
}

// DiagKind 诊断类别。
type DiagKind int

const (
	// DiagOrphanContinuation 孤立续行：没有前导起始行的续行。
	DiagOrphanContinuation DiagKind = iota
	// DiagLineTooLong 行长度超限：从超限行起到下一起始行前的整段字节被丢弃。
	DiagLineTooLong
)

func (k DiagKind) String() string {
	switch k {
	case DiagOrphanContinuation:
		return "orphan-continuation"
	case DiagLineTooLong:
		return "line-too-long"
	}
	return "unknown"
}

// Diagnostic 描述一次解析诊断，[Start, End) 为相关字节范围。
type Diagnostic struct {
	Kind    DiagKind
	Start   int64
	End     int64
	Message string
}

// Parser 是流式日志解析器，零值不可用，请用 NewParser 构造。
type Parser struct {
	opts   Options
	onRec  func(Record)
	onDiag func(Diagnostic)

	buf    []byte // 尚未构成完整行的字节
	bufOff int64  // buf[0] 在流中的绝对偏移

	open        *Record // 当前未闭合的记录
	discarding  bool    // 是否处于超限丢弃状态
	discardFrom int64   // 丢弃段起始偏移
	closed      bool
}

// NewParser 创建解析器。onRecord 与 onDiag 在记录闭合、诊断产生时回调，
// 允许为 nil（忽略该类输出）。
func NewParser(opts Options, onRecord func(Record), onDiag func(Diagnostic)) *Parser {
	return &Parser{opts: opts, onRec: onRecord, onDiag: onDiag}
}

// Write 喂入任意大小的字节块，可多次调用。
func (p *Parser) Write(b []byte) {
	if p.closed {
		panic("logparse: Write after Close")
	}
	p.buf = append(p.buf, b...)
	for {
		i := indexByte(p.buf, '\n')
		if i < 0 {
			return
		}
		line := p.buf[:i]
		off := p.bufOff
		p.buf = p.buf[i+1:]
		p.bufOff += int64(i + 1)
		p.handleLine(line, off)
	}
}

// Close 结束输入：把残余字节作为无换行符的末行处理，并闭合所有状态。
func (p *Parser) Close() {
	if p.closed {
		return
	}
	p.closed = true
	if len(p.buf) > 0 {
		line := p.buf
		off := p.bufOff
		p.buf = nil
		p.bufOff += int64(len(line))
		p.handleLine(line, off)
	}
	if p.discarding {
		p.emitDiag(Diagnostic{
			Kind:    DiagLineTooLong,
			Start:   p.discardFrom,
			End:     p.bufOff,
			Message: fmt.Sprintf("line exceeds maximum length %d; discarded until next start line", p.opts.MaxLineLength),
		})
		p.discarding = false
	}
	p.closeRecord()
}

func (p *Parser) handleLine(content []byte, off int64) {
	// 兼容 CRLF：去掉行尾 '\r'。
	if n := len(content); n > 0 && content[n-1] == '\r' {
		content = content[:n-1]
	}
	tooLong := p.opts.MaxLineLength > 0 && len(content) > p.opts.MaxLineLength

	if p.discarding {
		if tooLong {
			return // 超限行同样被丢弃，丢弃段继续延伸
		}
		if rule, ok := p.matchStart(content); ok {
			p.emitDiag(Diagnostic{
				Kind:    DiagLineTooLong,
				Start:   p.discardFrom,
				End:     off,
				Message: fmt.Sprintf("line exceeds maximum length %d; discarded until next start line", p.opts.MaxLineLength),
			})
			p.discarding = false
			p.startRecord(rule, content, off)
		}
		return
	}

	if tooLong {
		p.closeRecord()
		p.discarding = true
		p.discardFrom = off
		return
	}

	if rule, ok := p.matchStart(content); ok {
		p.closeRecord()
		p.startRecord(rule, content, off)
		return
	}

	if p.matchContinuation(content) {
		if p.open != nil {
			p.open.Lines = append(p.open.Lines, string(content))
			p.open.End = off + int64(len(content))
		} else {
			p.emitDiag(Diagnostic{
				Kind:    DiagOrphanContinuation,
				Start:   off,
				End:     off + int64(len(content)),
				Message: "continuation line without a preceding start line",
			})
		}
		return
	}

	// 普通行：闭合当前记录，自身成为单行记录。
	p.closeRecord()
	p.emitRecord(Record{
		Lines: []string{string(content)},
		Start: off,
		End:   off + int64(len(content)),
	})
}

func (p *Parser) matchStart(line []byte) (Rule, bool) {
	for _, r := range p.opts.Rules {
		if r.Start != nil && r.Start.Match(line) {
			return r, true
		}
	}
	return Rule{}, false
}

func (p *Parser) matchContinuation(line []byte) bool {
	for _, r := range p.opts.Rules {
		if r.Continuation != nil && r.Continuation.Match(line) {
			return true
		}
	}
	return false
}

func (p *Parser) startRecord(rule Rule, content []byte, off int64) {
	p.open = &Record{
		Rule:  rule.Name,
		Lines: []string{string(content)},
		Start: off,
		End:   off + int64(len(content)),
	}
}

func (p *Parser) closeRecord() {
	if p.open != nil {
		p.emitRecord(*p.open)
		p.open = nil
	}
}

func (p *Parser) emitRecord(r Record) {
	if p.onRec != nil {
		p.onRec(r)
	}
}

func (p *Parser) emitDiag(d Diagnostic) {
	if p.onDiag != nil {
		p.onDiag(d)
	}
}

func indexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}
