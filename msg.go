// Package msglib 解析与规范重编码 TLV（tag-length-payload）消息包。
//
// 线格式：tag(uint16 大端) | length(uint32 大端) | payload(length 字节)。
//
// 解析规则：
//   - 已知标量 tag 重复出现时取最后一个；
//   - 已知列表 tag 重复出现时按出现顺序拼接；
//   - 未知 tag 原样保留（tag 与载荷字节不变、相对顺序不变）。
//
// 规范重编码规则：已知 tag 按升序输出，未知字段保持相对顺序附于其后。
// 长度越界（声明长度超过剩余字节或超过 MaxPayload）时拒绝整包。
package msglib

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
)

const (
	// HeaderLen 是 tag(2) + length(4) 的固定头部长度。
	HeaderLen = 6
	// MaxPayload 是单个字段载荷允许的最大字节数（16 MiB）。
	MaxPayload = 1 << 24
)

// ErrLengthOverflow 表示字段声明的长度越界，整包被拒绝。
var ErrLengthOverflow = errors.New("msglib: declared length out of bounds")

// ErrTruncated 表示数据在字段头部或载荷中间被截断。
var ErrTruncated = errors.New("msglib: truncated packet")

// Kind 描述已知 tag 的归并方式。
type Kind int

const (
	// Scalar 重复出现时取最后一个。
	Scalar Kind = iota
	// List 重复出现时按出现顺序拼接。
	List
)

// Schema 将已知 tag 映射到其归并方式；不在其中的 tag 视为未知。
type Schema map[uint16]Kind

// UnknownField 是一个原样保留的未知字段。
type UnknownField struct {
	Tag   uint16
	Value []byte
}

// Message 是解析后的消息。
type Message struct {
	// Scalars 保存已知标量 tag 的最终取值（重复取末个）。
	Scalars map[uint16][]byte
	// Lists 保存已知列表 tag 拼接后的全部元素。
	Lists map[uint16][][]byte
	// Unknown 按原始相对顺序保存未知字段。
	Unknown []UnknownField
}

// NewMessage 返回一个空消息。
func NewMessage() *Message {
	return &Message{
		Scalars: make(map[uint16][]byte),
		Lists:   make(map[uint16][][]byte),
	}
}

// addField 把一个完整字段按 schema 归并进消息。
func (m *Message) addField(schema Schema, tag uint16, payload []byte) {
	kind, known := schema[tag]
	if !known {
		m.Unknown = append(m.Unknown, UnknownField{Tag: tag, Value: payload})
		return
	}
	if kind == List {
		m.Lists[tag] = append(m.Lists[tag], payload)
		return
	}
	m.Scalars[tag] = payload
}

// Parse 一次性解析完整数据包。长度越界或截断时返回错误并拒绝整包。
func Parse(schema Schema, data []byte) (*Message, error) {
	msg := NewMessage()
	offset := 0
	for offset < len(data) {
		tag, payload, next, err := parseField(data, offset)
		if err != nil {
			return nil, err
		}
		msg.addField(schema, tag, payload)
		offset = next
	}
	return msg, nil
}

// parseField 解析 data[offset:] 处的一个完整字段，返回 tag、载荷与下一偏移。
func parseField(data []byte, offset int) (uint16, []byte, int, error) {
	remaining := len(data) - offset
	if remaining < HeaderLen {
		return 0, nil, 0, fmt.Errorf("%w: need %d header bytes, have %d", ErrTruncated, HeaderLen, remaining)
	}
	tag := binary.BigEndian.Uint16(data[offset : offset+2])
	length := binary.BigEndian.Uint32(data[offset+2 : offset+6])
	if uint64(length) > MaxPayload || uint64(length) > uint64(remaining-HeaderLen) {
		return 0, nil, 0, fmt.Errorf("%w: tag %d declares %d bytes, only %d remain",
			ErrLengthOverflow, tag, length, remaining-HeaderLen)
	}
	payload := data[offset+HeaderLen : offset+HeaderLen+int(length)]
	return tag, payload, offset + HeaderLen + int(length), nil
}

// Encode 规范重编码：已知 tag 升序输出，未知字段保持相对顺序附后。
func (m *Message) Encode() []byte {
	tags := make([]int, 0, len(m.Scalars)+len(m.Lists))
	seen := make(map[uint16]bool, len(m.Scalars)+len(m.Lists))
	for tag := range m.Scalars {
		seen[tag] = true
		tags = append(tags, int(tag))
	}
	for tag := range m.Lists {
		if !seen[tag] {
			tags = append(tags, int(tag))
		}
	}
	sort.Ints(tags)

	size := 0
	for _, tag := range m.Unknown {
		size += HeaderLen + len(tag.Value)
	}
	for _, t := range tags {
		tag := uint16(t)
		if v, ok := m.Scalars[tag]; ok {
			size += HeaderLen + len(v)
		}
		for _, v := range m.Lists[tag] {
			size += HeaderLen + len(v)
		}
	}

	out := make([]byte, 0, size)
	appendField := func(tag uint16, payload []byte) {
		var hdr [HeaderLen]byte
		binary.BigEndian.PutUint16(hdr[0:2], tag)
		binary.BigEndian.PutUint32(hdr[2:6], uint32(len(payload)))
		out = append(out, hdr[:]...)
		out = append(out, payload...)
	}
	for _, t := range tags {
		tag := uint16(t)
		if v, ok := m.Scalars[tag]; ok {
			appendField(tag, v)
		}
		for _, v := range m.Lists[tag] {
			appendField(tag, v)
		}
	}
	for _, u := range m.Unknown {
		appendField(u.Tag, u.Value)
	}
	return out
}
