package dataeng

import (
	"bytes"
	"compress/gzip"
	"errors"
	"strings"
	"testing"
	"time"
)

func gzipString(t *testing.T, value string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(value)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestParseURLSet(t *testing.T) {
	doc := `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc> https://example.com/a </loc>
    <lastmod>2024-05-06T07:08:09+02:00</lastmod>
    <changefreq>Daily</changefreq>
    <priority>0.8</priority>
    <image:image><image:loc>https://example.com/image.png</image:loc></image:image>
  </url>
  <url><loc>/b</loc><lastmod>2024-05-06</lastmod><priority>bad</priority></url>
  <url><loc></loc></url>
</urlset>`
	got, err := ParseSitemap(strings.NewReader(doc))
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != KindURLSet {
		t.Fatalf("kind = %v", got.Kind)
	}
	if len(got.URLs) != 2 {
		t.Fatalf("urls = %d, want 2: %#v", len(got.URLs), got.URLs)
	}
	if got.URLs[0].Loc != "https://example.com/a" {
		t.Fatalf("loc = %q", got.URLs[0].Loc)
	}
	wantTime := time.Date(2024, 5, 6, 7, 8, 9, 0, time.FixedZone("", 2*3600))
	if !got.URLs[0].LastMod.Equal(wantTime) {
		t.Fatalf("lastmod = %v, want %v", got.URLs[0].LastMod, wantTime)
	}
	if got.URLs[0].ChangeFreq != "daily" || !got.URLs[0].HasPriority || got.URLs[0].Priority != 0.8 {
		t.Fatalf("entry = %#v", got.URLs[0])
	}
	if got.URLs[1].HasPriority {
		t.Fatalf("invalid priority should be ignored")
	}
}

func TestParseSitemapIndex(t *testing.T) {
	doc := `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/a.xml</loc><lastmod>2024-01-02</lastmod></sitemap>
  <sitemap><loc>/b.xml</loc></sitemap>
</sitemapindex>`
	got, err := ParseSitemap(strings.NewReader(doc))
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != KindIndex || len(got.Sitemaps) != 2 {
		t.Fatalf("got %#v", got)
	}
	if got.Sitemaps[1].Loc != "/b.xml" {
		t.Fatalf("loc = %q", got.Sitemaps[1].Loc)
	}
}

func TestParseGzipByMagic(t *testing.T) {
	doc := `<urlset><url><loc>https://example.com/a</loc></url></urlset>`
	got, err := ParseSitemap(bytes.NewReader(gzipString(t, doc)))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.URLs) != 1 {
		t.Fatalf("urls = %d", len(got.URLs))
	}
}

func TestParseLastModForms(t *testing.T) {
	cases := []string{
		"2024-01-02T03:04:05Z",
		"2024-01-02T03:04:05.123Z",
		"2024-01-02T03:04:05+0800",
		"2024-01-02 03:04:05",
		"2024-01-02",
		"2024-01",
		"2024",
	}
	for _, value := range cases {
		if _, err := ParseLastMod(value); err != nil {
			t.Errorf("ParseLastMod(%q): %v", value, err)
		}
	}
	if _, err := ParseLastMod("not-a-date"); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseRejectsUnsupportedRoot(t *testing.T) {
	_, err := ParseSitemap(strings.NewReader(`<html></html>`))
	if !errors.Is(err, ErrUnsupportedRoot) {
		t.Fatalf("err = %v", err)
	}
}
