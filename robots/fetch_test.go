package robots

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type q216RoundTripper func(*http.Request) (*http.Response, error)

func (f q216RoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func q216Response(request *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode:    status,
		Status:        http.StatusText(status),
		Header:        make(http.Header),
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentLength: int64(len(body)),
		Request:       request,
	}
}

func q216HTTPFetcher(transport q216RoundTripper, maxBodyBytes int64) *HTTPFetcher {
	return NewHTTPFetcher(HTTPFetcherConfig{
		Client:       &http.Client{Transport: transport},
		MaxBodyBytes: maxBodyBytes,
	})
}

func TestQ216HTTPFetcherStatusClassification(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"ok", http.StatusOK, "User-agent: *\nDisallow: /x\n", nil},
		{"not found", http.StatusNotFound, "missing", ErrRobotsNotFound},
		{"gone", http.StatusGone, "missing", ErrRobotsNotFound},
		{"forbidden", http.StatusForbidden, "no", ErrRobotsAccessDenied},
		{"unauthorized", http.StatusUnauthorized, "no", ErrRobotsAccessDenied},
		{"server error", http.StatusInternalServerError, "boom", ErrRobotsUnavailable},
		{"rate limited", http.StatusTooManyRequests, "slow", ErrRobotsUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var userAgent string
			var requested string
			fetcher := q216HTTPFetcher(func(request *http.Request) (*http.Response, error) {
				userAgent = request.Header.Get("User-Agent")
				requested = request.URL.String()
				return q216Response(request, test.status, test.body), nil
			}, 0)

			body, err := fetcher.Fetch(context.Background(), q216Origin(t, "https://example.com"), "test-bot")
			if userAgent != "test-bot" {
				t.Fatalf("User-Agent = %q", userAgent)
			}
			if requested != "https://example.com:443/robots.txt" {
				t.Fatalf("requested URL = %q", requested)
			}
			if test.want == nil {
				if err != nil {
					t.Fatalf("Fetch: %v", err)
				}
				if string(body) != test.body {
					t.Fatalf("body = %q", body)
				}
				return
			}
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestQ216HTTPFetcherRejectsOversizedBody(t *testing.T) {
	fetcher := q216HTTPFetcher(func(request *http.Request) (*http.Response, error) {
		return q216Response(request, http.StatusOK, "1234567890"), nil
	}, 5)

	body, err := fetcher.Fetch(context.Background(), q216Origin(t, "https://example.com"), "bot")
	if !errors.Is(err, ErrRobotsTooLarge) {
		t.Fatalf("body=%q error=%v", body, err)
	}
}

func TestQ216HTTPFetcherRejectsCrossOriginRedirect(t *testing.T) {
	fetcher := q216HTTPFetcher(func(request *http.Request) (*http.Response, error) {
		if request.URL.Hostname() == "example.com" {
			response := q216Response(request, http.StatusFound, "")
			response.Header.Set("Location", "https://other.example/robots.txt")
			return response, nil
		}
		return q216Response(request, http.StatusOK, "User-agent: *\nDisallow:\n"), nil
	}, 0)

	_, err := fetcher.Fetch(context.Background(), q216Origin(t, "https://example.com"), "bot")
	if !errors.Is(err, ErrCrossOriginRedirect) || !errors.Is(err, ErrRobotsUnavailable) {
		t.Fatalf("redirect error = %v", err)
	}
}

func TestQ216HTTPFetcherHonoursContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	fetcher := q216HTTPFetcher(func(request *http.Request) (*http.Response, error) {
		if err := request.Context().Err(); err != nil {
			return nil, err
		}
		return q216Response(request, http.StatusOK, ""), nil
	}, 0)

	_, err := fetcher.Fetch(ctx, q216Origin(t, "https://example.com"), "bot")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
}
