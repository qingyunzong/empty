"""JSON-lines CLI for the SSI engine.

Reads one JSON command object per line from stdin and writes one JSON
response object per line to stdout.

Commands:
  {"cmd": "begin",  "tx": "A"}                  -> {"ok": true, "tx": "A", "snapshot": 1}
  {"cmd": "read",   "tx": "A", "key": "x"}      -> {"ok": true, "value": ...}
  {"cmd": "write",  "tx": "A", "key": "x", "value": 1} -> {"ok": true}
  {"cmd": "commit", "tx": "A"}                  -> {"ok": true, "committed": true}
                                                   or {"ok": false, "committed": false,
                                                       "error": "SERIALIZATION_FAILURE" | "WRITE_CONFLICT"}
  {"cmd": "abort",  "tx": "A"}                  -> {"ok": true}
  {"cmd": "dump"}                               -> {"ok": true, "store": {...}}

The "tx" field of "begin" is optional; an id is assigned when omitted.
"""

import json
import sys

from .core import Engine, SSIError


def handle(engine, req):
    cmd = req.get("cmd")
    if cmd == "begin":
        tx = engine.begin(req.get("tx"))
        return {"ok": True, "tx": tx.id, "snapshot": tx.begin_ts}
    if cmd == "read":
        return {"ok": True, "value": engine.read(req["tx"], req["key"])}
    if cmd == "write":
        engine.write(req["tx"], req["key"], req.get("value"))
        return {"ok": True}
    if cmd == "commit":
        err = engine.commit(req["tx"])
        if err is None:
            return {"ok": True, "committed": True}
        return {"ok": False, "committed": False, "error": err}
    if cmd == "abort":
        engine.abort(req["tx"])
        return {"ok": True}
    if cmd == "dump":
        return {"ok": True, "store": engine.snapshot()}
    return {"ok": False, "error": "unknown command %r" % (cmd,)}


def main(stream=None, out=None):
    engine = Engine()
    stream = stream if stream is not None else sys.stdin
    out = out if out is not None else sys.stdout
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise TypeError("command must be a JSON object")
            resp = handle(engine, req)
        except SSIError as exc:
            resp = {"ok": False, "error": str(exc)}
        except (ValueError, TypeError, KeyError) as exc:
            resp = {"ok": False, "error": "bad request: %s" % exc}
        out.write(json.dumps(resp) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
