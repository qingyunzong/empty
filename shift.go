package dataeng

import (
	"errors"
	"fmt"
)

// RefChange describes one A1 reference or A1:B2 range that was rewritten
// while restoring a shared formula for a slave cell.
//
// ByteStart and ByteEnd are the half-open byte offsets of the complete
// original reference inside the master formula text, including any sheet
// prefix. Prefix is that prefix (with its trailing '!'), preserved
// byte-for-byte, or empty for a same-sheet reference. Original is the exact
// original reference bytes and Replaced is the shifted reference body; for
// RefError the whole reference is replaced by "#REF!" without a prefix.
type RefChange struct {
	ByteStart int
	ByteEnd   int
	Prefix    string
	Original  string
	Replaced  string
	RefError  bool
}

const (
	maxRow = 1048576
	maxCol = 16384 // column XFD
)

// colToLetters converts a 1-based column index (1..16384) to its XFD name.
func colToLetters(col int) string {
	var letters []byte
	for col > 0 {
		col--
		letters = append(letters, byte('A'+col%26))
		col /= 26
	}
	for left, right := 0, len(letters)-1; left < right; left, right = left+1, right-1 {
		letters[left], letters[right] = letters[right], letters[left]
	}
	return string(letters)
}

// lettersToCol converts an uppercase column name to its 1-based index.
// It returns false for names beyond XFD.
func lettersToCol(letters string) (int, bool) {
	col := 0
	for i := 0; i < len(letters); i++ {
		ch := letters[i]
		if ch < 'A' || ch > 'Z' {
			return 0, false
		}
		col = col*26 + int(ch-'A'+1)
	}
	if col < 1 || col > maxCol {
		return 0, false
	}
	return col, true
}

type coordPart struct {
	abs     bool
	col     int
	colText string
	row     int
	rowText string
}

type parsedRef struct {
	prefix    string // sheet prefix including the trailing '!', verbatim
	hasPrefix bool
	start     int // offset of the first reference body byte
	end       int // offset just past the row digits
	col       coordPart
	row       coordPart
}

// isIdentStart reports whether ch may start an unquoted ASCII identifier
// (function name, boolean constant or unquoted sheet name).
func isIdentStart(ch byte) bool {
	return ch == '_' || ('a' <= ch && ch <= 'z') || ('A' <= ch && ch <= 'Z')
}

// isIdentCont reports whether ch may continue an identifier.
func isIdentCont(ch byte) bool {
	return isIdentStart(ch) || ('0' <= ch && ch <= '9') || ch == '.'
}

func isSpace(ch byte) bool {
	return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r'
}

func isErrorByte(ch byte) bool {
	switch ch {
	case '#', 'R', 'E', 'F', '!', '/', '0', '?', 'N', 'A', 'M',
		'V', 'L', 'U', 'D', 'I':
		return true
	}
	return false
}

func isBooleanToken(s string) bool {
	switch s {
	case "TRUE", "FALSE", "true", "false", "True", "False":
		return true
	}
	return false
}

// parseBareCoordAt parses an uppercase A1 cell coordinate with optional
// absolute markers at formula offset pos. It returns the column and row
// parts and the offset just past the row digits, or false. Row numbers have
// no leading zero and stay within 1..1048576, columns within A..XFD.
func parseBareCoordAt(formula string, pos int) (coordPart, coordPart, int, bool) {
	var col coordPart
	if pos < len(formula) && formula[pos] == '$' {
		col.abs = true
		pos++
	}
	lettersStart := pos
	for pos < len(formula) && formula[pos] >= 'A' && formula[pos] <= 'Z' {
		pos++
	}
	if pos == lettersStart || pos-lettersStart > 3 {
		return coordPart{}, coordPart{}, 0, false
	}
	colText := formula[lettersStart:pos]
	colNum, ok := lettersToCol(colText)
	if !ok {
		return coordPart{}, coordPart{}, 0, false
	}
	col.col = colNum
	col.colText = colText

	var row coordPart
	if pos < len(formula) && formula[pos] == '$' {
		row.abs = true
		pos++
	}
	rowStart := pos
	for pos < len(formula) && formula[pos] >= '0' && formula[pos] <= '9' {
		pos++
	}
	if pos == rowStart {
		return coordPart{}, coordPart{}, 0, false
	}
	rowText := formula[rowStart:pos]
	if len(rowText) > 7 || rowText[0] == '0' {
		return coordPart{}, coordPart{}, 0, false
	}
	rowNum := 0
	for i := rowStart; i < pos; i++ {
		rowNum = rowNum*10 + int(formula[i]-'0')
	}
	if rowNum < 1 || rowNum > maxRow {
		return coordPart{}, coordPart{}, 0, false
	}
	row.row = rowNum
	row.rowText = rowText
	return col, row, pos, true
}

// parseReferenceAt parses a same-sheet A1 reference or a reference with an
// optional sheet prefix at formula offset pos. The returned start and end
// cover only the A1 body; the prefix is reported separately and retained
// verbatim.
func parseReferenceAt(formula string, pos int) (parsedRef, bool) {
	prefix := ""
	bodyStart := pos
	if pos < len(formula) && formula[pos] == '\'' {
		quote := pos
		pos++
		contentStart := pos
		closed := false
		for pos < len(formula) {
			if formula[pos] == '\'' {
				if pos+1 < len(formula) && formula[pos+1] == '\'' {
					pos += 2
					continue
				}
				if pos == contentStart {
					return parsedRef{}, false
				}
				pos++
				closed = true
				break
			}
			pos++
		}
		if !closed {
			return parsedRef{}, false
		}
		for pos < len(formula) && isSpace(formula[pos]) {
			pos++
		}
		if pos >= len(formula) || formula[pos] != '!' {
			return parsedRef{}, false
		}
		pos++
		prefix = formula[quote:pos]
		bodyStart = pos
	} else if pos < len(formula) && isIdentStart(formula[pos]) {
		identStart := pos
		pos++
		for pos < len(formula) && isIdentCont(formula[pos]) {
			pos++
		}
		save := pos
		for pos < len(formula) && isSpace(formula[pos]) {
			pos++
		}
		if pos < len(formula) && formula[pos] == '!' {
			pos++
			prefix = formula[identStart:pos]
			bodyStart = pos
		} else {
			pos = save
		}
	}

	col, row, end, ok := parseBareCoordAt(formula, bodyStart)
	if !ok {
		return parsedRef{}, false
	}
	return parsedRef{
		prefix:    prefix,
		hasPrefix: prefix != "",
		start:     bodyStart,
		end:       end,
		col:       col,
		row:       row,
	}, true
}

// ShiftFormula rewrites every relative A1 reference and range in formula by
// applying rowDelta and colDelta. Absolute column/row parts keep their
// coordinates and '$' markers. A reference or whole range whose result
// leaves rows 1..1048576 or columns A..XFD is replaced by "#REF!" (the
// sheet prefix is dropped together with it). Strings, numbers, function
// names, boolean constants, operators and whitespace are preserved
// byte-for-byte. Unsupported named ranges, external workbook references,
// 3-D references and structured table references return an error.
func ShiftFormula(formula string, rowDelta, colDelta int) (string, []RefChange, error) {
	out := make([]byte, 0, len(formula))
	var changes []RefChange
	i := 0
	for i < len(formula) {
		ch := formula[i]

		// Double-quoted string literal: doubled inner quotes are escaped and
		// A1-looking text inside the string must never be rewritten.
		if ch == '"' {
			i++
			closed := false
			for i < len(formula) {
				if formula[i] == '"' {
					if i+1 < len(formula) && formula[i+1] == '"' {
						i += 2
						continue
					}
					i++
					closed = true
					break
				}
				i++
			}
			if !closed {
				return "", nil, errors.New("dataeng: unclosed string literal in formula")
			}
			out = append(out, formula[len(out):i]...)
			continue
		}

		// External workbook references always use '['.
		if ch == '[' {
			return "", nil, errors.New("dataeng: external workbook references are not supported")
		}

		// Excel error literals such as #REF!, #N/A, #VALUE!, #DIV/0!.
		if ch == '#' {
			start := i
			i++
			for i < len(formula) && isErrorByte(formula[i]) {
				i++
			}
			out = append(out, formula[start:i]...)
			continue
		}

		// Numeric literals, including decimals and E exponents, stay intact.
		if ('0' <= ch && ch <= '9') ||
			(ch == '.' && i+1 < len(formula) && formula[i+1] >= '0' && formula[i+1] <= '9') {
			start := i
			dot := false
			for i < len(formula) {
				c := formula[i]
				if '0' <= c && c <= '9' {
					i++
					continue
				}
				if c == '.' && !dot {
					dot = true
					i++
					continue
				}
				if (c == 'E' || c == 'e') && i > start {
					j := i + 1
					if j < len(formula) && (formula[j] == '+' || formula[j] == '-') {
						j++
					}
					digitStart := j
					for j < len(formula) && formula[j] >= '0' && formula[j] <= '9' {
						j++
					}
					if j > digitStart {
						i = j
						continue
					}
				}
				break
			}
			if i < len(formula) && formula[i] == '%' {
				i++
			}
			out = append(out, formula[start:i]...)
			continue
		}

		// Identifiers: sheet prefixes, function calls, boolean constants,
		// A1 references, or rejected named ranges / 3-D references.
		if isIdentStart(ch) {
			start := i
			i++
			for i < len(formula) && isIdentCont(formula[i]) {
				i++
			}
			save := i
			for i < len(formula) && isSpace(formula[i]) {
				i++
			}
			if i < len(formula) && formula[i] == '(' {
				out = append(out, formula[start:i+1]...)
				i++
				continue
			}
			if i < len(formula) && formula[i] == '!' {
				// Rewind: parseReferenceAt owns the whole prefixed reference.
				i = start
				ref, ok := parseReferenceAt(formula, i)
				if !ok || !ref.hasPrefix {
					return "", nil, fmt.Errorf("dataeng: invalid sheet reference at byte %d", start)
				}
				var next int
				var err error
				out, changes, next, err = emitReference(formula, ref, rowDelta, colDelta, out, changes)
				if err != nil {
					return "", nil, err
				}
				i = next
				continue
			}
			i = save
			token := formula[start:i]
			if isBooleanToken(token) {
				out = append(out, token...)
				continue
			}
			if ref, ok := parseReferenceAt(formula, start); ok && ref.start == start {
				var next int
				var err error
				out, changes, next, err = emitReference(formula, ref, rowDelta, colDelta, out, changes)
				if err != nil {
					return "", nil, err
				}
				i = next
				continue
			}
			if i < len(formula) && formula[i] == ':' {
				return "", nil, errors.New("dataeng: 3-D references are not supported")
			}
			return "", nil, fmt.Errorf("dataeng: named range %q is not supported", token)
		}

		// A1 references with an absolute column marker.
		if ch == '$' {
			ref, ok := parseReferenceAt(formula, i)
			if !ok {
				return "", nil, fmt.Errorf("dataeng: invalid reference at byte %d", i)
			}
			var next int
			var err error
			out, changes, next, err = emitReference(formula, ref, rowDelta, colDelta, out, changes)
			if err != nil {
				return "", nil, err
			}
			i = next
			continue
		}

		// A quoted sheet prefix only becomes valid through parseReferenceAt.
		if ch == '\'' {
			ref, ok := parseReferenceAt(formula, i)
			if !ok || !ref.hasPrefix {
				return "", nil, fmt.Errorf("dataeng: invalid quoted sheet reference at byte %d", i)
			}
			var next int
			var err error
			out, changes, next, err = emitReference(formula, ref, rowDelta, colDelta, out, changes)
			if err != nil {
				return "", nil, err
			}
			i = next
			continue
		}

		if ch == '!' {
			return "", nil, fmt.Errorf("dataeng: unexpected '!' at byte %d", i)
		}

		// Every other byte (operators, punctuation, whitespace) is copied
		// untouched.
		out = append(out, ch)
		i++
	}
	return string(out), changes, nil
}

// emitReference appends the shifted form of ref (including any same-prefix
// range) and records the original byte interval of the whole reference.
func emitReference(formula string, ref parsedRef, rowDelta, colDelta int,
	out []byte, changes []RefChange) ([]byte, []RefChange, int, error) {
	bodyStart := ref.start
	end := ref.end
	fullStart := bodyStart - len(ref.prefix)

	firstBody, firstOK := shiftCoord(ref.col, ref.row, rowDelta, colDelta)

	secondBody := ""
	secondOK := true
	if end < len(formula) && formula[end] == ':' {
		col2, row2, secondEnd, ok := parseBareCoordAt(formula, end+1)
		if !ok {
			return nil, nil, 0, fmt.Errorf("dataeng: invalid range end at byte %d", end+1)
		}
		end = secondEnd
		secondBody, secondOK = shiftCoord(col2, row2, rowDelta, colDelta)
	}

	change := RefChange{
		ByteStart: fullStart,
		ByteEnd:   end,
		Prefix:    ref.prefix,
		Original:  formula[fullStart:end],
	}

	if !firstOK || !secondOK {
		change.Replaced = refErrorLiteral
		change.RefError = true
		out = append(out, refErrorLiteral...)
		changes = append(changes, change)
		return out, changes, end, nil
	}

	replacedBody := firstBody
	if secondBody != "" {
		replacedBody += ":" + secondBody
	}
	change.Replaced = replacedBody
	out = append(out, ref.prefix...)
	out = append(out, replacedBody...)
	changes = append(changes, change)
	return out, changes, end, nil
}

const refErrorLiteral = "#REF!"

// shiftCoord applies the slave offset to one coordinate. Absolute parts are
// fixed. It returns the rendered coordinate (without any sheet prefix) and
// false when the shifted relative part leaves the sheet.
func shiftCoord(col, row coordPart, rowDelta, colDelta int) (string, bool) {
	newCol := col.col
	if !col.abs {
		newCol = col.col + colDelta
		if newCol < 1 || newCol > maxCol {
			return "", false
		}
	}
	newRow := row.row
	if !row.abs {
		newRow = row.row + rowDelta
		if newRow < 1 || newRow > maxRow {
			return "", false
		}
	}

	result := ""
	if col.abs {
		result += "$" + col.colText
	} else {
		result += colToLetters(newCol)
	}
	if row.abs {
		result += "$" + row.rowText
	} else {
		result += fmt.Sprintf("%d", newRow)
	}
	return result, true
}
