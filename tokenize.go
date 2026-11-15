package dataeng

import (
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"strings"
	"unicode/utf8"
)

// Record is one logical CSV record. Line is the 1-based physical line on which
// the record starts; quoted fields may span multiple physical lines.
type Record struct {
	Fields     []string `json:"fields"`
	Line       int      `json:"line"`
	Terminator string   `json:"terminator"`
}

// ParseError describes a structural problem found while tokenising CSV data.
type ParseError struct {
	Line    int    `json:"line"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

func (e *ParseError) Error() string {
	if e == nil {
		return ""
	}
	if e.Line > 0 {
		return fmt.Sprintf("csvdialect: line %d: %s", e.Line, e.Message)
	}
	return "csvdialect: " + e.Message
}

const (
	parseErrorUnterminatedQuote = "unterminated_quote"
	parseErrorBareQuote         = "bare_quote"
	parseErrorTextAfterQuote    = "text_after_quote"
	parseErrorTrailingEscape    = "trailing_escape"
)

// ParseError.Kind values.
const (
	ParseErrorUnterminatedQuote = parseErrorUnterminatedQuote
	ParseErrorBareQuote         = parseErrorBareQuote
	ParseErrorTextAfterQuote    = parseErrorTextAfterQuote
	ParseErrorTrailingEscape    = parseErrorTrailingEscape
)

type tokenizeOptions struct {
	CollectRecords  bool
	ExpectedWidth   int
	PotentialQuotes []rune
}

type parseStats struct {
	Records              int
	NonBlankRecords      int
	BlankRecords         int
	Fields               int
	WidthCounts          map[int]int
	DelimiterOccurrences int
	RecordsWithDelimiter int
	QuotedFields         int
	EmbeddedDelimiters   int
	EmbeddedNewlines     int
	DoubledQuoteEscapes  int
	EscapeUses           int
	EscapeLikeSequences  int
	EscapeErrors         int
	QuoteErrors          int
	BareQuotes           int
	UnterminatedQuotes   int
	TextAfterQuote       int
	QuoteLikeFields      int
	NewlineCounts        map[string]int
	QuotedNewlineCounts  map[string]int
	NewlineFirstLine     map[string]int
	WidthMismatchCount   int
	FirstMismatchLine    int
	FirstMismatchWidth   int
	Signature            uint64
	ErrorCount           int
	FirstError           *ParseError
	RecordsData          []Record
}

type tokenState uint8

const (
	stateFieldStart tokenState = iota
	stateUnquoted
	stateQuoted
	stateAfterQuote
)

func tokenize(text string, d Dialect, opt tokenizeOptions) parseStats {
	d = d.withDefaults()
	st := parseStats{
		WidthCounts:         make(map[int]int),
		NewlineCounts:       make(map[string]int),
		QuotedNewlineCounts: make(map[string]int),
		NewlineFirstLine:    make(map[string]int),
	}
	hasher := fnv.New64a()
	var field strings.Builder
	fields := make([]string, 0, 8)
	width := 0
	line := 1
	recordStartLine := 1
	recordStarted := false
	state := stateFieldStart

	startRecord := func() {
		if !recordStarted {
			recordStarted = true
			recordStartLine = line
		}
	}

	finishField := func() {
		value := field.String()
		st.Fields++
		width++
		if opt.CollectRecords {
			fields = append(fields, value)
		}
		writeHashString(hasher, value)
		hasher.Write([]byte{0x1F})
		if fieldLooksQuoted(value, opt.PotentialQuotes) {
			st.QuoteLikeFields++
		}
		field.Reset()
	}

	finishRecord := func(terminator string) {
		if !recordStarted {
			st.BlankRecords++
			return
		}
		st.Records++
		st.NonBlankRecords++
		st.WidthCounts[width]++
		if width > 1 {
			st.RecordsWithDelimiter++
		}
		hasher.Write([]byte{0x1E})
		if opt.ExpectedWidth > 0 && width != opt.ExpectedWidth {
			st.WidthMismatchCount++
			if st.FirstMismatchLine == 0 {
				st.FirstMismatchLine = recordStartLine
				st.FirstMismatchWidth = width
			}
		}
		if opt.CollectRecords {
			st.RecordsData = append(st.RecordsData, Record{
				Fields:     append([]string(nil), fields...),
				Line:       recordStartLine,
				Terminator: terminator,
			})
		}
		fields = fields[:0]
		width = 0
		recordStarted = false
	}

	addError := func(kind string, atLine int, message string) {
		st.ErrorCount++
		if st.FirstError == nil {
			st.FirstError = &ParseError{Line: atLine, Kind: kind, Message: message}
		}
	}

	recordNewline := func(terminator string, atLine int) {
		st.NewlineCounts[terminator]++
		if _, ok := st.NewlineFirstLine[terminator]; !ok {
			st.NewlineFirstLine[terminator] = atLine
		}
	}

	quotedNewline := func(terminator string, atLine int) {
		st.EmbeddedNewlines++
		st.QuotedNewlineCounts[terminator]++
		_ = atLine
	}

	for i := 0; i < len(text); {
		r, size := utf8.DecodeRuneInString(text[i:])
		if r == utf8.RuneError && size == 1 {
			// Decoders normally guarantee valid UTF-8. Treat a stray byte as
			// literal text rather than losing it.
			size = 1
		}
		nextRune := rune(0)
		nextSize := 0
		if i+size < len(text) {
			nextRune, nextSize = utf8.DecodeRuneInString(text[i+size:])
		}
		if d.Escape == 0 && r == '\\' && nextSize > 0 && state != stateQuoted {
			if nextRune == d.Delimiter || nextRune == d.Quote || nextRune == '\r' || nextRune == '\n' {
				st.EscapeLikeSequences++
			}
		}

		switch state {
		case stateQuoted:
			switch {
			case d.Escape != 0 && r == d.Escape:
				if nextSize == 0 {
					st.EscapeErrors++
					addError(parseErrorTrailingEscape, line, "quoted field ends with an escape character")
					field.WriteRune(r)
					startRecord()
					i += size
					continue
				}
				if isEscapable(nextRune, d) {
					if nextRune == '\r' && i+size+nextSize < len(text) {
						after, afterSize := utf8.DecodeRuneInString(text[i+size+nextSize:])
						if after == '\n' {
							field.WriteString("\r\n")
							quotedNewline("\r\n", line)
							line++
							st.EscapeUses++
							i += size + nextSize + afterSize
							continue
						}
					}
					field.WriteRune(nextRune)
					st.EscapeUses++
					if nextRune == '\r' || nextRune == '\n' {
						quotedNewline(string(nextRune), line)
						line++
					}
					i += size + nextSize
					continue
				}
				field.WriteRune(r)
				startRecord()
				i += size
				continue

			case r == d.Quote:
				if d.DoubleQuote && nextRune == d.Quote {
					field.WriteRune(d.Quote)
					st.DoubledQuoteEscapes++
					i += size + nextSize
					continue
				}
				state = stateAfterQuote
				i += size
				continue

			case r == '\r':
				if nextRune == '\n' {
					field.WriteString("\r\n")
					quotedNewline("\r\n", line)
					line++
					i += size + nextSize
					continue
				}
				field.WriteRune(r)
				quotedNewline("\r", line)
				line++
				i += size
				continue

			case r == '\n':
				field.WriteRune(r)
				quotedNewline("\n", line)
				line++
				i += size
				continue

			case r == d.Delimiter:
				st.EmbeddedDelimiters++
				field.WriteRune(r)
				startRecord()
				i += size
				continue

			default:
				field.WriteRune(r)
				startRecord()
				i += size
				continue
			}

		case stateAfterQuote:
			switch {
			case r == ' ' || r == '\t':
				i += size
				continue
			case r == d.Delimiter:
				finishField()
				st.DelimiterOccurrences++
				state = stateFieldStart
				startRecord()
				i += size
				continue
			case r == '\r':
				if nextRune == '\n' {
					finishField()
					recordNewline("\r\n", line)
					line++
					finishRecord("\r\n")
					state = stateFieldStart
					i += size + nextSize
					continue
				}
				finishField()
				recordNewline("\r", line)
				line++
				finishRecord("\r")
				state = stateFieldStart
				i += size
				continue
			case r == '\n':
				finishField()
				recordNewline("\n", line)
				line++
				finishRecord("\n")
				state = stateFieldStart
				i += size
				continue
			default:
				st.TextAfterQuote++
				st.QuoteErrors++
				addError(parseErrorTextAfterQuote, line, fmt.Sprintf("unexpected %q after closing quote", r))
				field.WriteRune(r)
				state = stateUnquoted
				startRecord()
				i += size
				continue
			}

		case stateFieldStart:
			switch {
			case d.Quote != 0 && r == d.Quote:
				state = stateQuoted
				st.QuotedFields++
				startRecord()
				i += size
				continue
			case d.Escape != 0 && r == d.Escape:
				if nextSize == 0 {
					st.EscapeErrors++
					addError(parseErrorTrailingEscape, line, "field ends with an escape character")
					field.WriteRune(r)
					state = stateUnquoted
					startRecord()
					i += size
					continue
				}
				if nextSize > 0 && isEscapable(nextRune, d) {
					if nextRune == '\r' && i+size+nextSize < len(text) {
						after, afterSize := utf8.DecodeRuneInString(text[i+size+nextSize:])
						if after == '\n' {
							field.WriteString("\r\n")
							st.EscapeUses++
							line++
							state = stateUnquoted
							startRecord()
							i += size + nextSize + afterSize
							continue
						}
					}
					field.WriteRune(nextRune)
					st.EscapeUses++
					if nextRune == '\r' || nextRune == '\n' {
						line++
					}
					state = stateUnquoted
					startRecord()
					i += size + nextSize
					continue
				}
				field.WriteRune(r)
				state = stateUnquoted
				startRecord()
				i += size
				continue
			case r == d.Delimiter:
				finishField()
				st.DelimiterOccurrences++
				startRecord()
				i += size
				continue
			case r == '\r':
				if nextRune == '\n' {
					if recordStarted {
						finishField()
						recordNewline("\r\n", line)
						line++
						finishRecord("\r\n")
					} else {
						st.BlankRecords++
						recordNewline("\r\n", line)
						line++
					}
					i += size + nextSize
					continue
				}
				if recordStarted {
					finishField()
					recordNewline("\r", line)
					line++
					finishRecord("\r")
				} else {
					st.BlankRecords++
					recordNewline("\r", line)
					line++
				}
				i += size
				continue
			case r == '\n':
				if recordStarted {
					finishField()
					recordNewline("\n", line)
					line++
					finishRecord("\n")
				} else {
					st.BlankRecords++
					recordNewline("\n", line)
					line++
				}
				i += size
				continue
			case r == ' ' || r == '\t':
				field.WriteRune(r)
				startRecord()
				i += size
				continue
			default:
				field.WriteRune(r)
				state = stateUnquoted
				startRecord()
				i += size
				continue
			}

		case stateUnquoted:
			switch {
			case d.Escape != 0 && r == d.Escape:
				if nextSize == 0 {
					st.EscapeErrors++
					addError(parseErrorTrailingEscape, line, "field ends with an escape character")
					field.WriteRune(r)
					startRecord()
					i += size
					continue
				}
				if nextSize > 0 && isEscapable(nextRune, d) {
					if nextRune == '\r' && i+size+nextSize < len(text) {
						after, afterSize := utf8.DecodeRuneInString(text[i+size+nextSize:])
						if after == '\n' {
							field.WriteString("\r\n")
							st.EscapeUses++
							line++
							startRecord()
							i += size + nextSize + afterSize
							continue
						}
					}
					field.WriteRune(nextRune)
					st.EscapeUses++
					if nextRune == '\r' || nextRune == '\n' {
						line++
					}
					startRecord()
					i += size + nextSize
					continue
				}
				field.WriteRune(r)
				startRecord()
				i += size
				continue
			case r == d.Delimiter:
				finishField()
				st.DelimiterOccurrences++
				state = stateFieldStart
				startRecord()
				i += size
				continue
			case r == '\r':
				if nextRune == '\n' {
					finishField()
					recordNewline("\r\n", line)
					line++
					finishRecord("\r\n")
					state = stateFieldStart
					i += size + nextSize
					continue
				}
				finishField()
				recordNewline("\r", line)
				line++
				finishRecord("\r")
				state = stateFieldStart
				i += size
				continue
			case r == '\n':
				finishField()
				recordNewline("\n", line)
				line++
				finishRecord("\n")
				state = stateFieldStart
				i += size
				continue
			case r == d.Quote:
				st.BareQuotes++
				st.QuoteErrors++
				addError(parseErrorBareQuote, line, "quote character inside an unquoted field")
				field.WriteRune(r)
				startRecord()
				i += size
				continue
			default:
				field.WriteRune(r)
				startRecord()
				i += size
				continue
			}
		}
	}

	if state == stateQuoted {
		st.UnterminatedQuotes++
		st.QuoteErrors++
		addError(parseErrorUnterminatedQuote, line, "quoted field is not terminated")
	}
	if recordStarted {
		finishField()
		finishRecord("")
	}
	st.Signature = hasher.Sum64()
	return st
}

func isEscapable(r rune, d Dialect) bool {
	if r == 0 {
		return false
	}
	return r == d.Quote || r == d.Delimiter || r == d.Escape || r == '\r' || r == '\n'
}

func writeHashString(h interface{ Write([]byte) (int, error) }, value string) {
	var size [8]byte
	binary.LittleEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = h.Write(size[:])
	_, _ = h.Write([]byte(value))
}

func fieldLooksQuoted(value string, quotes []rune) bool {
	if value == "" {
		return false
	}
	i := 0
	for i < len(value) {
		r, size := utf8.DecodeRuneInString(value[i:])
		if r != ' ' && r != '\t' {
			for _, quote := range quotes {
				if quote != 0 && r == quote {
					return true
				}
			}
			return false
		}
		i += size
	}
	return false
}
