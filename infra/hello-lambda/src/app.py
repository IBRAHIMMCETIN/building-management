import json
import os
import platform
from datetime import datetime, timezone


def handler(event, context):
    body = {
        "message": "building-management CI/CD calisiyor",
        "git_sha": os.environ.get("GIT_SHA", "unknown"),
        "python": platform.python_version(),
        "region": os.environ.get("AWS_REGION"),
        "request_id": context.aws_request_id,
        "time": datetime.now(timezone.utc).isoformat(),
    }
    print(json.dumps(body))
    return {"statusCode": 200, "body": json.dumps(body)}
