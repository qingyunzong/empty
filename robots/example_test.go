package robots_test

import (
	"context"
	"fmt"
	"time"

	"example.org/dataeng/q0216/robots"
)

func Example_q216Manager() {
	manager, err := robots.NewManager(robots.Config{
		FailureMode: robots.FailClosed,
		Fetcher: robots.FetchFunc(func(context.Context, robots.Origin, string) ([]byte, error) {
			return []byte("User-agent: *\nDisallow: /private\nCrawl-delay: 2\n"), nil
		}),
		Auditor: robots.NewAuditLog(16),
	})
	if err != nil {
		panic(err)
	}
	defer manager.Close()

	lease, err := manager.Claim(context.Background(), robots.Task{
		Tenant: "tenant-a",
		URL:    "https://example.com/private/report",
	})
	if err != nil {
		panic(err)
	}
	defer lease.Release()

	permit, err := lease.Begin(context.Background(), "/private/report")
	fmt.Println(permit == nil, err != nil, lease.CrawlDelay() == 2*time.Second)

	permit, err = lease.Begin(context.Background(), "/public/report")
	fmt.Println(err, permit.Version() == lease.Version())

	// Output:
	// true true true
	// <nil> true
}
