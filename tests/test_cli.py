import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SPEC = {
    "rules": [
        {"name": "KW_IF", "regex": "if"},
        {"name": "IDENT", "regex": "[a-z]+"},
        {"name": "WS", "regex": "\\s+", "skip": True},
        {"name": "STR_START", "regex": "\"", "push": "string"},
        {"name": "STR_END", "regex": "\"", "mode": "string", "pop": True},
        {"name": "STR_TEXT", "regex": "[^\"]+", "mode": "string"},
    ]
}


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.spec_path = os.path.join(self.tmp.name, "spec.json")
        with open(self.spec_path, "w", encoding="utf-8") as fh:
            json.dump(SPEC, fh)
        self.input_path = os.path.join(self.tmp.name, "input.txt")

    def run_cli(self, raw_input):
        mode = "wb" if isinstance(raw_input, bytes) else "w"
        kwargs = {} if isinstance(raw_input, bytes) else {"encoding": "utf-8"}
        with open(self.input_path, mode, **kwargs) as fh:
            fh.write(raw_input)
        return subprocess.run(
            [sys.executable, "-m", "lexpat",
             "--spec", self.spec_path, "--input", self.input_path],
            cwd=REPO_ROOT, capture_output=True, text=True,
        )

    def test_success_emits_jsonl_tokens(self):
        proc = self.run_cli('if ab "hi"')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stderr, "")
        tokens = [json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual(
            [(t["type"], t["text"], t["line"], t["col"],
              t["mode_before"], t["mode_after"]) for t in tokens],
            [
                ("KW_IF", "if", 1, 1, "main", "main"),
                ("IDENT", "ab", 1, 4, "main", "main"),
                ("STR_START", '"', 1, 7, "main", "string"),
                ("STR_TEXT", "hi", 1, 8, "string", "string"),
                ("STR_END", '"', 1, 10, "string", "main"),
            ],
        )

    def test_lex_error_exit_2_and_no_partial_tokens(self):
        proc = self.run_cli('ab\n\n"unterminated')
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")  # no partial tokens on stdout
        err_lines = [l for l in proc.stderr.splitlines() if l.strip()]
        self.assertEqual(len(err_lines), 1)  # exactly one error reported
        err = json.loads(err_lines[0])
        self.assertEqual((err["line"], err["col"], err["mode"]), (3, 14, "string"))
        self.assertIn("expected", err)

    def test_bom_is_rejected(self):
        proc = self.run_cli(b"\xef\xbb\xbfif")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        self.assertIn("BOM", proc.stderr)

    def test_non_utf8_is_rejected(self):
        proc = self.run_cli(b"ab\xff\xfe")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        self.assertIn("UTF-8", proc.stderr)

    def test_invalid_spec_exit_2(self):
        with open(self.spec_path, "w", encoding="utf-8") as fh:
            json.dump({"rules": [{"name": "X", "regex": "(a)"}]}, fh)
        proc = self.run_cli("a")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")
        self.assertIn("capturing", proc.stderr)


if __name__ == "__main__":
    unittest.main()
