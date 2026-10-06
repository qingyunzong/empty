# Test Results

Command: `go test ./...` (also verified with `-count=1 -race`)
Date: 2026-10-07, Go 1.27.1 linux/amd64

```
ok  	archive	1.017s
```

All 6 tests PASS:

- TestPublishAndExtract
- TestShortDigestCollision
- TestPublishRetryDoesNotDoubleCount
- TestRecoveryRepairsRefcounts
- TestRecoveryKeepsStagingBlocks
- TestExtractDetectsCorruption
