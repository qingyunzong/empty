// Package dataeng 提供网页采集服务使用的分块多部分响应解析组件。
//
// 解析器以流式方式读取字节流，严格校验分块结构，并通过调用方提供的
// PartSink 把每个部分暂存到事务落点；只有全部部分解析成功后才提交，
// 任何截断、超限或流错误都会撤销整个事务。
package dataeng

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
)

var (
	// ErrTruncated 在输入结构或字节流被提前截断时返回。
	ErrTruncated = errors.New("dataeng: multipart stream truncated")
	// ErrLimitExceeded 在头部总字节或单部分正文超过上限时返回。
	ErrLimitExceeded = errors.New("dataeng: multipart size limit exceeded")
	// ErrDuplicateContentID 在出现重复 Content-ID 头时返回。
	ErrDuplicateContentID = errors.New("dataeng: duplicate Content-ID")
	// ErrInvalidBoundary 在边界不符合“非空且仅含 ASCII 字母数字”时返回。
	ErrInvalidBoundary = errors.New("dataeng: invalid boundary")
	// ErrMalformed 在分块结构或头部语法不符合约定时返回。
	ErrMalformed = errors.New("dataeng: malformed multipart stream")
)

// Header 表示一个已解析的 Name: Value 头部。Name 保留调用方给出的原始
// 大小写，匹配时请使用 Get 等不区分大小写的辅助方法。
type Header struct {
	Name  string
	Value string
}

// Limits 配置解析器的各项字节上限。
type Limits struct {
	// MaxPartBody 是单个部分正文（不含分隔符与头部）的最大字节数。
	MaxPartBody int64
	// MaxHeaderBytes 是单个部分头部区域的总字节上限，包含行尾 CRLF
	// 以及结束头部区域的空行 CRLF。
	MaxHeaderBytes int64
}

// PartSink 是调用方事务落点的抽象。
//
// 解析期间每个部分都会调用 BeginPart 开启一个暂存写入器；解析器只在
// 整个流成功解析完毕后调用一次 Commit，其余路径（截断、超限、流失败、
// 取消等）恰好调用一次 Abort 撤销所有暂存内容。同一 PartSink 的方法
// 调用由解析器串行发起。
type PartSink interface {
	// BeginPart 为序号为 index（从 0 开始）的部分创建暂存写入器。
	BeginPart(index int, headers []Header) (io.WriteCloser, error)
	// Commit 在全部部分解析成功后发布事务。
	Commit() error
	// Abort 撤销事务并丢弃全部暂存内容。
	Abort() error
}

// Parse 按照边界 boundary 解析 in 中的多部分字节流，并通过 sink 暂存结果。
//
// 成功时返回已提交的部分数量。ctx 被取消时解析器会关闭 in（以解除阻塞
// 的读取）、撤销事务并返回 ctx 的错误。
func Parse(ctx context.Context, in io.ReadCloser, boundary string, limits Limits, sink PartSink) (int, error) {
	if in == nil {
		return 0, errors.New("dataeng: nil input reader")
	}
	if sink == nil {
		return 0, errors.New("dataeng: nil part sink")
	}
	if !validBoundary(boundary) {
		return 0, ErrInvalidBoundary
	}
	if limits.MaxPartBody < 0 || limits.MaxHeaderBytes < 0 {
		return 0, errors.New("dataeng: negative size limit")
	}

	p := &parser{
		in:         in,
		buf:        make([]byte, 0, 256),
		dash:       []byte("--" + boundary),
		limits:     limits,
		sink:       sink,
		contentIDs: make(map[string]int),
	}

	// 取消时关闭输入，解除可能正阻塞的 Read；解析结束后由 once 兜底关闭。
	var closeOnce sync.Once
	closeIn := func() { closeOnce.Do(func() { _ = in.Close() }) }
	watchDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			closeIn()
		case <-watchDone:
		}
	}()
	defer func() {
		close(watchDone)
		closeIn()
	}()

	n, err := p.run(ctx)
	if err != nil {
		if abortErr := sink.Abort(); abortErr != nil {
			err = errors.Join(err, fmt.Errorf("dataeng: abort failed: %w", abortErr))
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return n, ctxErr
		}
		return n, err
	}
	if err := sink.Commit(); err != nil {
		if abortErr := sink.Abort(); abortErr != nil {
			err = errors.Join(err, fmt.Errorf("dataeng: abort failed: %w", abortErr))
		}
		return n, fmt.Errorf("dataeng: commit failed: %w", err)
	}
	return n, nil
}

// Get 在 headers 中按不区分大小写的方式查找 name，返回值与是否存在。
func Get(headers []Header, name string) (string, bool) {
	for _, h := range headers {
		if equalFoldASCII(h.Name, name) {
			return h.Value, true
		}
	}
	return "", false
}

func validBoundary(b string) bool {
	if b == "" {
		return false
	}
	for i := 0; i < len(b); i++ {
		c := b[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}

func equalFoldASCII(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		x, y := a[i], b[i]
		if x >= 'A' && x <= 'Z' {
			x += 'a' - 'A'
		}
		if y >= 'A' && y <= 'Z' {
			y += 'a' - 'A'
		}
		if x != y {
			return false
		}
	}
	return true
}

type parser struct {
	in     io.Reader
	buf    []byte // 尚未消费的已读字节
	atEOF  bool
	dash   []byte // "--B"
	limits Limits
	sink   PartSink

	partCount   int
	bodyWritten int64
	contentIDs  map[string]int
}

// fill 从底层流再读取一批字节追加到 buf。
func (p *parser) fill() error {
	if p.atEOF {
		return io.EOF
	}
	if len(p.buf) == cap(p.buf) {
		grown := make([]byte, len(p.buf), cap(p.buf)*2)
		copy(grown, p.buf)
		p.buf = grown
	}
	n, err := p.in.Read(p.buf[len(p.buf):cap(p.buf)])
	p.buf = p.buf[:len(p.buf)+n]
	if err == io.EOF {
		p.atEOF = true
		return io.EOF
	}
	if err != nil {
		return err
	}
	return nil
}

// require 确保 buf 至少有 n 个连续字节，必要时从流中补充。
func (p *parser) require(n int) error {
	for len(p.buf) < n {
		if err := p.fill(); err != nil {
			if err == io.EOF {
				if len(p.buf) < n {
					return ErrTruncated
				}
				return nil
			}
			return err
		}
	}
	return nil
}

// readLine 返回下一个以 CRLF 结尾的原始行内容（不含结尾 CRLF）。
// 单独出现的 CR 或 LF 一律视为格式错误。
func (p *parser) readLine() ([]byte, error) {
	for {
		if i := bytes.IndexByte(p.buf, '\n'); i >= 0 {
			if i == 0 || p.buf[i-1] != '\r' {
				return nil, ErrMalformed
			}
			line := p.buf[:i-1]
			p.buf = p.buf[i+1:]
			return line, nil
		}
		if p.atEOF {
			return nil, ErrTruncated
		}
		if err := p.fill(); err != nil && err != io.EOF {
			return nil, err
		}
	}
}

// readHeaders 读取并校验一个部分的头部区域，返回头部列表与消耗的总字节数。
func (p *parser) readHeaders() ([]Header, int64, error) {
	var headers []Header
	var total int64
	for {
		line, err := p.readLine()
		if err != nil {
			return nil, 0, err
		}
		total += int64(len(line)) + 2
		if p.limits.MaxHeaderBytes > 0 && total > p.limits.MaxHeaderBytes {
			return nil, 0, ErrLimitExceeded
		}
		if len(line) == 0 {
			return headers, total, nil
		}
		h, err := parseHeader(line)
		if err != nil {
			return nil, 0, err
		}
		if equalFoldASCII(h.Name, "Content-ID") {
			if _, exists := p.contentIDs[h.Value]; exists {
				return nil, 0, ErrDuplicateContentID
			}
			p.contentIDs[h.Value] = p.partCount
		}
		headers = append(headers, h)
	}
}

// parseHeader 校验并解析单行 "Name: Value"。
func parseHeader(line []byte) (Header, error) {
	colon := bytes.IndexByte(line, ':')
	if colon <= 0 {
		return Header{}, ErrMalformed
	}
	name := line[:colon]
	for _, c := range name {
		if !isHeaderNameByte(c) {
			return Header{}, ErrMalformed
		}
	}
	rest := line[colon+1:]
	if len(rest) < 1 || rest[0] != ' ' {
		return Header{}, ErrMalformed
	}
	value := rest[1:]
	for _, c := range value {
		// 值为 ASCII 字节且不含 CR 或 LF；按行读取后 LF 已不可能出现，
		// 此处同时拒绝裸 CR 与非 ASCII 字节。
		if c == '\r' || c > 0x7F {
			return Header{}, ErrMalformed
		}
	}
	return Header{Name: string(name), Value: string(value)}, nil
}

func isHeaderNameByte(c byte) bool {
	return (c >= 'a' && c <= 'z') ||
		(c >= 'A' && c <= 'Z') ||
		(c >= '0' && c <= '9') ||
		c == '-'
}

// readBody 把当前部分的正文写入 w，直到遇到下一部分或结束分隔行。
// 返回 true 表示遇到结束分隔行（整个输入结束），false 表示还有下一部分。
func (p *parser) readBody(w io.Writer) (bool, error) {
	dash := p.dash
	atStart := true
	for {
		split, at, kind := p.scanBody(dash, atStart)
		switch kind {
		case boundaryClose:
			leading := at + 2 // 候选 CRLF 起点到 dash 的距离
			if at == 0 && !hasLeadingCRLF(p.buf) {
				leading = 0
			}
			if err := p.emit(w, p.buf[:split]); err != nil {
				return false, err
			}
			consume := leading + len(dash) + 4 // 可选 CRLF + dash + "--" + CRLF
			p.buf = p.buf[at+consume:]
			if len(p.buf) == 0 && !p.atEOF {
				// 结束分隔行之后不得有数据；再读一次以发现后续块中的尾随字节。
				if err := p.fill(); err != nil && err != io.EOF {
					return false, err
				}
			}
			if len(p.buf) != 0 {
				return false, fmt.Errorf("%w: trailing data after closing boundary", ErrMalformed)
			}
			return true, nil
		case boundaryNext:
			leading := at + 2
			if at == 0 && !hasLeadingCRLF(p.buf) {
				leading = 0
			}
			if err := p.emit(w, p.buf[:split]); err != nil {
				return false, err
			}
			consume := leading + len(dash) + 2 // 可选 CRLF + dash + CRLF
			p.buf = p.buf[at+consume:]
			return false, nil
		case boundaryIncomplete, boundaryNone:
			// split 之前的字节不可能再构成任何分隔行，可安全放行；
			// split 及之后的字节保留，等待后续数据补齐候选。
			if split > 0 {
				if err := p.emit(w, p.buf[:split]); err != nil {
					return false, err
				}
				p.buf = p.buf[split:]
				atStart = false
			}
			if p.atEOF {
				return false, ErrTruncated
			}
			before := len(p.buf)
			if err := p.fill(); err != nil && err != io.EOF {
				return false, err
			}
			if len(p.buf) == before {
				return false, ErrTruncated
			}
		}
	}
}

type boundaryKind int

const (
	boundaryNone boundaryKind = iota
	boundaryIncomplete
	boundaryNext
	boundaryClose
)

// hasLeadingCRLF 判断缓冲是否以 CRLF 起始。
func hasLeadingCRLF(b []byte) bool {
	return len(b) >= 2 && b[0] == '\r' && b[1] == '\n'
}

// scanBody 在当前缓冲中定位最早的分隔行候选。
//
// 合法候选起点只有两类：缓冲起始（无前置 CRLF，at==0），或某个 CRLF
// 之后（at 指向该 CRLF）。对每个候选起点，检查其后的字节与 dash 的关系：
//   - 完整结束行/续接行 → boundaryClose / boundaryNext，split==at；
//   - dash 或其后缀尚未到齐（缓冲在候选处结束）→ boundaryIncomplete；
//   - 已到齐的字节与 dash 矛盾 → 该候选作废，继续下一个。
//
// 没有任何候选时返回 boundaryNone，split 为可安全放行的正文长度：
// 缓冲末尾可能补全为候选的字节（裸 CR，或起始/CRLF 后的 dash 前缀）
// 必须保留，其余全部放行。
func (p *parser) scanBody(dash []byte, atStart bool) (split, at int, kind boundaryKind) {
	n := len(p.buf)

	// 第一遍：找最早的完整或待定候选。候选起点为缓冲起始（at==0，
	// 无前置 CRLF，仅在正文尚未输出任何字节的 atStart 情形下才可能是
	// 空正文的分隔行），或任何 CRLF 的位置（at 指向该 CRLF，必为正数；
	// 位于 index 0 的 CRLF 也归入此类，避免与流起始候选混淆）。
	candidates := make([]int, 0, 4)
	for i := 0; i+1 < n; i++ {
		if p.buf[i] == '\r' && p.buf[i+1] == '\n' {
			candidates = append(candidates, i+1) // 用正数标记“CRLF 候选”
		}
	}
	if atStart {
		candidates = append(candidates, 0) // 流起始候选仅在正文起始时考虑
	}
	for _, at := range candidates {
		raw := at
		isStreamStart := at == 0
		if at > 0 {
			raw = at - 1 // 还原为 CRLF 的真实下标
		}
		if k, ok := p.classifyAt(raw, dash, at > 0); ok {
			// 流起始候选没有前置 CRLF，只可能是空正文后的结束行；
			// 续接行必须带前置 CRLF，起始处的 dash 一律属于正文。
			if isStreamStart && k != boundaryClose {
				continue
			}
			return raw, raw, k
		}
	}

	// 第二遍：无候选，计算安全放行长度 split。
	split = n
	if n > 0 && p.buf[n-1] == '\r' {
		split = n - 1 // 裸 CR 可能是分隔行 CRLF 的首字节
	}
	// 检查缓冲起始与每个 CRLF 之后是否存在 dash 的（可能部分的）前缀。
	if atStart {
		p.keepDashPrefix(&split, 0, dash, false)
	}
	for i := 0; i+1 < n; i++ {
		if p.buf[i] == '\r' && p.buf[i+1] == '\n' {
			p.keepDashPrefix(&split, i+2, dash, true)
		}
	}
	return split, 0, boundaryNone
}

// keepDashPrefix 检查 start 处开始的缓冲尾部是否构成 dash 的非空前缀，
// 若是则把 split 收紧到候选保留起点（hasCRLF 时含前置 CRLF）。
func (p *parser) keepDashPrefix(split *int, start int, dash []byte, hasCRLF bool) {
	tail := p.buf[start:]
	if len(tail) == 0 {
		// 缓冲恰好结束在候选起点（CRLF 之后或流起始），dash 尚未到达。
		if hasCRLF {
			keep := start - 2
			if keep < *split {
				*split = keep
			}
		}
		return
	}
	k := commonPrefixLen(tail, dash)
	if k == 0 {
		return
	}
	// tail 必须整体是 dash 前缀（即到缓冲末尾为止都未与 dash 矛盾）。
	if k != len(tail) {
		return
	}
	keep := start
	if hasCRLF {
		keep = start - 2
	}
	if keep < *split {
		*split = keep
	}
}

// commonPrefixLen 返回 a 与 b 的公共前缀字节数。
func commonPrefixLen(a, b []byte) int {
	limit := len(a)
	if len(b) < limit {
		limit = len(b)
	}
	for i := 0; i < limit; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	return limit
}

// classifyCandidate 判定候选尾部 tail 与 dash 的关系。
// ok=false 表示已到齐字节与 dash 矛盾，该候选作废。
func classifyCandidate(tail, dash []byte) (boundaryKind, bool) {
	if bytes.HasPrefix(tail, dash) {
		after := tail[len(dash):]
		switch {
		case bytes.HasPrefix(after, []byte("--\r\n")):
			return boundaryClose, true
		case bytes.HasPrefix(after, []byte("\r\n")):
			return boundaryNext, true
		case len(after) == 0 ||
			bytes.HasPrefix([]byte("--\r\n"), after) ||
			bytes.HasPrefix([]byte("\r\n"), after):
			return boundaryIncomplete, true
		default:
			return boundaryNone, false
		}
	}
	// dash 未完全到齐：tail 是 dash 的严格前缀时为待定，否则作废。
	if len(tail) < len(dash) && bytes.HasPrefix(dash, tail) {
		return boundaryIncomplete, true
	}
	return boundaryNone, false
}

// classifyAt 判定缓冲中位置 at 处的候选状态。hasCRLF 为 true 时 at
// 指向一个 CRLF，dash 紧随其后；否则 at==0 表示流起始候选（无前置 CRLF）。
func (p *parser) classifyAt(at int, dash []byte, hasCRLF bool) (boundaryKind, bool) {
	tail := p.buf[at:]
	if hasCRLF {
		tail = p.buf[at+2:]
	}
	return classifyCandidate(tail, dash)
}

// emit 把 chunk 写入当前部分的暂存写入器，并执行单部分正文上限检查。
func (p *parser) emit(w io.Writer, chunk []byte) error {
	if len(chunk) == 0 {
		return nil
	}
	if p.limits.MaxPartBody > 0 && int64(len(chunk)) > p.limits.MaxPartBody-p.bodyWritten {
		return fmt.Errorf("%w: part body exceeds %d bytes", ErrLimitExceeded, p.limits.MaxPartBody)
	}
	if _, err := w.Write(chunk); err != nil {
		return err
	}
	p.bodyWritten += int64(len(chunk))
	return nil
}

// run 执行完整的解析流程，成功时返回已处理的部分数量。
func (p *parser) run(ctx context.Context) (int, error) {
	// 输入必须以 "--B" + CRLF 开始。
	prefix := append(append([]byte{}, p.dash...), '\r', '\n')
	if err := p.require(len(prefix)); err != nil {
		return 0, err
	}
	if !bytes.Equal(p.buf[:len(prefix)], prefix) {
		return 0, fmt.Errorf("%w: missing opening boundary", ErrMalformed)
	}
	p.buf = p.buf[len(prefix):]

	for {
		if err := ctx.Err(); err != nil {
			return p.partCount, err
		}
		headers, _, err := p.readHeaders()
		if err != nil {
			return p.partCount, err
		}
		w, err := p.sink.BeginPart(p.partCount, headers)
		if err != nil {
			return p.partCount, err
		}
		p.bodyWritten = 0
		closed, err := p.readBody(w)
		if err != nil {
			_ = w.Close()
			return p.partCount, err
		}
		if err := w.Close(); err != nil {
			return p.partCount, err
		}
		p.partCount++
		if closed {
			return p.partCount, nil
		}
	}
}
