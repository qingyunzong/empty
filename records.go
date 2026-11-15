package dataeng

import (
	"bytes"
	"strings"
)

// rawRecord is one physical HL7 segment plus the exact position and line
// terminator that produced it.
type rawRecord struct {
	id         string
	line       int
	offset     int
	endOffset  int
	content    string
	terminator string
}

func (r rawRecord) rawEndOffset() int {
	return r.endOffset + len(r.terminator)
}

func (r rawRecord) isBlank() bool {
	return strings.TrimSpace(r.content) == ""
}

func splitRecords(data []byte) []rawRecord {
	if len(data) == 0 {
		return nil
	}

	start := 0
	if bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		start = 3
	}

	records := make([]rawRecord, 0, bytes.Count(data, []byte{'\n'})+1)
	line := 1
	for start < len(data) {
		contentStart := start
		end := contentStart
		for end < len(data) && data[end] != '\r' && data[end] != '\n' {
			end++
		}

		terminatorEnd := end
		terminator := ""
		if end < len(data) {
			if data[end] == '\r' && end+1 < len(data) && data[end+1] == '\n' {
				terminatorEnd = end + 2
				terminator = "\r\n"
			} else {
				terminatorEnd = end + 1
				terminator = string(data[end : end+1])
			}
		}

		content := string(data[contentStart:end])
		id := ""
		if len(content) >= 3 {
			id = content[:3]
		}
		records = append(records, rawRecord{
			id:         id,
			line:       line,
			offset:     contentStart,
			endOffset:  end,
			content:    content,
			terminator: terminator,
		})

		line++
		start = terminatorEnd
	}
	return records
}
