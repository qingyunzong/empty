// Package dataeng 提供面向采集服务的增量 JSON 解码组件。
//
// 输入以连续字节块（chunk）的形式写入解码器，顶层必须是一个 JSON 数组，
// 允许空数组。解码器在完整解析出一个顶层元素、且该元素的原始字节数不超过
// 调用方给定的上限时，通过回调交付该元素。
//
// 解码器是有状态的：字节块可以在任意位置切分，包括字符串转义、多字节
// UTF-8 序列与数字中间。回调可以通过返回 ErrPaused 暂停消费，随后调用
// Resume 从内部未消费位置继续，已交付的元素不会重发。
package dataeng

import (
	"bytes"
	"errors"
	"fmt"
)

// ElementCallback 是顶层元素回调。elem 为该元素的原始 JSON 字节，解码器
// 会做一份拷贝，调用方可长期持有。返回 ErrPaused 表示已接收该元素并暂停
// 消费；返回其他非空错误会使解码器终止。
type ElementCallback func(elem []byte) error

// ErrPaused 由回调返回，表示当前元素已接收、暂停消费。
var ErrPaused = errors.New("dataeng: decoder paused by callback")

// ErrElementTooLarge 表示某个顶层元素的原始字节数超过 MaxElementSize。
var ErrElementTooLarge = errors.New("dataeng: element exceeds max size")

// SyntaxError 描述一次语法错误，Offset 为零起始的字节偏移。
//
// 偏移语义：
//   - 非法 UTF-8：报“无法构成合法编码的首字节”位置；
//   - 其他非法字节：报该字节自身的位置；
//   - 输入结束时仍缺少字节：报错时已输入的总长度；
//   - 重复对象键：报第二个键的起始引号位置。
type SyntaxError struct {
	Offset int
	Msg    string
}

func (e *SyntaxError) Error() string {
	return fmt.Sprintf("dataeng: invalid JSON at offset %d: %s", e.Offset, e.Msg)
}

type elementTooLargeError struct {
	Offset int
}

func (e *elementTooLargeError) Error() string {
	return fmt.Sprintf("dataeng: element starting at offset %d exceeds max size", e.Offset)
}

// Unwrap 让 errors.Is(err, ErrElementTooLarge) 成立。
func (e *elementTooLargeError) Unwrap() error { return ErrElementTooLarge }

// 顶层与容器的解析状态。
const (
	sRootOpen   = iota // 尚未读到顶层 '['
	sRootWs            // 顶层 '[' 之后，决定空数组或首个元素
	sValue             // 期待一个值
	sPost              // 刚结束一个值，期待 ',' / ']' 或 ',' / '}'
	sRootClosed        // 顶层 ']' 已匹配
	sRootSep           // 顶层元素已交付，期待 ',' / ']'
	sScan              // 标量扫描器（字符串/数字/字面量）跨块挂起中
	sDone              // 关闭成功的终态
	sFailed            // 已终止
)

// 字符串子扫描器状态。
const (
	strNormal = iota
	strEscape
	strU
	strUSurrogate
	strSurCont // 高代理已读完，等待紧跟的 "\uXXXX" 低代理
	strSurU    // 高代理后的反斜杠已读，等待 'u'
)

// frame 表示一层数组或对象容器。
type frame struct {
	isObject bool
	keys     map[string]struct{} // 仅对象使用
}

// numState 是数字子扫描器的状态。
type numState int

const (
	numMinus numState = iota
	numZero
	numInt
	numDot
	numFrac
	numE
	numExpSign
	numExp
)

// scanKind 标识 sScan 状态下挂起的标量扫描器。
type scanKind int

const (
	scanNone scanKind = iota
	scanString
	scanNumber
	scanLiteral
)

// Decoder 是增量 JSON 解码器。零值不可用，使用 New 构造。
type Decoder struct {
	cb             ElementCallback
	maxElementSize int

	buf  []byte // 尚未消费的字节
	base int    // buf[0] 在整体输入中的绝对偏移
	pos  int    // 当前扫描位置（buf 下标）

	state int
	stack []frame

	// elemStart 是当前顶层元素首字节的绝对偏移；-1 表示不在顶层元素内。
	elemStart int
	// rawBuf 累积当前顶层元素的原始字节，独立于会被 compact 裁剪的 buf。
	rawBuf []byte

	// 字符串扫描器
	strState    int
	strBuf      bytes.Buffer // 已解码字符串内容（用于对象键去重）
	strIsKey    bool
	strUVal     uint16
	strUDigits  int
	strHigh     rune // 待配对的高代理；strHasHigh 为 false 时无效
	strHasHigh  bool
	strEntered  bool // 是否已消费当前字符串的开引号
	keyQuoteOff int  // 当前对象键开引号的绝对偏移（重复键报错用）

	// 多字节 UTF-8 序列跨块续读。
	utfNeed int    // 还需读取的续字节数；0 表示未在累积
	utfLead byte   // 序列首字节
	utfBuf  []byte // 已收集的序列字节（含首字节）

	// 数字扫描器
	numState numState

	// 字面量扫描器（true/false/null）
	litWant []byte
	litHave int

	// sScan 挂起时正在运行的扫描器类型。
	scanKind scanKind

	// 对象键结束后期待冒号。
	postExpectColon bool
	// 当前期待的字符串是对象键（而非值）。
	expectKey bool

	paused bool
	closed bool
	err    error
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

// New 创建解码器。maxElementSize 为单个顶层元素原始字节数上限，必须 > 0；
// cb 为元素回调，不能为 nil。
func New(maxElementSize int, cb ElementCallback) *Decoder {
	if maxElementSize <= 0 {
		panic("dataeng: maxElementSize must be positive")
	}
	if cb == nil {
		panic("dataeng: callback must not be nil")
	}
	return &Decoder{
		cb:             cb,
		maxElementSize: maxElementSize,
		state:          sRootOpen,
		elemStart:      -1,
	}
}

// Write 喂入一段连续字节，返回该 chunk 中已被消费的字节数 n（0 <= n <=
// len(chunk)）。chunk[n:] 未被消费；暂停时调用方应保留尾部并在恢复后继续
// 写入，且不得重发已消费前缀。发生终止性错误时返回该错误。
func (d *Decoder) Write(chunk []byte) (n int, err error) {
	if d.closed {
		return 0, d.errOr(errors.New("dataeng: write on closed decoder"))
	}
	if d.err != nil {
		return 0, d.err
	}
	if d.paused {
		return 0, ErrPaused
	}
	d.buf = append(d.buf, chunk...)
	startPos := d.pos
	if err = d.process(false); err != nil {
		if errors.Is(err, ErrPaused) {
			consumed := d.pos - startPos
			// compact 裁剪已消费前缀，使 buf 仅保留未消费尾部；返回的 n
			// 不含未消费的分隔符，调用方据 n 续传即可，不会重复。
			d.compact()
			d.paused = true
			return consumed, ErrPaused
		}
		d.fail(err)
		return 0, err
	}
	d.compact()
	return len(chunk), nil
}

// Resume 在回调返回 ErrPaused 后恢复解码。恢复从内部缓冲的未消费位置继续，
// 不会重发已交付的元素。
func (d *Decoder) Resume() error {
	if d.err != nil {
		return d.err
	}
	if !d.paused {
		return errors.New("dataeng: decoder is not paused")
	}
	d.paused = false
	// 仅解除暂停；未消费字节（含触发暂停的分隔符）保留在缓冲中，由下一次
	// Write 从同一位置继续，已交付元素不会重发。
	return nil
}

// Close 显式结束输入。要求顶层数组已经结束，且其后只能有 JSON 空白；任何
// 未完成结构都按“输入结束时缺字节”报错，偏移为已输入总长度。
func (d *Decoder) Close() error {
	if d.err != nil {
		return d.err
	}
	if d.paused {
		return ErrPaused
	}
	d.closed = true
	if err := d.process(true); err != nil {
		if errors.Is(err, ErrPaused) {
			d.paused = true
			return ErrPaused
		}
		d.fail(err)
		return err
	}
	d.compact()
	if d.state != sDone {
		err := d.syntax(d.base+len(d.buf), "unexpected end of JSON input")
		d.fail(err)
		return err
	}
	return nil
}

func (d *Decoder) errOr(fallback error) error {
	if d.err != nil {
		return d.err
	}
	return fallback
}

func (d *Decoder) fail(err error) {
	d.state = sFailed
	d.err = err
}

// compact 丢弃已扫描前缀并校正绝对偏移。
func (d *Decoder) compact() {
	if d.pos == 0 {
		return
	}
	nb := make([]byte, len(d.buf)-d.pos)
	copy(nb, d.buf[d.pos:])
	d.buf = nb
	d.base += d.pos
	d.pos = 0
}

func (d *Decoder) syntax(off int, msg string) error {
	return &SyntaxError{Offset: off, Msg: msg}
}

func (d *Decoder) curAbs() int { return d.base + d.pos }

// eat 消费当前字节；若处于某个顶层元素内，同时把该原始字节记入 rawBuf。
func (d *Decoder) eat() {
	if d.elemStart >= 0 {
		d.rawBuf = append(d.rawBuf, d.buf[d.pos])
	}
	d.pos++
}

// process 驱动状态机，直到缓冲耗尽、回调暂停、出错或解码完成。
// eof 为 true 表示不会再有新字节。
func (d *Decoder) process(eof bool) error {
	for {
		if d.paused {
			return ErrPaused
		}
		if d.pos >= len(d.buf) {
			return d.atEnd(eof)
		}
		switch d.state {
		case sRootOpen:
			switch c := d.buf[d.pos]; {
			case c == '[':
				d.eat()
				d.stack = append(d.stack, frame{isObject: false})
				d.state = sRootWs
			case isSpace(c):
				d.eat()
			default:
				return d.syntax(d.curAbs(), "top-level value must be an array")
			}

		case sRootWs:
			c := d.buf[d.pos]
			if isSpace(c) {
				d.eat()
				continue
			}
			if c == ']' {
				d.eat()
				d.stack = d.stack[:0]
				d.state = sRootClosed
				continue
			}
			d.state = sValue

		case sValue:
			if err := d.dispatchValue(eof); err != nil {
				return err
			}

		case sScan:
			if err := d.resumeScan(eof); err != nil {
				return err
			}

		case sPost:
			if err := d.handlePost(); err != nil {
				return err
			}

		case sRootSep:
			if err := d.handleRootSep(); err != nil {
				return err
			}

		case sRootClosed:
			c := d.buf[d.pos]
			if isSpace(c) {
				d.eat()
				continue
			}
			return d.syntax(d.curAbs(), "trailing data after top-level array")

		default:
			return d.syntax(d.curAbs(), "decoder in invalid state")
		}
	}
}

// atEnd 在缓冲耗尽时处理 EOF 语义或“等待更多字节”。
func (d *Decoder) atEnd(eof bool) error {
	if !eof {
		return nil
	}
	switch d.state {
	case sRootClosed:
		d.state = sDone
		return nil
	case sDone, sFailed:
		return nil
	default:
		return d.syntax(d.base+len(d.buf), "unexpected end of JSON input")
	}
}

// handlePost 处理一个值结束后的分隔符。
func (d *Decoder) handlePost() error {
	top := d.stack[len(d.stack)-1]
	c := d.buf[d.pos]
	if isSpace(c) {
		d.eat()
		return nil
	}
	if d.postExpectColon {
		if c != ':' {
			return d.syntax(d.curAbs(), "expected ':' after object key")
		}
		d.postExpectColon = false
		d.eat()
		d.expectKey = false // 冒号后是值，不是键
		d.state = sValue    // 冒号后期待值
		return nil
	}
	switch c {
	case ',':
		d.eat()
		d.expectKey = top.isObject // 对象逗号后期待下一个键
		d.state = sValue
		return nil
	case ']':
		if top.isObject {
			return d.syntax(d.curAbs(), "expected '}' to close object")
		}
		return d.closeContainer()
	case '}':
		if !top.isObject {
			return d.syntax(d.curAbs(), "expected ']' to close array")
		}
		return d.closeContainer()
	default:
		if top.isObject {
			return d.syntax(d.curAbs(), "expected ',' or '}' after object value")
		}
		return d.syntax(d.curAbs(), "expected ',' or ']' after array element")
	}
}

// closeContainer 处理容器闭合括号；若闭合的是顶层数组则交付当前元素。
func (d *Decoder) closeContainer() error {
	d.eat()
	d.stack = d.stack[:len(d.stack)-1]

	// 闭合的是顶层数组本身。
	if len(d.stack) == 0 {
		d.elemStart = -1
		d.state = sRootClosed
		return nil
	}
	// 闭合的容器是顶层数组的直接元素：交付它。
	if len(d.stack) == 1 && d.elemStart >= 0 {
		if err := d.deliver(); err != nil {
			return err
		}
		d.state = sRootSep
		return nil
	}
	d.state = sPost
	return nil
}

// scanString 扫描一个 JSON 字符串，支持任意位置切块、全部标准转义、
// \uXXXX 与代理对，并对原始 UTF-8 字节做合法性校验。
func (d *Decoder) scanString(eof bool) error {
	// 首次进入：消费开引号，并判断该字符串是否为对象键。
	if !d.strEntered {
		d.strEntered = true
		d.strIsKey = d.expectKey
		if d.strIsKey {
			d.keyQuoteOff = d.curAbs()
		}
		d.eat()
	}
	for d.pos < len(d.buf) {
		// 高代理之后，下一个有效字符序列必须是 "\uXXXX"。
		if d.strState == strSurCont || d.strState == strSurU {
			if d.strState == strSurCont {
				if d.buf[d.pos] != '\\' {
					return d.syntax(d.curAbs(), "expected unicode escape after high surrogate")
				}
				d.eat()
				d.strState = strSurU
				if d.pos >= len(d.buf) {
					break
				}
			}
			if d.strState == strSurU {
				if d.buf[d.pos] != 'u' {
					return d.syntax(d.curAbs(), "expected unicode escape after high surrogate")
				}
				d.eat()
				d.strState = strUSurrogate
				d.strUDigits = 0
				d.strUVal = 0
			}
		}
		if d.pos >= len(d.buf) {
			break
		}

		c := d.buf[d.pos]
		switch d.strState {
		case strNormal:
			if d.utfNeed > 0 {
				// 上一块在多字节序列中途挂起，必须先续完该序列。
				if err := d.scanUTF8(eof); err != nil {
					return err
				}
				continue
			}
			switch {
			case c == '"':
				d.eat()
				return d.finishString()
			case c == '\\':
				d.strState = strEscape
				d.eat()
			case c < 0x20:
				return d.syntax(d.curAbs(), "unescaped control character in string")
			case c < 0x80:
				d.strBuf.WriteByte(c)
				d.eat()
			default:
				if err := d.scanUTF8(eof); err != nil {
					return err
				}
			}
		case strEscape:
			if err := d.scanEscape(); err != nil {
				return err
			}
		case strU, strUSurrogate:
			if err := d.scanHex4(); err != nil {
				return err
			}
		case strSurCont, strSurU:
			// 真正的校验在循环顶部完成；到这里说明缓冲在 '\\' 后耗尽，等待更多字节。
			return nil
		}
	}
	d.suspendIfWaiting()
	return nil
}

// scanUTF8 校验并复制一个多字节 UTF-8 序列；序列被切块时暂停等待。
func (d *Decoder) scanUTF8(eof bool) error {
	// 首个字节：确定序列长度并校验首字节合法性。
	if d.utfNeed == 0 {
		start := d.curAbs()
		lead := d.buf[d.pos]
		need := 0
		switch {
		case lead >= 0xC2 && lead <= 0xDF:
			need = 1
		case lead >= 0xE0 && lead <= 0xEF:
			need = 2
		case lead >= 0xF0 && lead <= 0xF4:
			need = 3
		default:
			// 0x80-0xBF 游离续字节，0xC0/0xC1/0xF5-0xFF 等永远非法的首字节。
			return d.syntax(start, "invalid UTF-8 leading byte")
		}
		d.utfLead = lead
		d.utfNeed = need
		d.utfBuf = append(d.utfBuf[:0], lead)
		d.eat()
	}

	leadStart := d.curAbs() - len(d.utfBuf)
	// 收集续字节；跨块时挂起，恢复后从这里继续。
	for d.utfNeed > 0 {
		if d.pos >= len(d.buf) {
			if eof {
				return d.syntax(leadStart, "invalid UTF-8: truncated multibyte sequence")
			}
			return nil
		}
		b := d.buf[d.pos]
		if b < 0x80 || b > 0xBF {
			return d.syntax(leadStart, "invalid UTF-8 continuation byte")
		}
		d.utfBuf = append(d.utfBuf, b)
		d.utfNeed--
		d.eat()
	}

	// 完整序列到手，做范围、超长与代理区校验。
	lead := d.utfLead
	seq := d.utfBuf
	r := rune(lead & (0x7F >> (len(seq) - 1)))
	for i := 1; i < len(seq); i++ {
		r = r<<6 | rune(seq[i]&0x3F)
	}
	if r > 0x10FFFF {
		return d.syntax(leadStart, "invalid UTF-8: codepoint above U+10FFFF")
	}
	if len(seq) == 3 {
		if lead == 0xE0 && seq[1] < 0xA0 {
			return d.syntax(leadStart, "invalid UTF-8: overlong encoding")
		}
		if lead == 0xED && seq[1] >= 0xA0 {
			return d.syntax(leadStart, "invalid UTF-8: surrogate codepoint")
		}
	}
	if len(seq) == 4 {
		if lead == 0xF0 && seq[1] < 0x90 {
			return d.syntax(leadStart, "invalid UTF-8: overlong encoding")
		}
		if lead == 0xF4 && seq[1] >= 0x90 {
			return d.syntax(leadStart, "invalid UTF-8: codepoint above U+10FFFF")
		}
	}
	d.strBuf.Write(seq)
	d.utfBuf = d.utfBuf[:0]
	return nil
}

// scanEscape 处理反斜杠后的单个转义字符。
func (d *Decoder) scanEscape() error {
	c := d.buf[d.pos]
	switch c {
	case '"', '\\', '/':
		d.strBuf.WriteByte(c)
	case 'b':
		d.strBuf.WriteByte('\b')
	case 'f':
		d.strBuf.WriteByte('\f')
	case 'n':
		d.strBuf.WriteByte('\n')
	case 'r':
		d.strBuf.WriteByte('\r')
	case 't':
		d.strBuf.WriteByte('\t')
	case 'u':
		d.strState = strU
		d.strUVal = 0
		d.strUDigits = 0
		d.eat()
		return nil
	default:
		return d.syntax(d.curAbs(), "invalid escape character")
	}
	d.strState = strNormal
	d.eat()
	return nil
}

// scanHex4 收集 4 位十六进制数并处理 BMP 码点/代理对，支持逐字节切块。
func (d *Decoder) scanHex4() error {
	hexStart := d.curAbs() - d.strUDigits
	for d.pos < len(d.buf) && d.strUDigits < 4 {
		v, ok := hexVal(d.buf[d.pos])
		if !ok {
			return d.syntax(d.curAbs(), "invalid hex digit in unicode escape")
		}
		d.strUVal = d.strUVal<<4 | uint16(v)
		d.strUDigits++
		d.eat()
	}
	if d.strUDigits < 4 {
		return nil // 等待更多字节
	}
	r := rune(d.strUVal)
	d.strUVal = 0
	d.strUDigits = 0

	if d.strState == strUSurrogate {
		// 前面是高代理，此处必须是低代理。
		if r < 0xDC00 || r > 0xDFFF {
			return d.syntax(hexStart, "expected low surrogate after high surrogate")
		}
		combined := 0x10000 + (d.strHigh-0xD800)<<10 + (r - 0xDC00)
		d.strHasHigh = false
		d.strHigh = 0
		d.strState = strNormal
		var buf [4]byte
		n := encodeRune(buf[:], combined)
		d.strBuf.Write(buf[:n])
		return nil
	}

	switch {
	case r >= 0xD800 && r <= 0xDBFF:
		// 高代理：必须紧跟 \uXXXX 低代理。
		d.strHasHigh = true
		d.strHigh = r
		d.strState = strSurCont
		return nil
	case r >= 0xDC00 && r <= 0xDFFF:
		return d.syntax(hexStart, "unexpected low surrogate")
	default:
		var buf [4]byte
		n := encodeRune(buf[:], r)
		d.strBuf.Write(buf[:n])
		d.strState = strNormal
		return nil
	}
}

// finishString 在遇到闭引号时收尾：校验未配对高代理，做对象键去重。
func (d *Decoder) finishString() error {
	if d.strHasHigh || d.strState == strSurCont || d.strState == strSurU {
		return d.syntax(d.curAbs()-1, "unpaired high surrogate at end of string")
	}
	d.strEntered = false
	d.strState = strNormal

	top := d.stack[len(d.stack)-1]
	if top.isObject && d.strIsKey {
		key := d.strBuf.String()
		if _, exists := top.keys[key]; exists {
			// 重复键：报第二个键的起始引号位置。键的原始长度不等于解码后
			// 长度，因此用独立字段记录开引号绝对偏移。
			return d.syntax(d.keyQuoteOff, "duplicate object key")
		}
		top.keys[key] = struct{}{}
	}
	d.strBuf.Reset()
	return d.finishScalar()
}

func hexVal(c byte) (int, bool) {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0'), true
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10, true
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10, true
	}
	return 0, false
}

// encodeRune 是 utf8.EncodeRune 的本地实现，避免额外导入。
func encodeRune(p []byte, r rune) int {
	switch {
	case r <= 0x7F:
		p[0] = byte(r)
		return 1
	case r <= 0x7FF:
		p[0] = 0xC0 | byte(r>>6)
		p[1] = 0x80 | byte(r)&0x3F
		return 2
	case r <= 0xFFFF:
		p[0] = 0xE0 | byte(r>>12)
		p[1] = 0x80 | byte(r>>6)&0x3F
		p[2] = 0x80 | byte(r)&0x3F
		return 3
	default:
		p[0] = 0xF0 | byte(r>>18)
		p[1] = 0x80 | byte(r>>12)&0x3F
		p[2] = 0x80 | byte(r>>6)&0x3F
		p[3] = 0x80 | byte(r)&0x3F
		return 4
	}
}

// deliver 在顶层元素完整时做上限校验并调用回调。
func (d *Decoder) deliver() error {
	start := d.elemStart
	full := d.rawBuf
	d.rawBuf = d.rawBuf[:0]
	d.elemStart = -1
	size := len(full)
	if size > d.maxElementSize {
		return &elementTooLargeError{Offset: start}
	}
	cp := make([]byte, size)
	copy(cp, full)
	return d.cb(cp)
}

// dispatchValue 分派一个值的首字节并推进对应扫描器。
func (d *Decoder) dispatchValue(eof bool) error {
	c := d.buf[d.pos]
	// 顶层数组直接元素：在真实值首字节（非空白、非空容器闭合）处标记起点。
	markRootStart := len(d.stack) == 1 && d.elemStart < 0 &&
		!isSpace(c) && c != '}' && c != ']'
	switch {
	case c == '"':
		if markRootStart {
			d.elemStart = d.curAbs()
		}
		d.scanKind = scanString
		return d.scanString(eof)
	case c == '{':
		if markRootStart {
			d.elemStart = d.curAbs()
		}
		d.eat()
		d.stack = append(d.stack, frame{isObject: true, keys: map[string]struct{}{}})
		d.expectKey = true // 对象首先期待键（或 '}'）
		d.state = sValue   // 期待首个键（字符串）或 '}'
		return nil
	case c == '[':
		if markRootStart {
			d.elemStart = d.curAbs()
		}
		d.eat()
		d.stack = append(d.stack, frame{isObject: false})
		d.expectKey = false
		d.state = sValue // 期待首个元素或 ']'
		return nil
	case c == 't':
		if markRootStart {
			d.elemStart = d.curAbs()
		}
		d.scanKind = scanLiteral
		return d.scanLiteral("true")
	case c == 'f':
		if markRootStart {
			d.elemStart = d.curAbs()
		}
		d.scanKind = scanLiteral
		return d.scanLiteral("false")
	case c == 'n':
		if markRootStart {
			d.elemStart = d.curAbs()
		}
		d.scanKind = scanLiteral
		return d.scanLiteral("null")
	case c == '-' || (c >= '0' && c <= '9'):
		if markRootStart {
			d.elemStart = d.curAbs()
		}
		d.numState = numMinus
		d.scanKind = scanNumber
		return d.scanNumber()
	case isSpace(c):
		d.eat()
		return nil
	case c == '}', c == ']':
		// 空容器，或数组中期待元素时直接闭合。
		if c == '}' && !d.stack[len(d.stack)-1].isObject {
			return d.syntax(d.curAbs(), "expected ']' to close array")
		}
		if c == ']' && d.stack[len(d.stack)-1].isObject {
			return d.syntax(d.curAbs(), "expected '}' to close object")
		}
		return d.closeContainer()
	default:
		if c < 0x20 {
			return d.syntax(d.curAbs(), "unexpected control character")
		}
		if c >= 0x80 {
			return d.syntax(d.curAbs(), "invalid UTF-8 leading byte outside string")
		}
		return d.syntax(d.curAbs(), "unexpected token when expecting a value")
	}
}

// resumeScan 在新字节到达后继续此前挂起的标量扫描器。
func (d *Decoder) resumeScan(eof bool) error {
	switch d.scanKind {
	case scanString:
		return d.scanString(eof)
	case scanNumber:
		return d.scanNumber()
	case scanLiteral:
		return d.scanLiteral("")
	default:
		return d.syntax(d.curAbs(), "internal: invalid suspended scanner")
	}
}

// suspendIfWaiting 在缓冲耗尽、但语法结构尚未完成时进入 sScan。
func (d *Decoder) suspendIfWaiting() {
	if d.pos >= len(d.buf) && d.err == nil {
		d.state = sScan
	}
}

// scanLiteral 逐字节匹配 true/false/null，支持在任意字节处切块。
func (d *Decoder) scanLiteral(want string) error {
	if d.litWant == nil {
		if want == "" {
			return d.syntax(d.curAbs(), "internal: literal target missing")
		}
		d.litWant = []byte(want)
		d.litHave = 0
	}
	for d.pos < len(d.buf) {
		c := d.buf[d.pos]
		if d.litHave >= len(d.litWant) || c != d.litWant[d.litHave] {
			return d.syntax(d.curAbs(), "invalid literal")
		}
		d.litHave++
		d.eat()
		if d.litHave == len(d.litWant) {
			d.litWant = nil
			d.litHave = 0
			return d.finishScalar()
		}
	}
	d.suspendIfWaiting()
	return nil // 等待更多字节
}

// scanNumber 按 JSON 数字语法逐字节扫描，支持任意位置切块。
func (d *Decoder) scanNumber() error {
	for d.pos < len(d.buf) {
		c := d.buf[d.pos]
		switch d.numState {
		case numMinus:
			switch {
			case c == '-':
				d.numState = numInt // 负号后必须是数字
			case c == '0':
				d.numState = numZero
			case c >= '1' && c <= '9':
				d.numState = numInt
			default:
				return d.syntax(d.curAbs(), "invalid number")
			}
		case numInt:
			switch {
			case c >= '0' && c <= '9':
			case c == '.':
				d.numState = numDot
			case c == 'e' || c == 'E':
				d.numState = numE
			default:
				return d.finishNumber()
			}
		case numZero:
			switch {
			case c == '.':
				d.numState = numDot
			case c == 'e' || c == 'E':
				d.numState = numE
			default:
				return d.finishNumber()
			}
		case numDot:
			if c >= '0' && c <= '9' {
				d.numState = numFrac
			} else {
				return d.syntax(d.curAbs(), "digit expected after decimal point")
			}
		case numFrac:
			switch {
			case c >= '0' && c <= '9':
			case c == 'e' || c == 'E':
				d.numState = numE
			default:
				return d.finishNumber()
			}
		case numE:
			switch {
			case c == '+' || c == '-':
				d.numState = numExpSign
			case c >= '0' && c <= '9':
				d.numState = numExp
			default:
				return d.syntax(d.curAbs(), "digit expected after exponent marker")
			}
		case numExpSign:
			if c >= '0' && c <= '9' {
				d.numState = numExp
			} else {
				return d.syntax(d.curAbs(), "digit expected after exponent sign")
			}
		case numExp:
			if c >= '0' && c <= '9' {
				break
			}
			return d.finishNumber()
		}
		d.eat()
	}
	d.suspendIfWaiting()
	return nil // 等待更多字节（EOF 合法性由 atEnd 兜底）
}

// finishNumber 在遇到数字后的分隔字节时结束数字（不消费当前字节）。
func (d *Decoder) finishNumber() error {
	switch d.numState {
	case numMinus, numDot, numE, numExpSign:
		return d.syntax(d.curAbs(), "incomplete number")
	}
	d.numState = numMinus
	return d.finishScalar()
}

// finishScalar 处理一个标量值（字符串/数字/字面量）结束后的状态推进。
func (d *Decoder) finishScalar() error {
	if len(d.stack) == 0 {
		return d.syntax(d.curAbs(), "scalar outside container")
	}
	top := d.stack[len(d.stack)-1]
	// 对象中刚结束的若是键（字符串），下一步期待 ':'；否则是普通值。
	if top.isObject && d.strIsKey {
		d.strIsKey = false
		d.expectKey = false // 键已读完，接下来是冒号和值
		d.state = sPost     // 复用 sPost，由键分支识别冒号
		d.postExpectColon = true
		return nil
	}
	// 顶层数组的直接标量元素：立即交付。
	if len(d.stack) == 1 {
		d.scanKind = scanNone
		d.state = sRootSep
		if err := d.deliver(); err != nil {
			return err
		}
		return nil
	}
	d.scanKind = scanNone
	d.state = sPost
	return nil
}

// handleRootSep 处理两个顶层元素之间的逗号或顶层数组的闭合。
func (d *Decoder) handleRootSep() error {
	c := d.buf[d.pos]
	if isSpace(c) {
		d.eat()
		return nil
	}
	switch c {
	case ',':
		d.eat()
		// 下一个顶层元素的首字节位置在跳过空白后记录。
		d.state = sValue
		return nil
	case ']':
		d.eat()
		d.stack = d.stack[:0]
		d.elemStart = -1
		d.state = sRootClosed
		return nil
	default:
		return d.syntax(d.curAbs(), "expected ',' or ']' after top-level element")
	}
}
