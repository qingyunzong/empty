package dataeng

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// Kind describes the root element of a sitemap document.
type Kind uint8

const (
	KindUnknown Kind = iota
	KindURLSet
	KindIndex
)

// Convenience aliases for callers that prefer the protocol names.
const (
	SitemapURLSet = KindURLSet
	SitemapIndex  = KindIndex
)

func (k Kind) String() string {
	switch k {
	case KindURLSet:
		return "urlset"
	case KindIndex:
		return "sitemapindex"
	default:
		return "unknown"
	}
}

// URLEntry is one <url> record in a <urlset>.
type URLEntry struct {
	Loc         string
	LastMod     time.Time
	LastModRaw  string
	ChangeFreq  string
	Priority    float64
	PriorityRaw string
	HasPriority bool
}

// SitemapRef is one <sitemap> record in a <sitemapindex>.
type SitemapRef struct {
	Loc        string
	LastMod    time.Time
	LastModRaw string
}

// Sitemap is a parsed sitemap document. Kind determines which slice is
// populated.
type Sitemap struct {
	Kind     Kind
	URLs     []URLEntry
	Sitemaps []SitemapRef
}

// IsIndex reports whether the document is a sitemap index.
func (s *Sitemap) IsIndex() bool { return s != nil && s.Kind == KindIndex }

// IsURLSet reports whether the document contains page locations.
func (s *Sitemap) IsURLSet() bool { return s != nil && s.Kind == KindURLSet }

// PageEntries returns page entries for a urlset and nil for an index.
func (s *Sitemap) PageEntries() []URLEntry {
	if s == nil || s.Kind != KindURLSet {
		return nil
	}
	return s.URLs
}

type urlSetXML struct {
	XMLName xml.Name `xml:"urlset"`
	URLs    []urlXML `xml:"url"`
}

type urlXML struct {
	Loc        string `xml:"loc"`
	LastMod    string `xml:"lastmod"`
	ChangeFreq string `xml:"changefreq"`
	Priority   string `xml:"priority"`
}

type sitemapIndexXML struct {
	XMLName  xml.Name     `xml:"sitemapindex"`
	Sitemaps []sitemapXML `xml:"sitemap"`
}

type sitemapXML struct {
	Loc     string `xml:"loc"`
	LastMod string `xml:"lastmod"`
}

// Parse reads one sitemap document. Gzip bodies are detected from their magic
// bytes, independent of the URL suffix or Content-Type.
func Parse(r io.Reader) (*Sitemap, error) {
	return ParseSitemap(r)
}

// ParseSitemap reads and inflates one sitemap document.
func ParseSitemap(r io.Reader) (*Sitemap, error) {
	return ParseSitemapWithLimit(r, DefaultMaxBodyBytes)
}

// ParseSitemapBytes parses a sitemap document already held in memory.
func ParseSitemapBytes(data []byte) (*Sitemap, error) {
	return ParseSitemapWithLimit(bytes.NewReader(data), DefaultMaxBodyBytes)
}

// ParseSitemapData is an alias for ParseSitemapBytes.
func ParseSitemapData(data []byte) (*Sitemap, error) { return ParseSitemapBytes(data) }

// ParseBytes is an alias for ParseSitemapBytes.
func ParseBytes(data []byte) (*Sitemap, error) { return ParseSitemapBytes(data) }

// ParseXML is an alias for ParseSitemap.
func ParseXML(r io.Reader) (*Sitemap, error) { return ParseSitemap(r) }

// ParseSitemapWithLimit is ParseSitemap with an explicit decompressed size
// limit. A non-positive limit uses DefaultMaxBodyBytes.
func ParseSitemapWithLimit(r io.Reader, maxBytes int64) (*Sitemap, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBodyBytes
	}
	data, err := ReadAllLimit(r, maxBytes)
	if err != nil {
		return nil, err
	}
	data, err = DecodeBody(data, maxBytes)
	if err != nil {
		return nil, err
	}
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return nil, ErrEmptyDocument
	}

	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = true
	var root xml.StartElement
	for {
		tok, err := dec.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, ErrEmptyDocument
			}
			return nil, fmt.Errorf("sitemap: xml: %w", err)
		}
		start, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		root = start
		break
	}

	switch strings.ToLower(root.Name.Local) {
	case "urlset":
		var doc urlSetXML
		if err := dec.DecodeElement(&doc, &root); err != nil {
			return nil, fmt.Errorf("sitemap: xml urlset: %w", err)
		}
		out := &Sitemap{Kind: KindURLSet, URLs: make([]URLEntry, 0, len(doc.URLs))}
		for _, raw := range doc.URLs {
			loc := strings.TrimSpace(raw.Loc)
			if loc == "" {
				continue
			}
			entry := URLEntry{
				Loc:         loc,
				LastModRaw:  strings.TrimSpace(raw.LastMod),
				ChangeFreq:  strings.ToLower(strings.TrimSpace(raw.ChangeFreq)),
				PriorityRaw: strings.TrimSpace(raw.Priority),
			}
			if entry.LastModRaw != "" {
				if ts, err := ParseLastMod(entry.LastModRaw); err == nil {
					entry.LastMod = ts
				}
			}
			if entry.PriorityRaw != "" {
				if p, err := strconv.ParseFloat(entry.PriorityRaw, 64); err == nil {
					entry.Priority = p
					entry.HasPriority = true
				}
			}
			out.URLs = append(out.URLs, entry)
		}
		return out, nil

	case "sitemapindex":
		var doc sitemapIndexXML
		if err := dec.DecodeElement(&doc, &root); err != nil {
			return nil, fmt.Errorf("sitemap: xml sitemapindex: %w", err)
		}
		out := &Sitemap{Kind: KindIndex, Sitemaps: make([]SitemapRef, 0, len(doc.Sitemaps))}
		for _, raw := range doc.Sitemaps {
			loc := strings.TrimSpace(raw.Loc)
			if loc == "" {
				continue
			}
			ref := SitemapRef{Loc: loc, LastModRaw: strings.TrimSpace(raw.LastMod)}
			if ref.LastModRaw != "" {
				if ts, err := ParseLastMod(ref.LastModRaw); err == nil {
					ref.LastMod = ts
				}
			}
			out.Sitemaps = append(out.Sitemaps, ref)
		}
		return out, nil

	default:
		return nil, fmt.Errorf("%w: <%s>", ErrUnsupportedRoot, root.Name.Local)
	}
}

// ParseLastMod parses the W3C datetime forms commonly found in sitemaps.
// Sitemap producers are inconsistent, so date-only, minute, and year-month
// values are accepted as well.
func ParseLastMod(raw string) (time.Time, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return time.Time{}, errors.New("sitemap: empty lastmod")
	}
	if strings.HasSuffix(value, "z") {
		value = value[:len(value)-1] + "Z"
	}
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05Z0700",
		"2006-01-02T15:04:05.999999999Z0700",
		"2006-01-02T15:04:05",
		"2006-01-02T15:04",
		"2006-01-02 15:04:05",
		"2006-01-02 15:04",
		"2006-01-02",
		"2006-01",
		"2006",
	}
	for _, layout := range layouts {
		if ts, err := time.Parse(layout, value); err == nil {
			return ts, nil
		}
	}
	return time.Time{}, fmt.Errorf("sitemap: invalid lastmod %q", raw)
}
