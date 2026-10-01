"""Read-only behavioral probes against the final A/B source trees."""
import json
import sys
import tempfile
from pathlib import Path

locations = json.loads(Path(__file__).with_name("source-locations.json").read_text())

sys.path.insert(0, locations["A"]["workspace"])
from reorder.engine import Engine
from reorder.messages import Frame as AFrame, make_message_frames as amsg

sys.path.insert(0, locations["B"]["workspace"])
from msdeliv.engine import DeliveryEngine
from msdeliv.frames import Frame as BFrame, message_frames as bmsg
from msdeliv.log import DurableLog


def a_conflict_after_ack():
    with tempfile.TemporaryDirectory() as temp:
        engine = Engine(journal_path=str(Path(temp) / "a.jsonl"))
        first = amsg("s", 0, 0, "original")[0]
        changed = amsg("s", 0, 0, "changed")[0]
        initial = engine.receive(first)["status"]
        result = engine.receive(changed)
        evidence = len(engine.conflicts())
        engine.close()
        return {"initial": initial, "conflict_status": result["status"],
                "conflict_evidence_count": evidence}


def a_late_epoch():
    with tempfile.TemporaryDirectory() as temp:
        engine = Engine(journal_path=str(Path(temp) / "a.jsonl"))
        first = engine.receive(amsg("s", 0, 0, "old-epoch")[0])["status"]
        newer = engine.receive(amsg("s", 1, 0, "new-epoch")[0])["status"]
        late = engine.receive(amsg("s", 0, 1, "late")[0])["status"]
        engine.close()
        return {"first": first, "newer": newer, "late_old_epoch": late}


def b_corrupt_payload():
    with tempfile.TemporaryDirectory() as temp:
        log = DurableLog(str(Path(temp) / "b.jsonl"))
        engine = DeliveryEngine(log=log)
        good = bmsg("s", 0, 0, "original")[0]
        corrupt = BFrame(good.stream, good.epoch, good.seq, good.frag,
                         good.frags, "changed", good.hash, good.close)
        received = engine.offer(corrupt)
        delivered = engine.poll()
        log.close()
        return {"received": received, "delivered": delivered,
                "hash_matches_content": bmsg("s", 0, 0, "changed")[0].hash == good.hash}


def b_recovered_conflict():
    with tempfile.TemporaryDirectory() as temp:
        path = str(Path(temp) / "b.jsonl")
        log = DurableLog(path)
        engine = DeliveryEngine(log=log)
        first = bmsg("s", 0, 0, "original")[0]
        changed = bmsg("s", 0, 0, "changed")[0]
        engine.offer(first)
        engine.poll()
        before = engine.offer(changed)
        before_evidence = len(engine.evidence())
        log.close()
        recovered = DeliveryEngine.recover(path)
        after = recovered.offer(changed)
        after_evidence = len(recovered.evidence())
        recovered.log.close()
        return {"before_status": before["status"],
                "before_evidence_count": before_evidence,
                "after_status": after["status"],
                "after_evidence_count": after_evidence}


if __name__ == "__main__":
    print("interpreter:", sys.version.split()[0])
    print("A sha:", locations["A"]["sha"])
    print("B sha:", locations["B"]["sha"])
    print("A assembled conflict:", json.dumps(a_conflict_after_ack(), ensure_ascii=False))
    print("A late epoch:", json.dumps(a_late_epoch(), ensure_ascii=False))
    print("B corrupt payload:", json.dumps(b_corrupt_payload(), ensure_ascii=False))
    print("B recovered conflict:", json.dumps(b_recovered_conflict(), ensure_ascii=False))
