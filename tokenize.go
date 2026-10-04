package rsp

import (
	"fmt"
	"os"
	"strings"
)

func readFileOS(name string) ([]byte, error) { return os.ReadFile(name) }

// tokenize splits response file content into tokens. Whitespace separates
// tokens. Single quotes group literally; double quotes group with backslash
// escapes for \" and \\; outside quotes a backslash escapes the next byte
// (including whitespace and quote characters). Quoted and unquoted segments
// concatenate into a single token. Each token records the byte range of its
// raw text within the file.
func tokenize(content, file string) ([]Token, error) {
	var tokens []Token
	var text strings.Builder
	start := -1
	i := 0
	for i < len(content) {
		c := content[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			if start >= 0 {
				tokens = append(tokens, Token{
					Text:   text.String(),
					Source: SourceRange{File: file, Start: start, End: i},
				})
				text.Reset()
				start = -1
			}
			i++
		case c == '\\':
			if start < 0 {
				start = i
			}
			if i+1 >= len(content) {
				return nil, fmt.Errorf("rsp: %s:%d: trailing backslash", file, i)
			}
			text.WriteByte(content[i+1])
			i += 2
		case c == '\'':
			if start < 0 {
				start = i
			}
			end := strings.IndexByte(content[i+1:], '\'')
			if end < 0 {
				return nil, fmt.Errorf("rsp: %s:%d: unterminated single quote", file, i)
			}
			text.WriteString(content[i+1 : i+1+end])
			i += end + 2
		case c == '"':
			if start < 0 {
				start = i
			}
			i++
			closed := false
			for i < len(content) {
				switch content[i] {
				case '"':
					closed = true
					i++
				case '\\':
					if i+1 < len(content) && (content[i+1] == '"' || content[i+1] == '\\') {
						text.WriteByte(content[i+1])
						i += 2
						continue
					}
					text.WriteByte(content[i])
					i++
				default:
					text.WriteByte(content[i])
					i++
				}
				if closed {
					break
				}
			}
			if !closed {
				return nil, fmt.Errorf("rsp: %s:%d: unterminated double quote", file, start)
			}
		default:
			if start < 0 {
				start = i
			}
			text.WriteByte(c)
			i++
		}
	}
	if start >= 0 {
		tokens = append(tokens, Token{
			Text:   text.String(),
			Source: SourceRange{File: file, Start: start, End: len(content)},
		})
	}
	return tokens, nil
}
