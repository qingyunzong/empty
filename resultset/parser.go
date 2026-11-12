// Package resultset reassembles and decodes the packet stream of a query
// result set for the query collector. It does not talk to any database:
// callers Push raw bytes (which may stop in the middle of a packet) and
// call Finish at end of stream.
//
// Packet framing: 3-byte little-endian payload length, 1-byte sequence
// number, then the payload. The length excludes the 4-byte header. A
// length of 0 or above the host's maxPayload is rejected as soon as the
// 3 length bytes are complete, before any payload-sized allocation.
package resultset

import (
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf8"
)

// Row is one result row. A nil Value is a SQL NULL (0xFB); a non-nil
// empty slice is an empty string.
type Row [][]byte

// ErrorPacket is a delivered 0xFF error packet.
type ErrorPacket struct {
	Code    uint16
	State   string
	Message string
}

// Result accumulates everything delivered so far. It stays populated
// even after a failure: packets delivered before the error are kept.
type Result struct {
	ColumnCount uint64
	Columns     [][]byte // column definition payloads, kept as-is
	Warnings    uint16
	Status      uint16
	Rows        []Row
	Err         *ErrorPacket // set when an error packet was delivered
}

type state int

const (
	stateColumnCount state = iota
	stateColumnDefs
	stateColumnsEOF
	stateRows
	stateDone
)

// Parser is a streaming decoder for one result set. It is not safe for
// concurrent use.
type Parser struct {
	maxPayload uint32
	nextSeq    uint8

	buf      []byte // unconsumed bytes, never more than one partial packet
	pending  uint32 // declared payload length of the packet under assembly
	headerOK bool   // length bytes validated and pending is meaningful

	state         state
	colsRemaining uint64

	result *Result
	err    error // sticky: once set, the component is stopped
}

// NewParser returns a Parser that rejects payloads larger than
// maxPayload and expects the first packet to carry sequence startSeq.
func NewParser(maxPayload uint32, startSeq uint8) *Parser {
	return &Parser{
		maxPayload: maxPayload,
		nextSeq:    startSeq,
		result:     &Result{},
	}
}

// Result returns the packets delivered so far, including after a
// failure.
func (p *Parser) Result() *Result { return p.result }

// Push feeds stream bytes, which may end in the middle of a packet.
// The first error stops the component and is returned by every later
// call.
func (p *Parser) Push(data []byte) error {
	if p.err != nil {
		return p.err
	}
	p.buf = append(p.buf, data...)
	for {
		if !p.headerOK {
			if len(p.buf) < 3 {
				return nil
			}
			length := uint32(p.buf[0]) | uint32(p.buf[1])<<8 | uint32(p.buf[2])<<16
			if length == 0 || length > p.maxPayload {
				return p.fail(fmt.Errorf("resultset: payload length %d out of range (max %d)", length, p.maxPayload))
			}
			p.pending = length
			p.headerOK = true
		}
		if len(p.buf) < 4 {
			return nil
		}
		if seq := p.buf[3]; seq != p.nextSeq {
			return p.fail(fmt.Errorf("resultset: sequence %d, want %d", seq, p.nextSeq))
		}
		total := 4 + int(p.pending)
		if len(p.buf) < total {
			return nil
		}
		payload := p.buf[4:total]
		p.buf = p.buf[total:]
		if len(p.buf) == 0 {
			p.buf = nil
		}
		p.nextSeq++
		p.headerOK = false
		if err := p.handlePacket(payload); err != nil {
			return p.fail(err)
		}
		if p.state == stateDone {
			if len(p.buf) > 0 {
				return p.fail(errors.New("resultset: trailing data after end of result set"))
			}
			return nil
		}
	}
}

// Finish ends the stream. It fails if a packet is still incomplete.
// The accumulated Result is returned either way.
func (p *Parser) Finish() (*Result, error) {
	if p.err != nil {
		return p.result, p.err
	}
	if len(p.buf) > 0 || p.headerOK {
		p.err = errors.New("resultset: stream ended in the middle of a packet")
		return p.result, p.err
	}
	return p.result, nil
}

func (p *Parser) fail(err error) error {
	p.err = err
	return err
}

func (p *Parser) handlePacket(payload []byte) error {
	if payload[0] == 0xFF {
		return p.handleErrorPacket(payload)
	}
	switch p.state {
	case stateColumnCount:
		n, used, err := parseLenEncInt(payload)
		if err != nil {
			return fmt.Errorf("resultset: column count: %w", err)
		}
		if used != len(payload) {
			return fmt.Errorf("resultset: column count packet has %d trailing byte(s)", len(payload)-used)
		}
		if n == 0 {
			return errors.New("resultset: column count must be greater than 0")
		}
		p.result.ColumnCount = n
		p.colsRemaining = n
		p.state = stateColumnDefs
	case stateColumnDefs:
		col := make([]byte, len(payload))
		copy(col, payload)
		p.result.Columns = append(p.result.Columns, col)
		p.colsRemaining--
		if p.colsRemaining == 0 {
			p.state = stateColumnsEOF
		}
	case stateColumnsEOF:
		if err := p.handleEOF(payload); err != nil {
			return err
		}
		p.state = stateRows
	case stateRows:
		if payload[0] == 0xFE && len(payload) < 9 {
			if err := p.handleEOF(payload); err != nil {
				return err
			}
			p.state = stateDone
			return nil
		}
		row, err := parseRow(payload, p.result.ColumnCount)
		if err != nil {
			return err
		}
		p.result.Rows = append(p.result.Rows, row)
	case stateDone:
		return errors.New("resultset: packet after end of result set")
	}
	return nil
}

// handleEOF parses an end packet: 0xFE, then little-endian uint16
// warnings and uint16 status. The payload must be exactly 5 bytes.
func (p *Parser) handleEOF(payload []byte) error {
	if payload[0] != 0xFE {
		return fmt.Errorf("resultset: expected end packet, got first byte 0x%02X", payload[0])
	}
	if len(payload) != 5 {
		return fmt.Errorf("resultset: end packet length %d, want 5", len(payload))
	}
	p.result.Warnings = binary.LittleEndian.Uint16(payload[1:3])
	p.result.Status = binary.LittleEndian.Uint16(payload[3:5])
	return nil
}

func (p *Parser) handleErrorPacket(payload []byte) error {
	if len(payload) < 9 {
		return fmt.Errorf("resultset: error packet length %d, want at least 9", len(payload))
	}
	if payload[3] != '#' {
		return fmt.Errorf("resultset: error packet missing '#' marker, got 0x%02X", payload[3])
	}
	msg := payload[9:]
	if !utf8.Valid(msg) {
		return errors.New("resultset: error packet message is not valid UTF-8")
	}
	p.result.Err = &ErrorPacket{
		Code:    binary.LittleEndian.Uint16(payload[1:3]),
		State:   string(payload[4:9]),
		Message: string(msg),
	}
	p.state = stateDone
	return nil
}

// parseLenEncInt decodes a length-encoded integer at the start of b and
// returns the value and the number of bytes consumed.
func parseLenEncInt(b []byte) (uint64, int, error) {
	if len(b) == 0 {
		return 0, 0, errors.New("missing length-encoded integer")
	}
	switch b[0] {
	case 0xFB:
		return 0, 0, errors.New("0xFB is not allowed in length position")
	case 0xFC:
		if len(b) < 3 {
			return 0, 0, errors.New("truncated 0xFC length-encoded integer")
		}
		return uint64(binary.LittleEndian.Uint16(b[1:3])), 3, nil
	case 0xFD:
		if len(b) < 4 {
			return 0, 0, errors.New("truncated 0xFD length-encoded integer")
		}
		return uint64(b[1]) | uint64(b[2])<<8 | uint64(b[3])<<16, 4, nil
	case 0xFE:
		if len(b) < 9 {
			return 0, 0, errors.New("truncated 0xFE length-encoded integer")
		}
		return binary.LittleEndian.Uint64(b[1:9]), 9, nil
	default:
		return uint64(b[0]), 1, nil
	}
}

func parseRow(payload []byte, cols uint64) (Row, error) {
	row := make(Row, cols)
	off := 0
	for i := uint64(0); i < cols; i++ {
		if off >= len(payload) {
			return nil, fmt.Errorf("resultset: row has fewer than %d columns", cols)
		}
		if payload[off] == 0xFB {
			row[i] = nil
			off++
			continue
		}
		n, used, err := parseLenEncInt(payload[off:])
		if err != nil {
			return nil, fmt.Errorf("resultset: row column %d: %w", i, err)
		}
		off += used
		if n > uint64(len(payload)-off) {
			return nil, fmt.Errorf("resultset: row column %d declares %d bytes, only %d left", i, n, len(payload)-off)
		}
		v := make([]byte, n)
		copy(v, payload[off:off+int(n)])
		row[i] = v
		off += int(n)
	}
	if off != len(payload) {
		return nil, fmt.Errorf("resultset: row has %d trailing byte(s) after %d columns", len(payload)-off, cols)
	}
	return row, nil
}
