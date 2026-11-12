package streamdl_test

import (
	"context"
	"crypto/sha256"
	"net/http"

	"example.org/dataeng/q0006/streamdl"
)

// newHTTPRequester shows how a caller wraps its own *http.Client, URL and
// authentication while delegating Range/If-Range handling to the downloader.
func newHTTPRequester(client *http.Client, url string) streamdl.Requester {
	return func(ctx context.Context, method string, headers http.Header) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, method, url, nil)
		if err != nil {
			return nil, err
		}
		for key, values := range headers {
			for _, value := range values {
				req.Header.Add(key, value)
			}
		}
		return client.Do(req)
	}
}

func ExampleDownloader() {
	var (
		client   = http.DefaultClient
		url      = "https://example.invalid/entity.bin"
		stageDir = "/var/lib/collector/staging"
		dst      = "/var/lib/collector/out/entity.bin"
		want     [sha256.Size]byte // caller-supplied expected digest
	)

	dl := &streamdl.Downloader{
		Request: newHTTPRequester(client, url),
		Staging: &streamdl.FileStaging{Dir: stageDir},
	}

	// Interrupted calls leave a durable prefix; calling again resumes from the
	// last savepoint and only publishes after length and SHA-256 both match.
	_ = dl.Download(context.Background(), dst, want)
}
