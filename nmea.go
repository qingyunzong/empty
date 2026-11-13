package dataeng

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ParseNMEA parses an NMEA 0183 AIS VDM/VDO sentence:
//
//	!AIVDM,<total>,<number>,<sequence>,<channel>,<payload>,<fill>*<checksum>
//
// The channel/radio field is deliberately ignored. MessageID is the
// sequence field. The payload is decoded from six-bit ASCII armor into bits;
// FillBits is left in Bits so the Assembler can remove it at the end of the
// complete message.
//
// When the checksum or a field is bad, ParseNMEA returns the best fragment it
// could build together with an error. The returned Sentence records the parse
// error in Err, so passing it to Add or AddLine makes the owning message fail
// when its identifier is available.
func ParseNMEA(line string) (Sentence, error) {
	var s Sentence

	line = strings.TrimSpace(line)
	if len(line) < 2 || (line[0] != '!' && line[0] != '$') {
		err := fmt.Errorf("%w: missing NMEA start delimiter", ErrMalformedNMEA)
		s.Err = err
		return s, err
	}

	body := line[1:]
	var checksumErr error
	star := strings.LastIndexByte(body, '*')
	if star >= 0 {
		checksumText := strings.TrimSpace(body[star+1:])
		expected, err := strconv.ParseUint(checksumText, 16, 8)
		if err != nil {
			checksumErr = fmt.Errorf("%w: invalid checksum %q", ErrMalformedNMEA, checksumText)
		} else {
			var actual byte
			for i := 0; i < star; i++ {
				actual ^= body[i]
			}
			if byte(expected) != actual {
				checksumErr = fmt.Errorf("%w: got %02X, want %02X",
					ErrChecksum, actual, byte(expected))
			}
		}
		body = body[:star]
	}

	fields := strings.Split(body, ",")
	if len(fields) < 7 {
		err := fmt.Errorf("%w: got %d fields, want at least 7", ErrMalformedNMEA, len(fields))
		s.Err = err
		return s, err
	}

	s.MessageID = strings.TrimSpace(fields[3])

	var parseErr error
	parseInt := func(field int, name string) int {
		text := strings.TrimSpace(fields[field])
		value, err := strconv.Atoi(text)
		if err != nil {
			parseErr = fmt.Errorf("%w: %s is not an integer: %q", ErrMalformedNMEA, name, text)
			return 0
		}
		return value
	}

	s.Total = parseInt(1, "total")
	s.Number = parseInt(2, "number")
	s.FillBits = parseInt(6, "fill bits")

	bits, err := decodeSixBit(fields[5])
	if err != nil && parseErr == nil {
		parseErr = err
	}
	s.Bits = bits

	err = parseErr
	if err == nil {
		err = checksumErr
	}
	if err != nil {
		s.Err = err
	}
	return s, err
}

// AddLine parses an NMEA sentence and submits it. A malformed or checksum-failed
// sentence is not stored; if its message identifier could be read, that message
// is failed as required by the assembler contract.
func (a *Assembler) AddLine(line string, at ...time.Time) Result {
	s, err := ParseNMEA(line)
	if err != nil && s.MessageID == "" && s.Total == 0 && s.Number == 0 {
		return Result{Status: StatusFailed, MessageID: s.MessageID, Err: err}
	}
	return a.Add(s, at...)
}

func decodeSixBit(payload string) ([]byte, error) {
	bits := make([]byte, 0, len(payload)*6)
	for i := 0; i < len(payload); i++ {
		c := payload[i]
		var value byte
		switch {
		case c >= 48 && c <= 87:
			value = c - 48
		case c >= 96 && c <= 119:
			value = c - 56
		default:
			return bits, fmt.Errorf("%w: invalid six-bit character %q at payload byte %d",
				ErrMalformedNMEA, c, i)
		}
		for shift := 5; shift >= 0; shift-- {
			bits = append(bits, (value>>uint(shift))&1)
		}
	}
	return bits, nil
}
