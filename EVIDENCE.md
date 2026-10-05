# 检测证据记录

日期：2026-10-05，Go 版本：go version go1.27.1 linux/amd64

## go test ./... 实际结果

```
ok  	scenariomin	(cached)
```

## go test ./... -v 摘要

```
=== RUN   TestMinimizeSmallExample
--- PASS: TestMinimizeSmallExample (0.00s)
=== RUN   TestIllegalSubsequenceNotFailure
--- PASS: TestIllegalSubsequenceNotFailure (0.00s)
=== RUN   TestEnumerateCoversAllSubsequences
--- PASS: TestEnumerateCoversAllSubsequences (0.00s)
=== RUN   TestMinimizeCrossCheck
--- PASS: TestMinimizeCrossCheck (0.12s)
=== RUN   TestRunPrintsEvidence
--- PASS: TestRunPrintsEvidence (0.00s)
=== RUN   TestSimulateLegality
--- PASS: TestSimulateLegality (0.00s)
=== RUN   TestSimulateRecordsLastWriter
--- PASS: TestSimulateRecordsLastWriter (0.00s)
=== RUN   TestValidateDefaultsVictimToLastEvent
--- PASS: TestValidateDefaultsVictimToLastEvent (0.00s)
=== RUN   TestValidateRejectsBadScenarios
--- PASS: TestValidateRejectsBadScenarios (0.00s)
=== RUN   TestFailsSemantics
--- PASS: TestFailsSemantics (0.00s)
PASS
ok  	scenariomin	0.130s
```

## 小例全检测证据（scenariomin -dump examples/small.json）

```
scenario "small": 5 events, victim e5
full sequence [e1 e2 e3 e4 e5]: legal=true fails=true
search evidence (subsequences checked per size):
  size  total  legal  failing
     0      1      1        0
     1      5      3        0
     2     10      5        0
     3     10      6        1  <-- minimal failing size
minimal failing subsequence (size 3): [e2 e4 e5]
legality trace of the witness:
  e2: writes x
  e4: reads x <- e2 (ok); writes z
  e5: reads z <- e4 (ok); reads x <- e2 (ok)
failure evidence (victim reads vs declared bad writers):
  resource x: last writer e2 (declared bad [e2] => failure)
  resource z: last writer e4 (ok)
minimality: all 9 legal subsequences of size < 3 pass (0 failing); checked exhaustively
full enumeration evidence (32 subsequences):
  []                           legal=true  failing=false pass
  [e1]                         legal=true  failing=false pass
  [e2]                         legal=true  failing=false pass
  [e3]                         legal=true  failing=false pass
  [e4]                         legal=false failing=false illegal: event e4 reads "x" with no prior write in the subsequence
  [e5]                         legal=false failing=false illegal: event e5 reads "z" with no prior write in the subsequence
  [e1 e2]                      legal=true  failing=false pass
  [e1 e3]                      legal=true  failing=false pass
  [e1 e4]                      legal=true  failing=false pass
  [e1 e5]                      legal=false failing=false illegal: event e5 reads "z" with no prior write in the subsequence
  [e2 e3]                      legal=true  failing=false pass
  [e2 e4]                      legal=true  failing=false pass
  [e2 e5]                      legal=false failing=false illegal: event e5 reads "z" with no prior write in the subsequence
  [e3 e4]                      legal=false failing=false illegal: event e4 reads "x" with no prior write in the subsequence
  [e3 e5]                      legal=false failing=false illegal: event e5 reads "z" with no prior write in the subsequence
  [e4 e5]                      legal=false failing=false illegal: event e4 reads "x" with no prior write in the subsequence
  [e1 e2 e3]                   legal=true  failing=false pass
  [e1 e2 e4]                   legal=true  failing=false pass
  [e1 e2 e5]                   legal=false failing=false illegal: event e5 reads "z" with no prior write in the subsequence
  [e1 e3 e4]                   legal=true  failing=false pass
  [e1 e3 e5]                   legal=false failing=false illegal: event e5 reads "z" with no prior write in the subsequence
  [e1 e4 e5]                   legal=true  failing=false pass
  [e2 e3 e4]                   legal=true  failing=false pass
  [e2 e3 e5]                   legal=false failing=false illegal: event e5 reads "z" with no prior write in the subsequence
  [e2 e4 e5]                   legal=true  failing=true  FAIL: victim reads a declared bad writer
  [e3 e4 e5]                   legal=false failing=false illegal: event e4 reads "x" with no prior write in the subsequence
  [e1 e2 e3 e4]                legal=true  failing=false pass
  [e1 e2 e3 e5]                legal=false failing=false illegal: event e5 reads "z" with no prior write in the subsequence
  [e1 e2 e4 e5]                legal=true  failing=true  FAIL: victim reads a declared bad writer
  [e1 e3 e4 e5]                legal=true  failing=false pass
  [e2 e3 e4 e5]                legal=true  failing=true  FAIL: victim reads a declared bad writer
  [e1 e2 e3 e4 e5]             legal=true  failing=true  FAIL: victim reads a declared bad writer
```
