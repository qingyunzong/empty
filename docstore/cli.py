"""JSON-lines command interface: python3.11 -m docstore <store-dir>.

Reads one JSON command per line on stdin, writes one JSON result per
line on stdout.  Commands: apply, query, get, create_index, drop_index,
indexes, snapshot, release, reclaim, version, doc.
"""

import sys

from .errors import DocStoreError
from .store import DocumentStore
from .strictjson import dumps, loads


class _Session:
    def __init__(self, store):
        self.store = store
        self.snapshots = {}
        self.next_id = 1

    def handle(self, request):
        cmd = request.get("cmd")
        handler = getattr(self, "cmd_" + str(cmd), None)
        if handler is None:
            raise DocStoreError("unknown command: %r" % (cmd,))
        return handler(request)

    def _snapshot(self, request):
        sid = request.get("snapshot")
        if sid is None:
            return None
        if sid not in self.snapshots:
            raise DocStoreError("unknown snapshot id: %r" % (sid,))
        return self.snapshots[sid]

    def cmd_apply(self, req):
        return {"version": self.store.apply(req["ops"])}

    def cmd_query(self, req):
        snap = self._snapshot(req)
        target = snap if snap is not None else self.store
        return {"results": target.query(req["filters"], req.get("sort_by"))}

    def cmd_get(self, req):
        snap = self._snapshot(req)
        target = snap if snap is not None else self.store
        return {"value": target.get(req.get("path", ""))}

    def cmd_create_index(self, req):
        self.store.create_index(req["name"], req["path"])
        return {}

    def cmd_drop_index(self, req):
        self.store.drop_index(req["name"])
        return {}

    def cmd_indexes(self, req):
        return {"indexes": self.store.list_indexes()}

    def cmd_snapshot(self, req):
        snap = self.store.open_snapshot()
        sid = self.next_id
        self.next_id += 1
        self.snapshots[sid] = snap
        return {"snapshot": sid, "version": snap.version}

    def cmd_release(self, req):
        sid = req["snapshot"]
        if sid not in self.snapshots:
            raise DocStoreError("unknown snapshot id: %r" % (sid,))
        self.snapshots.pop(sid).release()
        return {}

    def cmd_reclaim(self, req):
        return {"version": self.store.reclaim()}

    def cmd_version(self, req):
        return {"version": self.store.version}

    def cmd_doc(self, req):
        return {"doc": self.store.get("")}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1:
        print("usage: python3.11 -m docstore <store-dir>", file=sys.stderr)
        return 2
    session = _Session(DocumentStore(argv[0]))
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = loads(line)
            result = session.handle(request)
            result["ok"] = True
        except Exception as exc:
            result = {"ok": False,
                      "error": "%s: %s" % (type(exc).__name__, exc)}
        out.write(dumps(result) + "\n")
        out.flush()
    return 0
