package dataeng_test

import (
	"context"
	"testing"

	dataeng "example.org/dataeng/q0216"
)

func TestQ216RootPackageImportSurface(t *testing.T) {
	manager, err := dataeng.NewManager(dataeng.Config{
		FailureMode: dataeng.FailOpen,
		Fetcher: dataeng.FetchFunc(func(context.Context, dataeng.Origin, string) ([]byte, error) {
			return []byte("User-agent: *\nDisallow: /private\n"), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	lease, err := manager.Lease(context.Background(), dataeng.Task{
		Tenant: "tenant",
		URL:    "https://example.com/private/page",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if lease.Allowed("/private/page") {
		t.Fatal("/private/page should be denied")
	}
	if lease.Version() == 0 || lease.Generation() == 0 {
		t.Fatalf("lease version=%d generation=%d", lease.Version(), lease.Generation())
	}
}
