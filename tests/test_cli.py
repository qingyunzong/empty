import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "inclex", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.doc = Path(self.tmp.name) / "doc.txt"

    def write(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.doc.write_bytes(data)

    def test_lex_without_edit(self):
        self.write("x = 1\n")
        proc = run_cli(str(self.doc))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.strip().splitlines()
        header = json.loads(lines[0])
        self.assertEqual(header, {"changed_tokens": 3, "token_count": 3})
        tokens = [json.loads(line) for line in lines[1:]]
        self.assertEqual([t["type"] for t in tokens],
                         ["IDENT", "OP", "NUMBER"])
        self.assertEqual(tokens[0],
                         {"type": "IDENT", "text": "x", "start": 0,
                          "end": 1, "state": "main"})

    def test_edit_reports_changed_tokens(self):
        self.write("x = 1\n")
        proc = run_cli(str(self.doc), "--edit", "4,5,2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        header = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(header["changed_tokens"], 1)
        self.assertEqual(header["token_count"], 3)

    def test_edit_text_may_contain_commas(self):
        self.write("f()\n")
        proc = run_cli(str(self.doc), "--edit", "2,2,a,b")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        tokens = [json.loads(l) for l in proc.stdout.strip().splitlines()[1:]]
        self.assertEqual([t["text"] for t in tokens],
                         ["f", "(", "a", ",", "b", ")"])

    def test_invalid_utf8(self):
        self.write(b"\xff\xfe invalid")
        proc = run_cli(str(self.doc))
        self.assertEqual(proc.returncode, 1)
        err = json.loads(proc.stderr)
        self.assertIn("invalid UTF-8", err["error"])
        self.assertEqual(err["offset"], 0)
        self.assertEqual(err["state"], "decode")

    def test_out_of_bounds_edit(self):
        self.write("abc")
        proc = run_cli(str(self.doc), "--edit", "0,99,z")
        self.assertEqual(proc.returncode, 1)
        err = json.loads(proc.stderr)
        self.assertEqual(err["offset"], 99)
        self.assertEqual(err["state"], "main")

    def test_unterminated_construct(self):
        self.write('a "open\n')
        proc = run_cli(str(self.doc))
        self.assertEqual(proc.returncode, 1)
        err = json.loads(proc.stderr)
        self.assertEqual(err["offset"], 2)
        self.assertEqual(err["state"], "in_string")

    def test_bad_edit_spec(self):
        self.write("abc")
        proc = run_cli(str(self.doc), "--edit", "1,2")
        self.assertEqual(proc.returncode, 1)

    def test_missing_file(self):
        proc = run_cli(str(Path(self.tmp.name) / "nope.txt"))
        self.assertEqual(proc.returncode, 2)

    def test_internal_inconsistency_exit_code_11(self):
        self.write("a b")
        from inclex import __main__ as cli
        from inclex.lexer import lex_full

        # First call (Document init) behaves normally; the verification
        # call inside edit() returns garbage to force a divergence.
        with mock.patch(
            "inclex.incremental.lex_full",
            side_effect=[lex_full("a b"), ["bogus"]],
        ):
            rc = cli.main([str(self.doc), "--edit", "0,0,c "])
        self.assertEqual(rc, 11)


if __name__ == "__main__":
    unittest.main()
