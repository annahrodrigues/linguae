"""
Tests for tools/eleven.py: `python tools/test_eleven.py`.

Credits are the thing worth testing here. A run that spends them twice on the
same line, or starts a course it cannot finish, costs a month of allowance to
find out about -- so a stand-in for the API answers on localhost and the real
tool talks to that, down to the HTTP.

What is checked is what would cost something: that a clip already recorded from
the same line is not bought again, that a line rewritten since is, that the
ledger is written as it goes rather than at the end, and that a run too big for
the allowance stops before the first request rather than half way through.

No dependencies, and no key: it makes its own.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import eleven  # noqa: E402

# A short mp3 the stand-in hands back. Not playable, and nothing reads it as
# audio: only --audit does that, and its own test skips the length check.
BLOB = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64


class Fake(BaseHTTPRequestHandler):
    """The three endpoints the tool uses, and the two refusals it handles."""

    asked = []          # every path that was requested
    said = []           # every line that was charged for
    left = 10000
    voices = ["Charlotte", "George"]
    fail = None         # 401 or 429, to make the API refuse

    def log_message(self, *a):
        pass

    def _send(self, code, body, kind="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        Fake.asked.append(self.path)
        if Fake.fail:
            return self._send(Fake.fail, b'{"detail":"no"}')
        if self.path.startswith("/user/subscription"):
            return self._send(200, json.dumps({
                "tier": "free", "character_count": 10000 - Fake.left,
                "character_limit": 10000}).encode())
        if self.path.startswith("/voices"):
            return self._send(200, json.dumps({"voices": [
                {"voice_id": "id-" + n.lower(), "name": n, "category": "premade"}
                for n in Fake.voices]}).encode())
        return self._send(404, b'{"detail":"nope"}')

    def do_POST(self):
        Fake.asked.append(self.path)
        if Fake.fail:
            return self._send(Fake.fail, b'{"detail":"no"}')
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n).decode("utf-8"))
        Fake.said.append(body["text"])
        Fake.left -= len(body["text"])
        return self._send(200, BLOB, "audio/mpeg")


class Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Fake)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.was = eleven.API
        eleven.API = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        eleven.API = cls.was
        cls.server.shutdown()

    def setUp(self):
        """Each test gets its own assets/audio to write into."""
        self.tmp = tempfile.mkdtemp(prefix="eleven-test-")
        self.audio = eleven.AUDIO
        eleven.AUDIO = self.tmp
        os.environ["ELEVENLABS_API_KEY"] = "test-key"
        Fake.asked = []
        Fake.said = []
        Fake.left = 10000
        Fake.fail = None

    def tearDown(self):
        eleven.AUDIO = self.audio
        os.environ.pop("ELEVENLABS_API_KEY", None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def ledger(self):
        with io.open(os.path.join(self.tmp, "recorded.json"), encoding="utf-8") as f:
            return json.load(f)

    # ---------- what it buys ----------

    def test_a_run_writes_the_clips_and_says_what_it_said(self):
        eleven.record("de", limit=3)
        for n in range(3):
            self.assertTrue(os.path.exists(os.path.join(self.tmp, "de", "de-0-%d.mp3" % n)),
                            "de-0-%d.mp3 should have been written" % n)
        said = self.ledger()["de"]
        self.assertEqual(len(said), 3)
        self.assertEqual(sorted(said), ["de-0-0", "de-0-1", "de-0-2"])
        for rid, text in said.items():
            self.assertTrue(text.strip(), rid + " was recorded from nothing")
        self.assertEqual(len(Fake.said), 3, "three lines, three requests")

    def test_a_line_already_recorded_is_not_bought_again(self):
        eleven.record("de", limit=3)
        before = len(Fake.said)
        eleven.record("de", limit=3)
        self.assertEqual(len(Fake.said), before, "the second run should spend nothing")

    def test_a_line_rewritten_since_is_bought_again(self):
        eleven.record("de", limit=3)
        book = self.ledger()
        book["de"]["de-0-1"] = "something else entirely"
        eleven.write_ledger(book)
        Fake.said = []
        eleven.record("de", limit=3)
        self.assertEqual(len(Fake.said), 1, "only the changed line")

    def test_force_buys_every_line_again(self):
        eleven.record("de", limit=3)
        Fake.said = []
        eleven.record("de", limit=3, force=True)
        self.assertEqual(len(Fake.said), 3)

    def test_the_tiles_are_a_run_of_their_own(self):
        eleven.record("de", limit=2, which="words")
        said = self.ledger()["de"]
        self.assertTrue(all(k.startswith("w/") for k in said), said)
        self.assertTrue(os.path.isdir(os.path.join(self.tmp, "de", "w")))

    # ---------- what it refuses ----------

    def test_a_run_too_big_for_the_allowance_stops_before_it_starts(self):
        Fake.left = 12
        with self.assertRaises(SystemExit) as caught:
            eleven.record("de", limit=5)
        self.assertIn("more than the account has", str(caught.exception))
        self.assertEqual(Fake.said, [], "nothing should have been charged for")

    def test_yes_starts_a_run_the_allowance_will_not_cover(self):
        Fake.left = 12
        eleven.record("de", limit=2, yes=True)
        self.assertTrue(Fake.said, "--yes should have gone ahead")

    def test_a_voice_the_account_does_not_have_is_named_plainly(self):
        with self.assertRaises(SystemExit) as caught:
            eleven.record("de", limit=1, voice="Somebody")
        said = str(caught.exception)
        self.assertIn("Somebody", said)
        self.assertIn("Charlotte", said, "it should say what the account does have")
        self.assertEqual(Fake.said, [])

    def test_a_refused_key_says_so_once(self):
        Fake.fail = 401
        with self.assertRaises(SystemExit) as caught:
            eleven.record("de", limit=1)
        self.assertIn("refused", str(caught.exception))

    def test_running_out_of_credits_is_told_apart_from_a_bad_key(self):
        Fake.fail = 429
        with self.assertRaises(SystemExit) as caught:
            eleven.record("de", limit=1)
        self.assertIn("credits", str(caught.exception))

    def test_a_course_kokoro_already_speaks_is_not_offered(self):
        with self.assertRaises(SystemExit) as caught:
            eleven.record("fr", limit=1)
        self.assertIn("no voice mapped", str(caught.exception))
        self.assertEqual(Fake.said, [])

    # ---------- what it writes down ----------

    def test_the_ledger_is_written_as_it_goes(self):
        """A run that dies half way has still said what it bought."""
        real = eleven.speak
        calls = []

        def die_on_the_third(key, voice_id, text):
            calls.append(text)
            if len(calls) == 3:
                raise RuntimeError("the network went away")
            return real(key, voice_id, text)

        eleven.speak = die_on_the_third
        try:
            with self.assertRaises(RuntimeError):
                eleven.record("de", limit=5)
        finally:
            eleven.speak = real
        said = self.ledger()["de"]
        self.assertEqual(len(said), 2, "the two that were paid for are written down")

    def test_the_ledger_keeps_the_other_courses(self):
        eleven.write_ledger({"fr": {"fr-0-0": "bonjour"}})
        eleven.record("de", limit=1)
        book = self.ledger()
        self.assertEqual(book["fr"], {"fr-0-0": "bonjour"}, "Kokoro's half must survive")
        self.assertIn("de", book)

    def test_the_key_is_read_from_the_file_when_the_variable_is_empty(self):
        os.environ.pop("ELEVENLABS_API_KEY", None)
        keyfile = os.path.join(self.tmp, ".eleven-key")
        was = eleven.KEYFILE
        eleven.KEYFILE = keyfile
        try:
            with io.open(keyfile, "w", encoding="utf-8") as f:
                f.write("  from-the-file\n")
            self.assertEqual(eleven.api_key(), "from-the-file")
            os.remove(keyfile)
            with self.assertRaises(SystemExit) as caught:
                eleven.api_key()
            self.assertIn("no API key", str(caught.exception))
        finally:
            eleven.KEYFILE = was


if __name__ == "__main__":
    unittest.main(verbosity=2)
