// Package dataeng provides recoverable CSV dialect detection for byte samples.
package dataeng

import (
	"fmt"
	"sort"
	"strings"
)

// LineEnding identifies the record terminator used by a dialect.
type LineEnding uint8

const (
	// LF terminates records with a single line feed (0x0a).
	LF LineEnding = iota
	// CRLF terminates records with a carriage return followed by a line feed.
	CRLF

	// LineFeed is an alias for LF.
	LineFeed = LF
)

// String implements fmt.Stringer.
func (e LineEnding) String() string {
	switch e {
	case LF:
		return "LF"
	case CRLF:
		return "CRLF"
	default:
		return fmt.Sprintf("LineEnding(%d)", byte(e))
	}
}

// Dialect describes one candidate CSV grammar. The quote character is always
// the ASCII double quote. Delimiters are always a single byte.
type Dialect struct {
	Delimiter  byte
	Quote      bool
	LineEnding LineEnding
}

// Candidate is an alias for Dialect, useful when describing the input list.
type Candidate = Dialect

// String implements fmt.Stringer.
func (d Dialect) String() string {
	quoted := "unquoted"
	if d.Quote {
		quoted = "quoted"
	}
	return fmt.Sprintf("delimiter=%q %s eol=%s", d.Delimiter, quoted, d.LineEnding)
}

// Sample is a finite byte sample and whether its final record may be cut off.
type Sample struct {
	Data      []byte
	Truncated bool
}

// RecordRange is a half-open byte interval [Start, End) for one record.
// Complete records include their record terminator. A final record at EOF
// extends to len(data).
type RecordRange struct {
	Start int
	End   int
}

// Len returns the number of bytes in the range.
func (r RecordRange) Len() int {
	return r.End - r.Start
}

// Record is an alias for RecordRange.
type Record = RecordRange

// ParseError describes the earliest syntax error found in one candidate.
// Offset is a zero-based byte offset. Record is a zero-based record number.
type ParseError struct {
	Offset  int
	Record  int
	Message string
}

// Error implements error.
func (e *ParseError) Error() string {
	if e == nil {
		return "<nil>"
	}
	return fmt.Sprintf("record %d at byte %d: %s", e.Record, e.Offset, e.Message)
}

// Score is the lexicographically ordered score used to compare valid dialects.
// Higher values are better for all three fields.
type Score struct {
	CompleteRecords int
	ModeFrequency   int
	ModeColumns     int
}

// CandidateResult records the outcome of evaluating one candidate.
type CandidateResult struct {
	Index   int
	Dialect Dialect
	Valid   bool
	Records []RecordRange
	Error   *ParseError
	Score   Score
}

// Result is the result of evaluating a candidate list. When at least one
// candidate is valid, Valid is true, Index identifies the selected candidate,
// and Dialect and Records describe that candidate. Candidates always contains
// one entry per input candidate, including the earliest error for each invalid
// candidate.
type Result struct {
	Valid      bool
	Index      int
	Dialect    Dialect
	Records    []RecordRange
	Score      Score
	Candidates []CandidateResult
}

type parsedRecord struct {
	span     RecordRange
	columns  int
	complete bool
}

// Detect parses the sample under every candidate and selects the highest
// scoring valid dialect. If no candidate is valid, Result.Valid is false and
// each candidate's earliest error is available in Result.Candidates.
func Detect(data []byte, candidates []Dialect, truncated bool) Result {
	result := Result{
		Valid:      false,
		Index:      -1,
		Candidates: make([]CandidateResult, len(candidates)),
	}

	best := -1
	for i, candidate := range candidates {
		records, parseErr := parse(data, candidate, truncated)
		candidateResult := CandidateResult{
			Index:   i,
			Dialect: candidate,
			Valid:   parseErr == nil,
			Error:   parseErr,
		}
		if parseErr == nil {
			candidateResult.Records = spans(records)
			candidateResult.Score = score(records)
			if best == -1 || better(candidateResult.Score, result.Candidates[best].Score) {
				best = i
			}
		} else {
			candidateResult.Records = nil
		}
		result.Candidates[i] = candidateResult
	}

	if best < 0 {
		return result
	}

	selected := result.Candidates[best]
	result.Valid = true
	result.Index = selected.Index
	result.Dialect = selected.Dialect
	result.Records = selected.Records
	result.Score = selected.Score
	return result
}

// DetectSample is Detect for a Sample value.
func DetectSample(sample Sample, candidates []Dialect) Result {
	return Detect(sample.Data, candidates, sample.Truncated)
}

// Select is an alias for Detect.
func Select(data []byte, candidates []Dialect, truncated bool) Result {
	return Detect(data, candidates, truncated)
}

// Choose is an alias for Detect.
func Choose(data []byte, candidates []Dialect, truncated bool) Result {
	return Detect(data, candidates, truncated)
}

// Parse parses one dialect. It returns the record ranges on success, including
// the final record when the sample is truncated. On failure it returns the
// earliest syntax error and no record ranges.
func Parse(data []byte, dialect Dialect, truncated bool) ([]RecordRange, *ParseError) {
	records, err := parse(data, dialect, truncated)
	if err != nil {
		return nil, err
	}
	return spans(records), nil
}

func spans(records []parsedRecord) []RecordRange {
	out := make([]RecordRange, len(records))
	for i, record := range records {
		out[i] = record.span
	}
	return out
}

func score(records []parsedRecord) Score {
	var result Score
	counts := make(map[int]int)
	for _, record := range records {
		if !record.complete {
			continue
		}
		result.CompleteRecords++
		counts[record.columns]++
	}

	// Iterating map keys would be nondeterministic, so sort them. The explicit
	// larger-column tie-break makes the result stable either way.
	columns := make([]int, 0, len(counts))
	for value := range counts {
		columns = append(columns, value)
	}
	sort.Ints(columns)
	for _, value := range columns {
		frequency := counts[value]
		if frequency > result.ModeFrequency ||
			(frequency == result.ModeFrequency && value > result.ModeColumns) {
			result.ModeFrequency = frequency
			result.ModeColumns = value
		}
	}
	return result
}

func better(candidate, current Score) bool {
	if candidate.CompleteRecords != current.CompleteRecords {
		return candidate.CompleteRecords > current.CompleteRecords
	}
	if candidate.ModeFrequency != current.ModeFrequency {
		return candidate.ModeFrequency > current.ModeFrequency
	}
	return candidate.ModeColumns > current.ModeColumns
}

func parse(data []byte, dialect Dialect, truncated bool) ([]parsedRecord, *ParseError) {
	if dialect.LineEnding != LF && dialect.LineEnding != CRLF {
		return nil, &ParseError{Message: "invalid line ending"}
	}
	if (dialect.Quote && dialect.Delimiter == '"') ||
		(dialect.LineEnding == LF && dialect.Delimiter == '\n') ||
		(dialect.LineEnding == CRLF && dialect.Delimiter == '\r') {
		return nil, &ParseError{Message: "invalid delimiter"}
	}

	terminatorLength := 1
	if dialect.LineEnding == CRLF {
		terminatorLength = 2
	}

	records := make([]parsedRecord, 0)
	position := 0
	for position < len(data) {
		start := position
		columns := 1
		atFieldStart := true
		inQuotes := false
		afterQuote := false
		recordFinished := false
		complete := false

		for position < len(data) {
			b := data[position]

			if inQuotes {
				if b == '"' {
					if position+1 < len(data) && data[position+1] == '"' {
						position += 2
						continue
					}
					position++
					inQuotes = false
					afterQuote = true
					continue
				}
				position++
				continue
			}

			if afterQuote {
				switch {
				case b == dialect.Delimiter:
					columns++
					position++
					atFieldStart = true
					afterQuote = false
					continue
				case hasTerminator(data, position, dialect.LineEnding):
					position += terminatorLength
					complete = true
					recordFinished = true
				case dialect.LineEnding == CRLF && b == '\r' &&
					position+1 == len(data) && truncated:
					// The final record arrived with only half of a CRLF.
					position++
					recordFinished = true
				default:
					return records, &ParseError{
						Offset:  position,
						Record:  len(records),
						Message: "expected delimiter or line ending after closing quote",
					}
				}
				break
			}

			if atFieldStart && dialect.Quote && b == '"' {
				inQuotes = true
				atFieldStart = false
				position++
				continue
			}
			if b == dialect.Delimiter {
				columns++
				position++
				atFieldStart = true
				continue
			}
			if b == '"' {
				return records, &ParseError{
					Offset:  position,
					Record:  len(records),
					Message: "quote outside a quoted field",
				}
			}
			if hasTerminator(data, position, dialect.LineEnding) {
				position += terminatorLength
				complete = true
				recordFinished = true
				break
			}

			atFieldStart = false
			position++
		}

		if !recordFinished {
			if inQuotes && !truncated {
				return records, &ParseError{
					Offset:  len(data),
					Record:  len(records),
					Message: "unterminated quoted field",
				}
			}
			// A record ending at EOF is complete only when the sample is not
			// marked truncated. An unfinished quote is tolerated for a
			// truncated final record but never contributes to column scoring.
			complete = !truncated && !inQuotes
		}

		records = append(records, parsedRecord{
			span: RecordRange{
				Start: start,
				End:   position,
			},
			columns:  columns,
			complete: complete,
		})
	}

	return records, nil
}

func hasTerminator(data []byte, position int, lineEnding LineEnding) bool {
	if position >= len(data) {
		return false
	}
	if lineEnding == LF {
		return data[position] == '\n'
	}
	return data[position] == '\r' &&
		position+1 < len(data) &&
		data[position+1] == '\n'
}

// DescribeErrors returns one line per candidate when no dialect was selected.
// It is empty for a successful detection.
func (r Result) DescribeErrors() string {
	if r.Valid {
		return ""
	}
	var lines []string
	for _, candidate := range r.Candidates {
		if candidate.Error == nil {
			continue
		}
		lines = append(lines, fmt.Sprintf("candidate %d (%s): %s",
			candidate.Index, candidate.Dialect, candidate.Error))
	}
	if len(lines) == 0 {
		return "no candidates"
	}
	return strings.Join(lines, "\n")
}
