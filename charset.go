package dataeng

import (
	"strings"
)

// SniffLimit is the number of leading body bytes examined for a BOM or an
// HTML meta charset declaration.
const SniffLimit = 1024

// Charset names returned by Resolve. They are normalized to lower case.
const (
	UTF8        = "utf-8"
	UTF16LE     = "utf-16le"
	UTF16BE     = "utf-16be"
	Windows1252 = "windows-1252"
	ISO88591    = "iso-8859-1"
	USASCII     = "us-ascii"
)

// Source identifies the evidence that selected a charset.
type Source string

const (
	SourceBOM       Source = "bom"
	SourceTransport Source = "transport"
	SourceMeta      Source = "meta"
	SourceDefault   Source = "default"
	SourceUndecided Source = "undecided"
)

// Decision is the result of examining the leading bytes of a response.
//
// BOMLen is the number of leading bytes occupied by a recognized BOM. A
// caller decoding the complete body should discard those bytes. Undecided is
// true when an incomplete sample ends in the middle of a BOM or a meta
// declaration; in that case Charset is empty and the caller should obtain
// more bytes before deciding.
type Decision struct {
	Charset   string
	Source    Source
	BOMLen    int
	HasBOM    bool
	Decided   bool
	Undecided bool
	Reason    string
}

// Resolve decides which charset should be used for a response body.
//
// transportCharset is the charset supplied by the transport layer (for
// example an HTTP Content-Type header), or an empty string when absent.
// sample is the first SniffLimit bytes (or fewer when the complete body is
// shorter). complete reports whether sample is the entire body rather than a
// truncated prefix.
//
// A recognized BOM always wins. Otherwise a non-empty transport charset wins
// over an HTML meta declaration. If neither is present, the earliest valid
// meta charset outside script and style elements is used, and UTF-8 is the
// final fallback.
func Resolve(transportCharset string, sample []byte, complete bool) Decision {
	if bomCharset, bomLen, isBOM, truncated := sniffBOM(sample, complete); truncated {
		return undecided("truncated BOM")
	} else if isBOM {
		return Decision{
			Charset: bomCharset,
			Source:  SourceBOM,
			BOMLen:  bomLen,
			HasBOM:  true,
			Decided: true,
		}
	}

	if label := transportLabel(transportCharset); label != "" {
		return Decision{
			Charset: canonicalCharset(label),
			Source:  SourceTransport,
			Decided: true,
		}
	}

	if label, truncated := scanMetaCharset(sample, complete); truncated {
		return undecided("truncated meta charset declaration")
	} else if label != "" {
		return Decision{
			Charset: canonicalCharset(label),
			Source:  SourceMeta,
			Decided: true,
		}
	}

	return Decision{
		Charset: UTF8,
		Source:  SourceDefault,
		Decided: true,
	}
}

// Decide is an alias for Resolve.
func Decide(transportCharset string, sample []byte, complete bool) Decision {
	return Resolve(transportCharset, sample, complete)
}

// DetectCharset is an alias for Resolve.
func DetectCharset(transportCharset string, sample []byte, complete bool) Decision {
	return Resolve(transportCharset, sample, complete)
}

func undecided(reason string) Decision {
	return Decision{
		Source:    SourceUndecided,
		Undecided: true,
		Reason:    reason,
	}
}

// sniffBOM recognizes exactly the UTF-8, UTF-16LE, and UTF-16BE BOMs. It
// reports truncated only when an incomplete sample consists of a proper
// prefix of one of those BOMs. A complete UTF-32 BOM is deliberately not
// treated as the UTF-16 BOM that shares its first two bytes.
func sniffBOM(sample []byte, complete bool) (charset string, length int, ok, truncated bool) {
	if len(sample) >= 4 {
		if sample[0] == 0xFF && sample[1] == 0xFE && sample[2] == 0x00 && sample[3] == 0x00 {
			return "", 0, false, false
		}
		if sample[0] == 0x00 && sample[1] == 0x00 && sample[2] == 0xFE && sample[3] == 0xFF {
			return "", 0, false, false
		}
	}

	switch {
	case len(sample) >= 3 && sample[0] == 0xEF && sample[1] == 0xBB && sample[2] == 0xBF:
		return UTF8, 3, true, false
	case len(sample) >= 2 && sample[0] == 0xFF && sample[1] == 0xFE:
		return UTF16LE, 2, true, false
	case len(sample) >= 2 && sample[0] == 0xFE && sample[1] == 0xFF:
		return UTF16BE, 2, true, false
	}

	if !complete {
		switch {
		case len(sample) == 1 && (sample[0] == 0xEF || sample[0] == 0xFF || sample[0] == 0xFE):
			return "", 0, false, true
		case len(sample) == 2 && sample[0] == 0xEF && sample[1] == 0xBB:
			return "", 0, false, true
		}
	}
	return "", 0, false, false
}

func transportLabel(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	lower := strings.ToLower(value)
	if index := strings.Index(lower, "charset="); index >= 0 {
		value = value[index+len("charset="):]
		if index := strings.IndexByte(value, ';'); index >= 0 {
			value = value[:index]
		}
	}
	value = strings.TrimSpace(value)
	value = strings.Trim(value, `"'`)
	value = strings.TrimSpace(value)
	if index := strings.IndexAny(value, " \t\r\n;"); index >= 0 {
		value = value[:index]
	}
	return value
}

func canonicalCharset(label string) string {
	label = strings.ToLower(strings.TrimSpace(label))
	label = strings.Trim(label, `"'`)
	if index := strings.IndexAny(label, " \t\r\n;"); index >= 0 {
		label = label[:index]
	}

	switch label {
	case "utf-8", "utf8", "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "x-unicode20utf8":
		return UTF8
	case "utf-16", "utf16", "utf-16le", "utf16le", "ucs-2", "ucs2",
		"csunicode", "iso-10646-ucs-2", "unicode":
		return UTF16LE
	case "utf-16be", "utf16be", "unicodefffe":
		return UTF16BE
	case "windows-1252", "cp1252", "x-cp1252", "win1252":
		return Windows1252
	case "iso-8859-1", "iso8859-1", "iso_8859-1", "latin1", "latin-1", "l1":
		return ISO88591
	case "us-ascii", "ascii", "iso646-us", "ansi_x3.4-1968":
		return USASCII
	default:
		return label
	}
}
