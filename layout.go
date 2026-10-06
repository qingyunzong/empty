package dateparse

import "strings"

type tokKind int

const (
	kLiteral       tokKind = iota
	kYear4                 // 2006
	kYear2                 // 06
	kMonthNum              // 01
	kMonthNumNoPad         // 1
	kMonthShort            // Jan
	kMonthLong             // January
	kDay                   // 02
	kDayNoPad              // 2
	kDaySpace              // _2
	kHour24                // 15
	kHour12                // 03
	kHour12NoPad           // 3
	kMin                   // 04
	kMinNoPad              // 4
	kSec                   // 05
	kSecNoPad              // 5
	kPM                    // PM
	kPMLower               // pm
	kZoneColon             // -07:00
	kZoneCompact           // -0700
	kZoneHour              // -07
	kZoneZColon            // Z07:00
	kZoneZCompact          // Z0700
	kZoneZHour             // Z07
)

type token struct {
	kind tokKind
	lit  string
}

// refTokens maps reference-time substrings to token kinds. The order matters:
// longer reference strings must precede their prefixes (e.g. "15" before "1").
var refTokens = []struct {
	text string
	kind tokKind
}{
	{"January", kMonthLong},
	{"-07:00", kZoneColon},
	{"Z07:00", kZoneZColon},
	{"-0700", kZoneCompact},
	{"Z0700", kZoneZCompact},
	{"2006", kYear4},
	{"Jan", kMonthShort},
	{"-07", kZoneHour},
	{"Z07", kZoneZHour},
	{"01", kMonthNum},
	{"02", kDay},
	{"_2", kDaySpace},
	{"03", kHour12},
	{"04", kMin},
	{"05", kSec},
	{"06", kYear2},
	{"15", kHour24},
	{"PM", kPM},
	{"pm", kPMLower},
	{"1", kMonthNumNoPad},
	{"2", kDayNoPad},
	{"3", kHour12NoPad},
	{"4", kMinNoPad},
	{"5", kSecNoPad},
}

// tokenize splits a reference-time layout into tokens. Any byte that is not
// part of a recognized reference token becomes literal text that must match
// the input exactly.
func tokenize(layout string) []token {
	var toks []token
	var lit strings.Builder
	flush := func() {
		if lit.Len() > 0 {
			toks = append(toks, token{kind: kLiteral, lit: lit.String()})
			lit.Reset()
		}
	}
	for i := 0; i < len(layout); {
		matched := false
		for _, rt := range refTokens {
			if strings.HasPrefix(layout[i:], rt.text) {
				flush()
				toks = append(toks, token{kind: rt.kind})
				i += len(rt.text)
				matched = true
				break
			}
		}
		if !matched {
			lit.WriteByte(layout[i])
			i++
		}
	}
	flush()
	return toks
}

// validate enforces the library's explicit-calendar contract: a format must
// pin down the year, month and day so the parser never has to guess them.
func validate(layout string, toks []token) error {
	if len(toks) == 0 {
		return &FormatError{Format: layout, Reason: "format is empty"}
	}
	var hasYear, hasMonth, hasDay bool
	for _, t := range toks {
		switch t.kind {
		case kYear4, kYear2:
			hasYear = true
		case kMonthNum, kMonthNumNoPad, kMonthShort, kMonthLong:
			hasMonth = true
		case kDay, kDayNoPad, kDaySpace:
			hasDay = true
		}
	}
	if !hasYear || !hasMonth || !hasDay {
		return &FormatError{Format: layout, Reason: "format must contain a year, month and day token; missing fields are never guessed"}
	}
	return nil
}

func isNumericKind(k tokKind) bool {
	switch k {
	case kYear4, kYear2, kMonthNum, kMonthNumNoPad, kDay, kDayNoPad, kDaySpace,
		kHour24, kHour12, kHour12NoPad, kMin, kMinNoPad, kSec, kSecNoPad:
		return true
	}
	return false
}
