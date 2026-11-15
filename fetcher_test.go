package dataeng

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestHTTPFetcherGzipAndHTTPError(t *testing.T) {
	doc := `<urlset><url><loc>https://example.com/a</loc></url></urlset>`
	gz := gzipString(t, doc)
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		header := make(http.Header)
		status := http.StatusOK
		statusText := "200 OK"
		body := []byte(nil)
		switch req.URL.Path {
		case "/sitemap.xml.gz":
			header.Set("Content-Type", "application/gzip")
			body = gz
		default:
			status = http.StatusNotFound
			statusText = "404 Not Found"
		}
		return &http.Response{
			StatusCode: status,
			Status:     statusText,
			Header:     header,
			Body:       io.NopCloser(bytes.NewReader(body)),
			Request:    req,
		}, nil
	})}

	fetcher := NewHTTPFetcher(client)
	body, err := fetcher.Fetch(context.Background(), "https://example.com/sitemap.xml.gz")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseSitemapBytes(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.URLs) != 1 {
		t.Fatalf("urls = %#v", parsed.URLs)
	}
	_, err = fetcher.Fetch(context.Background(), "https://example.com/missing.xml")
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusNotFound {
		t.Fatalf("err = %v", err)
	}
}

func TestMapFetcherAndBodyLimit(t *testing.T) {
	url := "https://example.com/sitemap.xml"
	fetcher := MapFetcher{
		url: []byte("body"),
	}
	body, err := fetcher.Fetch(context.Background(), "HTTPS://EXAMPLE.COM:443/sitemap.xml")
	if err != nil || string(body) != "body" {
		t.Fatalf("body=%q err=%v", body, err)
	}
	if _, err := fetcher.Fetch(context.Background(), "https://example.com/other.xml"); err == nil {
		t.Fatal("expected missing resource error")
	}
	if _, err := ParseSitemapWithLimit(strings.NewReader("12345678901"), 10); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("err = %v", err)
	}
}
