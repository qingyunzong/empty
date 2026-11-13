package dataeng

import "bytes"

// parseRecord turns the raw bytes of one record into fields. The scanner has
// already guaranteed that the raw bytes end at a reliable record boundary;
// this pass is responsible for exact field intervals and for recording any
// quoting error in this record.
func parseRecord(rec *Record, cfg Config, forceErr error) *Record {
	buf := rec.Raw
	start := rec.Start
	startLine := rec.Line
	fields := make([]Field, 0, 1)

	var parseErr error
	var sizeErr error

	i := 0
	for {
		fieldIndex := len(fields)
		rawStart := i
		contentStart := i
		if cfg.TrimLeadingSpace {
			for contentStart < len(buf) && (buf[contentStart] == ' ' || buf[contentStart] == '\t') {
				contentStart++
			}
		}

		if contentStart < len(buf) && hasPrefix(buf[contentStart:], cfg.Quote) {
			field, next, done, err, errAt := parseQuotedField(buf, start, startLine, rawStart, contentStart, fieldIndex, cfg)
			if err != nil {
				if parseErr == nil {
					parseErr = makeParseError(cfg, buf, start, startLine, errAt, fieldIndex, err)
				}
				// Like encoding/csv, do not expose the malformed field itself.
				break
			}
			fields = append(fields, field)
			if cfg.MaxFieldSize > 0 && len(field.Raw) > cfg.MaxFieldSize {
				sizeErr = makeParseError(cfg, buf, start, startLine, rawStart, fieldIndex, ErrFieldTooLarge)
			}
			if done {
				break
			}
			i = next
			continue
		}

		rawEnd, delimAt, quoteAt := scanUnquoted(buf, contentStart, cfg)
		if quoteAt >= 0 && !cfg.LazyQuotes && (delimAt < 0 || quoteAt < delimAt) {
			if parseErr == nil {
				parseErr = makeParseError(cfg, buf, start, startLine, quoteAt, fieldIndex, ErrBareQuote)
			}
			break
		}
		if cfg.LazyQuotes && quoteAt >= 0 && (delimAt < 0 || quoteAt < delimAt) {
			// The quote is ordinary content in lazy mode.
			rawEnd = len(buf)
			if delimAt >= 0 {
				rawEnd = delimAt
			}
		}
		if delimAt >= 0 {
			rawEnd = delimAt
		}

		field := Field{
			Start:        start + int64(rawStart),
			End:          start + int64(rawEnd),
			ContentStart: start + int64(contentStart),
			ContentEnd:   start + int64(rawEnd),
			Quoted:       false,
			Index:        fieldIndex,
		}
		field.Raw = append([]byte(nil), buf[rawStart:rawEnd]...)
		field.Value = append([]byte(nil), buf[contentStart:rawEnd]...)
		fields = append(fields, field)
		if cfg.MaxFieldSize > 0 && len(field.Raw) > cfg.MaxFieldSize && sizeErr == nil {
			sizeErr = makeParseError(cfg, buf, start, startLine, rawStart, fieldIndex, ErrFieldTooLarge)
		}

		if delimAt < 0 {
			break
		}
		i = delimAt + len(cfg.Delimiter)
		if i == len(buf) {
			// A trailing delimiter denotes one final empty field.
			fields = append(fields, Field{
				Start:        start + int64(i),
				End:          start + int64(i),
				ContentStart: start + int64(i),
				ContentEnd:   start + int64(i),
				Index:        len(fields),
			})
			break
		}
	}

	rec.Fields = fields
	switch {
	case parseErr != nil:
		rec.Err = parseErr
	case forceErr != nil:
		rec.Err = forceErr
	case sizeErr != nil:
		rec.Err = sizeErr
	case cfg.FieldsPerRecord > 0 && len(fields) != cfg.FieldsPerRecord:
		rec.Err = makeParseError(cfg, buf, start, startLine, 0, 0, ErrFieldCount)
	}
	return rec
}

func parseQuotedField(buf []byte, start int64, startLine, rawStart, open int, fieldIndex int, cfg Config) (Field, int, bool, error, int) {
	q := cfg.Quote
	contentStart := open + len(q)
	i := contentStart
	var value []byte

	for {
		rel := bytes.Index(buf[i:], q)
		if rel < 0 {
			if cfg.LazyQuotes {
				value = append(value, buf[i:]...)
				field := Field{
					Start:        start + int64(rawStart),
					End:          start + int64(len(buf)),
					ContentStart: start + int64(contentStart),
					ContentEnd:   start + int64(len(buf)),
					Quoted:       true,
					Index:        fieldIndex,
				}
				field.Raw = append([]byte(nil), buf[rawStart:]...)
				field.Value = normalizeValueCRLF(value)
				return field, len(buf), true, nil, 0
			}
			return Field{}, 0, true, ErrQuote, len(buf)
		}

		closeAt := i + rel
		value = append(value, buf[i:closeAt]...)
		after := closeAt + len(q)

		if hasPrefix(buf[after:], q) {
			// Doubled quote: one literal quote in the value.
			value = append(value, q...)
			i = after + len(q)
			continue
		}

		field := Field{
			Start:        start + int64(rawStart),
			End:          start + int64(after),
			ContentStart: start + int64(contentStart),
			ContentEnd:   start + int64(closeAt),
			Quoted:       true,
			Index:        fieldIndex,
		}
		field.Raw = append([]byte(nil), buf[rawStart:after]...)
		field.Value = normalizeValueCRLF(value)

		if after == len(buf) {
			return field, after, true, nil, 0
		}
		if hasPrefix(buf[after:], cfg.Delimiter) {
			return field, after + len(cfg.Delimiter), false, nil, 0
		}
		if buf[after] == '\n' {
			// A scanner boundary should normally have removed this newline.
			// Treat it as the end of the field for robustness.
			return field, after, true, nil, 0
		}
		if cfg.LazyQuotes {
			// A stray quote is literal, and the field continues.
			value = append(value, q...)
			i = after
			continue
		}
		return Field{}, 0, true, ErrQuote, after
	}
}

// normalizeValueCRLF mirrors encoding/csv: CRLF inside a quoted field is
// represented as LF in the decoded value, while Field.Raw keeps the original
// bytes and the byte intervals remain exact.
func normalizeValueCRLF(b []byte) []byte {
	out := append([]byte(nil), b...)
	w := 0
	for i := 0; i < len(out); i++ {
		if out[i] == '\r' && i+1 < len(out) && out[i+1] == '\n' {
			continue
		}
		out[w] = out[i]
		w++
	}
	return out[:w]
}

func scanUnquoted(buf []byte, from int, cfg Config) (rawEnd, delimAt, quoteAt int) {
	delimAt = -1
	quoteAt = -1
	if from >= len(buf) {
		return len(buf), -1, -1
	}

	if d := bytes.Index(buf[from:], cfg.Delimiter); d >= 0 {
		delimAt = from + d
	}
	if q := bytes.Index(buf[from:], cfg.Quote); q >= 0 {
		quoteAt = from + q
	}

	rawEnd = len(buf)
	if delimAt >= 0 {
		rawEnd = delimAt
	}
	if quoteAt >= 0 && (delimAt < 0 || quoteAt < delimAt) {
		rawEnd = quoteAt
	}
	return rawEnd, delimAt, quoteAt
}
