package appendlog

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"strconv"
)

// encodeFrame renders data as "<decimal length>:<data>\n".
func encodeFrame(data []byte) []byte {
	var buf bytes.Buffer
	buf.WriteString(strconv.Itoa(len(data)))
	buf.WriteByte(':')
	buf.Write(data)
	buf.WriteByte('\n')
	return buf.Bytes()
}

// readAllFrames decodes every complete frame from r. A truncated final frame
// (from an interrupted write) is ignored; the returned size is the number of
// bytes belonging to complete frames.
func readAllFrames(r io.Reader) (records [][]byte, size int64, err error) {
	br := bufio.NewReader(r)
	var offset int64
	for {
		line, readErr := br.ReadBytes('\n')
		consumed := int64(len(line))
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, 0, readErr
		}
		data, ok := decodeFrame(line)
		if ok {
			records = append(records, data)
			offset += consumed
		} else if readErr == nil {
			return nil, 0, errors.New("appendlog: corrupt frame")
		}
		// On EOF, an undecodable tail is a partial write and is dropped.
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return records, offset, nil
			}
			return nil, 0, readErr
		}
	}
}

// decodeFrame parses one "<length>:<data>\n" frame.
func decodeFrame(line []byte) ([]byte, bool) {
	if len(line) == 0 || line[len(line)-1] != '\n' {
		return nil, false
	}
	colon := bytes.IndexByte(line, ':')
	if colon <= 0 {
		return nil, false
	}
	length, err := strconv.Atoi(string(line[:colon]))
	if err != nil || length < 0 {
		return nil, false
	}
	data := line[colon+1 : len(line)-1]
	if len(data) != length {
		return nil, false
	}
	return append([]byte(nil), data...), true
}
