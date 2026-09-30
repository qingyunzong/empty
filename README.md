# jsonmerge3

Three-way recursive JSON merge (Python 3.11, standard library only).

## Usage

```
python -m jsonmerge3 base.json ours.json theirs.json -o result.json
```

* stdout: the merged JSON (also written to the `-o` file when given).
* stderr: a JSON array of conflicting JSON Pointers (RFC 6901).
* Exit codes: `0` clean merge, `1` conflicts, `2` invalid JSON/IO/usage.
  On any failure, nothing is written to stdout or the output file.

## Merge semantics

* Recursion proceeds by object keys and array indices; a value missing
  from one of the three trees counts as `null` for comparison.
* Only one side changed relative to base: that side wins. Both sides
  made the same change: adopted. Both sides changed the same value
  differently: the JSON Pointer is recorded in the conflict report and
  the `ours` value is used in the merged output.
* Objects: a key added with the same value on both sides is adopted,
  with different values it conflicts; a key deleted on one side and
  modified on the other conflicts. Keys whose merged value is missing
  are omitted.
* Arrays: merged positionally; an out-of-range append on only one side
  is adopted; different values at the same new index conflict. Array
  slots whose merged value is missing are emitted as `null`.

## Library

```python
from jsonmerge3 import merge3
merged, conflicts = merge3(base, ours, theirs)
```

## Tests

```
python3.11 -m unittest discover -s tests -v
```
