package q150

import (
	"bytes"
	"unicode/utf8"
)

// Event 是按 SSE 规范派发的一条文本事件。
type Event struct {
	// Type 是事件类型，缺省为 "message"。
	Type string
	// Data 是 data 字段拼接后的正文，行之间以 LF 分隔。
	Data string
	// LastEventID 是该事件关联的最后事件 ID；从未收到 id 时为空。
	LastEventID string
}

// Decoder 按 WHATWG 服务器发送事件规范解析 UTF-8 文本事件流。
//
// Decoder 可以接收任意大小、任意边界的字节切块：CR、LF 与 CRLF
// 换行以及多字节 UTF-8 字符都可以跨 Write 调用拆分。零值不可用，
// 请使用 NewDecoder 构造。
type Decoder struct {
	onEvent func(Event)
	onRetry func(milliseconds int)

	stage  decoderStage
	bomBuf []byte

	lineBuf     []byte
	eventType   string
	data        bytes.Buffer
	lastID      string
	retryMillis int
	pendingCR   bool
}

type decoderStage int

const (
	stageBOM decoderStage = iota
	stageNormal
)

// NewDecoder 创建解析器。onEvent 用于接收派发事件，onRetry 可为 nil
// 表示忽略服务端的 retry 建议。
func NewDecoder(onEvent func(Event), onRetry func(milliseconds int)) *Decoder {
	return &Decoder{
		onEvent:     onEvent,
		onRetry:     onRetry,
		stage:       stageBOM,
		retryMillis: -1,
	}
}

// RetryMillis 返回最近一次收到的 retry 建议（毫秒）；从未收到返回 -1。
func (d *Decoder) RetryMillis() int { return d.retryMillis }

// LastEventID 返回当前解析状态中的最后事件 ID 缓冲。
func (d *Decoder) LastEventID() string { return d.lastID }

// Write 喂入事件流的一个字节切块，返回的字节数始终等于 len(p)。
func (d *Decoder) Write(p []byte) (int, error) {
	n := len(p)
	if d.stage == stageBOM {
		p = d.consumeBOM(p)
	}
	for len(p) > 0 {
		b := p[0]
		p = p[1:]
		switch b {
		case '\r':
			d.processLine(d.lineBuf)
			d.lineBuf = d.lineBuf[:0]
			// 标记跨 Write 保留，以支持 CRLF 在切块边界被拆开。
			d.pendingCR = true
		case '\n':
			if d.pendingCR {
				// CRLF 的后半部分：不产生新行。
				d.pendingCR = false
				continue
			}
			d.processLine(d.lineBuf)
			d.lineBuf = d.lineBuf[:0]
		default:
			// CR 后若紧跟普通字符，则不存在 CRLF，清除待吞 LF 标记。
			d.pendingCR = false
			d.lineBuf = append(d.lineBuf, b)
		}
	}
	return n, nil
}

// Close 表示流结束：刷出残留的未结束行，并按规范在 data 缓冲非空时
// 派发最后一个事件。
func (d *Decoder) Close() error {
	if len(d.lineBuf) > 0 {
		d.processLine(d.lineBuf)
		d.lineBuf = d.lineBuf[:0]
	}
	d.pendingCR = false
	if d.data.Len() > 0 {
		d.dispatch()
	}
	return nil
}

// consumeBOM 处理流首的 UTF-8 BOM（EF BB BF），允许 BOM 跨切块拆分。
func (d *Decoder) consumeBOM(p []byte) []byte {
	bom := []byte{0xEF, 0xBB, 0xBF}
	for len(p) > 0 {
		d.bomBuf = append(d.bomBuf, p[0])
		p = p[1:]
		if bytes.HasPrefix(bom, d.bomBuf) {
			if bytes.Equal(bom, d.bomBuf) {
				d.stage = stageNormal
				d.bomBuf = d.bomBuf[:0]
				return p
			}
			continue
		}
		// 此前缓存的字节并非 BOM：把缓存内容当作普通行内容补回。
		leftover := d.bomBuf
		d.bomBuf = d.bomBuf[:0]
		d.stage = stageNormal
		d.lineBuf = append(d.lineBuf, leftover...)
		return p
	}
	return p
}

// processLine 处理一条完整行（不含行尾换行符）。
func (d *Decoder) processLine(line []byte) {
	if len(line) == 0 {
		// 空行：data 缓冲非空时派发事件，随后重置事件类型。
		if d.data.Len() > 0 {
			d.dispatch()
		}
		d.eventType = ""
		return
	}
	if line[0] == ':' {
		return // 注释行：忽略且不派发事件
	}

	field := line
	var value []byte
	if idx := bytes.IndexByte(line, ':'); idx >= 0 {
		field = line[:idx]
		value = line[idx+1:]
		if len(value) > 0 && value[0] == ' ' {
			value = value[1:] // 仅去除值前的一个空格
		}
	}

	switch string(field) {
	case "event":
		d.eventType = string(value)
	case "data":
		d.data.Write(value)
		d.data.WriteByte('\n')
	case "id":
		if !bytes.ContainsRune(value, 0) {
			d.lastID = string(value)
		}
	case "retry":
		if millis, ok := parseRetry(value); ok {
			d.retryMillis = millis
			if d.onRetry != nil {
				d.onRetry(millis)
			}
		}
	}
}

func parseRetry(value []byte) (int, bool) {
	if len(value) == 0 {
		return 0, false
	}
	n := 0
	for _, b := range value {
		if b < '0' || b > '9' {
			return 0, false
		}
		digit := int(b - '0')
		if n > (int(^uint(0)>>1)-digit)/10 {
			return 0, false // 溢出保护
		}
		n = n*10 + digit
	}
	return n, true
}

func (d *Decoder) dispatch() {
	eventType := d.eventType
	if eventType == "" {
		eventType = "message"
	}
	raw := d.data.Bytes()
	raw = raw[:len(raw)-1] // 去掉末尾追加的 LF
	data := string(bytes.ToValidUTF8(raw, []byte(string(utf8.RuneError))))
	event := Event{
		Type:        eventType,
		Data:        data,
		LastEventID: d.lastID,
	}
	d.data.Reset()
	d.eventType = ""
	if d.onEvent != nil {
		d.onEvent(event)
	}
}
