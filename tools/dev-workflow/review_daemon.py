"""Installed launchd entry. No credentials in this process or its output."""
from pathlib import Path
import json
import sys

# -I excludes environment and user site packages; only the pinned runtime is added.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from common import Repository, WorkflowError, digest, read, require, write, timestamp
from workflow import Workflow
from review_service import verify_files


def main():
    runtime = read(HERE / "runtime.json")
    require(runtime["install_dir"] == str(HERE), "后台运行位置不符。")
    verify_files(HERE, runtime["files"])
    require(digest(Path(runtime["python"]).read_bytes()) == runtime["python_sha256"], "Python 版本变化。")
    flow = Workflow(Repository(runtime["repo"]), runtime["state_root"])
    from review_queue import run_once, root
    results = run_once(flow, runtime["name"])
    write(root(flow) / "heartbeat.json", {"at": timestamp(), "jobs_checked": len(results)})


if __name__ == "__main__":
    try:
        main()
    except (WorkflowError, OSError, ValueError, KeyError):
        # A fixed message prevents accidental credential or provider-body disclosure.
        print(json.dumps({"error": "后台检查停止，请核对安装文件和本机任务记录。"}, ensure_ascii=False))
        sys.exit(1)
