"""patchtool: minimum-cost executable patches between file trees.

Cost model (all costs are non-negative integers):

* add / delete : byte size of the file content
* modify       : length of the shortest line edit script
* rename       : path edit distance + content edit script length

Cross-path pairing is decided by a global minimum-cost bipartite matching
(never by greedy same-hash pairing); ties are broken by the
lexicographically smallest normalised operation sequence.  Optimality is
certified by matching dual potentials, verifiable without the optimiser.
"""
from .apply import ApplyError, apply_patch
from .certificate import CertificateError, verify_certificate
from .enumerate import brute_force_best
from .model import FileTree, ModelError, byte_count, fingerprint
from .patch import diff_trees, op_key

__all__ = [
    "ApplyError", "CertificateError", "FileTree", "ModelError",
    "apply_patch", "brute_force_best", "byte_count", "diff_trees",
    "fingerprint", "op_key", "verify_certificate",
]

__version__ = "1.0.0"
