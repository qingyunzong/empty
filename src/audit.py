"""Read-only consistency auditor.

The auditor cross-checks the four stored components (doc store, lexicon,
inverted index, statistics) against each other and against the physical
UTF-8 document files. It never modifies the workspace.

De-duplication policy
---------------------
An issue is identified by ``(code, entity)``. The same underlying problem
observed through several tables is merged into a *single* issue; further
observations are attached as evidence. Example: one deleted document
referenced by the posting lists of 30 terms yields exactly one
``ORPHAN_DOC_REF`` issue with 30 evidence entries, not 30 issues.

Cascade suppression
-------------------
Count checks that are fully explained by an already reported document
level problem (missing file, orphan file, deleted-but-referenced doc,
content drift) are not counted as independent errors; they are attached
as evidence to the document level issue instead.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

from .tokenizer import tokenize
from .workspace import COMPONENTS, Workspace

EVIDENCE_LIMIT = 8


@dataclass
class Issue:
    code: str
    entity: str
    detail: str
    evidence: list = field(default_factory=list)


class AuditReport:
    def __init__(self, root):
        self.root = str(root)
        self.version = None
        self.fingerprint = ""
        self.issues: dict = {}
        self.notes: list = []

    def add(self, code, entity, detail, evidence=None):
        key = (code, str(entity))
        issue = self.issues.get(key)
        if issue is None:
            issue = Issue(code=code, entity=str(entity), detail=detail)
            self.issues[key] = issue
        if evidence:
            issue.evidence.append(str(evidence))

    def add_evidence(self, code, entity, evidence):
        key = (code, str(entity))
        if key in self.issues:
            self.issues[key].evidence.append(str(evidence))

    @property
    def ok(self) -> bool:
        return not self.issues

    def sorted_issues(self):
        return sorted(self.issues.values(), key=lambda i: (i.code, i.entity))

    def counts_by_code(self):
        counts = {}
        for issue in self.issues.values():
            counts[issue.code] = counts.get(issue.code, 0) + 1
        return dict(sorted(counts.items()))

    def to_dict(self):
        return {
            "root": self.root,
            "version": self.version,
            "fingerprint": self.fingerprint,
            "issue_count": len(self.issues),
            "counts_by_code": self.counts_by_code(),
            "issues": [
                {
                    "code": issue.code,
                    "entity": issue.entity,
                    "detail": issue.detail,
                    "evidence": issue.evidence,
                }
                for issue in self.sorted_issues()
            ],
            "notes": list(self.notes),
        }

    def render_text(self) -> str:
        lines = [f"Audit report for {self.root}"]
        lines.append(
            f"baseline version: {self.version}  fingerprint: {self.fingerprint[:16]}..."
        )
        if self.ok:
            lines.append("status: OK - no issues found")
        else:
            lines.append(f"status: {len(self.issues)} unique issue(s)")
            for issue in self.sorted_issues():
                lines.append(f"  [{issue.code}] {issue.entity}")
                lines.append(f"    {issue.detail}")
                for entry in issue.evidence[:EVIDENCE_LIMIT]:
                    lines.append(f"    - {entry}")
                hidden = len(issue.evidence) - EVIDENCE_LIMIT
                if hidden > 0:
                    lines.append(f"    - ... +{hidden} more evidence")
        for note in self.notes:
            lines.append(f"note: {note}")
        return "\n".join(lines)


class Auditor:
    def __init__(self, ws: Workspace):
        self.ws = ws

    def run(self) -> AuditReport:
        ws = self.ws
        report = AuditReport(ws.root)
        report.fingerprint = ws.fingerprint()

        payloads = {name: ws.load(name) for name in COMPONENTS}
        for name in COMPONENTS:
            if payloads[name] is None:
                report.add(
                    "COMPONENT_MISSING", name,
                    f"component file {name}.json is missing",
                )
        versions = {
            name: payload.get("version")
            for name, payload in payloads.items()
            if isinstance(payload, dict)
        }
        if len(set(versions.values())) > 1:
            report.add(
                "VERSION_SKEW", "components",
                "components were written at different versions",
                evidence="; ".join(f"{n}=v{v}" for n, v in sorted(versions.items())),
            )
        report.version = ws.common_version()

        manifest = (payloads["docstore"] or {}).get("docs", {}) or {}
        terms = (payloads["lexicon"] or {}).get("terms", {}) or {}
        postings = (payloads["index"] or {}).get("postings", {}) or {}

        # doc_id -> code of its document level issue (cascade suppression)
        doc_issue_codes: dict = {}
        tokens_by_doc: dict = {}
        unreadable = 0

        # --- doc store vs physical files -------------------------------
        referenced = set()
        for doc_id, meta in sorted(manifest.items()):
            fname = meta.get("file", f"docs/{doc_id}.txt")
            referenced.add(fname)
            path = ws.data_dir / fname
            if not path.exists():
                report.add(
                    "MISSING_DOC_FILE", doc_id,
                    f"doc store references missing file {fname}",
                )
                doc_issue_codes[doc_id] = "MISSING_DOC_FILE"
                unreadable += 1
                continue
            raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != meta.get("sha256"):
                report.add(
                    "DOC_CONTENT_DRIFT", doc_id,
                    "file content no longer matches the manifest sha256",
                )
                doc_issue_codes[doc_id] = "DOC_CONTENT_DRIFT"
            try:
                tokens = tokenize(raw.decode("utf-8"))
            except UnicodeDecodeError:
                unreadable += 1
                continue
            tokens_by_doc[doc_id] = tokens
            if meta.get("num_tokens") != len(tokens):
                report.add(
                    "MANIFEST_LENGTH_MISMATCH", doc_id,
                    "manifest num_tokens disagrees with the tokenized file",
                    evidence=f"manifest={meta.get('num_tokens')} actual={len(tokens)}",
                )

        if ws.docs_dir.exists():
            for path in sorted(ws.docs_dir.glob("*.txt")):
                if f"docs/{path.name}" in referenced:
                    continue
                report.add(
                    "ORPHAN_DOC_FILE", path.name,
                    "document file exists on disk but is not registered in the doc store",
                )
                doc_issue_codes.setdefault(path.stem, "ORPHAN_DOC_FILE")
                try:
                    tokens_by_doc[path.stem] = tokenize(
                        path.read_text(encoding="utf-8")
                    )
                except (OSError, UnicodeDecodeError):
                    pass

        # --- lexicon internal structure --------------------------------
        id_to_terms: dict = {}
        for term, entry in terms.items():
            id_to_terms.setdefault(entry.get("term_id"), []).append(term)
        for term_id, owners in sorted(id_to_terms.items(), key=lambda kv: str(kv[0])):
            if len(owners) > 1:
                report.add(
                    "TERM_ID_COLLISION", term_id,
                    "multiple terms share the same term_id",
                    evidence="terms: " + ", ".join(sorted(owners)),
                )
        lexicon_ids = set(id_to_terms)

        # --- inverted index vs lexicon and doc store -------------------
        orphan_terms: dict = {}
        for term_id, doc_ids in sorted(postings.items()):
            if term_id not in lexicon_ids:
                report.add(
                    "MISSING_LEXICON_ENTRY", term_id,
                    "inverted index has postings for a term_id the lexicon does not know",
                    evidence=f"{len(doc_ids)} posting(s)",
                )
            owners = id_to_terms.get(term_id)
            label = owners[0] if owners and len(owners) == 1 else str(term_id)
            seen = set()
            for doc_id in doc_ids:
                if doc_id in seen:
                    report.add(
                        "DUPLICATE_POSTING", term_id,
                        "posting list contains duplicate doc references",
                        evidence=f"doc={doc_id}",
                    )
                seen.add(doc_id)
                if doc_id not in manifest:
                    report.add(
                        "ORPHAN_DOC_REF", doc_id,
                        "inverted index references a document that is absent "
                        "from the doc store (deleted?)",
                        evidence=f"term_id={term_id}",
                    )
                    doc_issue_codes.setdefault(doc_id, "ORPHAN_DOC_REF")
                    orphan_terms.setdefault(doc_id, []).append(label)
        for doc_id, labels in sorted(orphan_terms.items()):
            sample = sorted(labels)[:5]
            suffix = f" (+{len(labels) - 5} more)" if len(labels) > 5 else ""
            report.add_evidence(
                "ORPHAN_DOC_REF", doc_id,
                f"df/cf of {len(labels)} term(s) likely stale: "
                + ", ".join(sample) + suffix,
            )

        # --- lexicon vs index counts (stored vs stored) ----------------
        for term, entry in sorted(terms.items()):
            term_id = entry.get("term_id")
            df = entry.get("df")
            if term_id in postings:
                count = len(postings[term_id])
                if df != count:
                    report.add(
                        "DF_MISMATCH", term,
                        "lexicon df does not match the posting list length",
                        evidence=f"df={df} postings={count}",
                    )
            elif df:
                report.add(
                    "ORPHAN_LEXICON_ENTRY", term,
                    "lexicon entry has df>0 but no postings in the inverted index",
                    evidence=f"df={df} term_id={term_id}",
                )

        # --- statistics vs doc store and lexicon (stored vs stored) ----
        if isinstance(payloads["stats"], dict):
            stats = payloads["stats"]
            expected = {
                "num_docs": len(manifest),
                "num_terms": len(terms),
                "total_tokens": sum(m.get("num_tokens", 0) for m in manifest.values()),
            }
            for field_name, want in expected.items():
                got = stats.get(field_name)
                if got != want:
                    report.add(
                        "STATS_MISMATCH", field_name,
                        "statistics disagree with the doc store / lexicon",
                        evidence=f"stats={got} expected={want}",
                    )

        # --- ground truth recomputed from the physical files -----------
        if unreadable:
            report.notes.append(
                f"ground-truth checks (cf, postings drift) skipped: "
                f"{unreadable} manifest doc(s) unreadable"
            )
        else:
            self._check_ground_truth(report, terms, postings, tokens_by_doc,
                                     doc_issue_codes)
        return report

    def _check_ground_truth(self, report, terms, postings, tokens_by_doc,
                            doc_issue_codes):
        expected_postings: dict = {}
        expected_cf: dict = {}
        for doc_id, tokens in tokens_by_doc.items():
            for term in set(tokens):
                expected_postings.setdefault(term, set()).add(doc_id)
            for term in tokens:
                expected_cf[term] = expected_cf.get(term, 0) + 1

        # cf check, skipping terms whose counts a document level issue
        # can explain (those are evidence of that issue, not new errors)
        suppressed_cf: dict = {}
        for term, entry in sorted(terms.items()):
            term_id = entry.get("term_id")
            involved = expected_postings.get(term, set()) | set(
                postings.get(term_id, [])
            )
            blocked = involved & set(doc_issue_codes)
            if blocked:
                for doc_id in blocked:
                    suppressed_cf.setdefault(doc_id, set()).add(term)
                continue
            actual_cf = expected_cf.get(term, 0)
            if entry.get("cf") != actual_cf:
                report.add(
                    "CF_MISMATCH", term,
                    "lexicon collection frequency disagrees with the document files",
                    evidence=f"cf={entry.get('cf')} expected={actual_cf}",
                )

        # postings drift, partitioning explained vs unexplained diffs
        explained: dict = {}
        for term in sorted(set(terms) | set(expected_postings)):
            entry = terms.get(term)
            term_id = entry.get("term_id") if entry else None
            stored = set(postings.get(term_id, [])) if term_id in postings else set()
            expected = expected_postings.get(term, set())
            missing = expected - stored
            extra = stored - expected
            for doc_id in missing | extra:
                if doc_id in doc_issue_codes:
                    explained.setdefault(doc_id, set()).add(term)
            unexp_missing = sorted(d for d in missing if d not in doc_issue_codes)
            unexp_extra = sorted(d for d in extra if d not in doc_issue_codes)
            if unexp_missing or unexp_extra:
                evidence = []
                if unexp_missing:
                    evidence.append("missing docs: " + ", ".join(unexp_missing))
                if unexp_extra:
                    evidence.append("unexpected docs: " + ", ".join(unexp_extra))
                report.add(
                    "POSTINGS_DRIFT",
                    term_id if term_id is not None else term,
                    "inverted index postings disagree with the document files",
                    evidence="; ".join(evidence),
                )

        # attach suppressed counts / explained drift to the doc issues
        def doc_entity(doc_id):
            code = doc_issue_codes[doc_id]
            return f"{doc_id}.txt" if code == "ORPHAN_DOC_FILE" else doc_id

        for doc_id, affected in sorted(explained.items()):
            if doc_issue_codes[doc_id] == "ORPHAN_DOC_REF":
                continue  # already evidenced per term above
            sample = sorted(affected)[:5]
            suffix = f" (+{len(affected) - 5} more)" if len(affected) > 5 else ""
            report.add_evidence(
                doc_issue_codes[doc_id], doc_entity(doc_id),
                f"postings out of sync for {len(affected)} term(s): "
                + ", ".join(sample) + suffix,
            )
        for doc_id, affected in sorted(suppressed_cf.items()):
            if doc_issue_codes[doc_id] == "ORPHAN_DOC_REF":
                continue
            sample = sorted(affected)[:5]
            suffix = f" (+{len(affected) - 5} more)" if len(affected) > 5 else ""
            report.add_evidence(
                doc_issue_codes[doc_id], doc_entity(doc_id),
                f"cf not verifiable for {len(affected)} term(s): "
                + ", ".join(sample) + suffix,
            )
