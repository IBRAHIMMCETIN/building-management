import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import app  # noqa: E402


class HandlerTest(unittest.TestCase):
    def test_returns_200_with_git_sha(self):
        context = SimpleNamespace(aws_request_id="test-request")
        with mock.patch.dict(os.environ, {"GIT_SHA": "abc123"}):
            result = app.handler({}, context)

        self.assertEqual(result["statusCode"], 200)
        body = json.loads(result["body"])
        self.assertEqual(body["git_sha"], "abc123")
        self.assertEqual(body["request_id"], "test-request")


if __name__ == "__main__":
    unittest.main()
