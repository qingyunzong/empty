"""JSON-lines command-line interface for the SSI engine.

Reads one JSON object per line from stdin and writes one JSON response per
line to stdout.  Commands:

  {"cmd": "begin"}                          -> {"ok": true, "tid": 1}
  {"cmd": "read",  "tid": 1, "key": "x"}    -> {"ok": true, "value": ...}
  {"cmd": "write", "tid": 1, "key": "x", "value": 1} -> {"ok": true}
  {"cmd": "commit", "tid": 1}               -> {"ok": true}
                                               or {"ok": false,
                                                   "error": "WRITE_CONFLICT"
                                                   | "SERIALIZATION_FAILURE"}
  {"cmd": "abort",  "tid": 1}               -> {"ok": true}
  {"cmd": "set", "key": "x", "value": 1}    -> {"ok": true}   (direct commit)
  {"cmd": "dump"}                           -> {"ok": true, "data": {...}}
  {"cmd": "reset"}                          -> {"ok": true}
"""

import json
import sys

from .engine import Engine, UnknownTransaction, WriteConflict, SerializationFailure


def handle(engine, req):
    cmd = req.get("cmd")
    if cmd == "begin":
        return {"ok": True, "tid": engine.begin()}
    if cmd == "read":
        return {"ok": True, "value": engine.read(req["tid"], req["key"])}
    if cmd == "write":
        engine.write(req["tid"], req["key"], req.get("value"))
        return {"ok": True}
    if cmd == "commit":
        engine.commit(req["tid"])
        return {"ok": True}
    if cmd == "abort":
        engine.abort(req["tid"])
        return {"ok": True}
    if cmd == "set":
        engine.set(req["key"], req.get("value"))
        return {"ok": True}
    if cmd == "dump":
        return {"ok": True, "data": engine.dump()}
    if cmd == "reset":
        engine.__init__()
        return {"ok": True}
    return {"ok": False, "error": "UNKNOWN_COMMAND"}


def serve(engine, stdin, stdout):
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            resp = {"ok": False, "error": "BAD_JSON"}
        else:
            try:
                resp = handle(engine, req)
            except (WriteConflict, SerializationFailure, UnknownTransaction) as exc:
                resp = {"ok": False, "error": exc.code, "message": str(exc)}
            except (KeyError, TypeError) as exc:
                resp = {"ok": False, "error": "BAD_REQUEST", "message": str(exc)}
        stdout.write(json.dumps(resp) + "\n")
        stdout.flush()


def main():
    serve(Engine(), sys.stdin, sys.stdout)


if __name__ == "__main__":
    main()
