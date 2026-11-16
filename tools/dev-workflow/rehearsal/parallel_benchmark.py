"""Same synthetic work in serial/parallel; no service, model, or user state."""
import argparse
from pathlib import Path
import sys
import shutil
import tempfile
import time
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from collab import align
from common import digest, git, git_line, write
import execution
from workflow import Workflow


def trial(root, limit):
    root.mkdir()
    flow = Workflow(SimpleNamespace(name="synthetic/parallel-check"), root / "state")
    for key in ("first-work", "second-work"):
        flow.new({"id": key, "title": key, "authorization_ref": "synthetic benchmark", "scope": ["tools/"],
                  "observed_in_version": "synthetic"})
        folder, task = flow.task(key)
        note = folder / "decision.md"
        note.write_text(note.read_text().replace("[TBD]", "合成耗时检查"))
        align(flow, key, "合成确认，仅用于离线检查")
        source = root / key
        source.mkdir()
        git(source, "init", "--quiet")
        git(source, "config", "user.name", "Synthetic fixture")
        git(source, "config", "user.email", "fixture@example.invalid")
        check = source / "tools/dev-workflow/test_synthetic.py"
        write(check, b"import time,unittest\nclass Check(unittest.TestCase):\n def test_wait(self):\n  time.sleep(0.8)\n")
        git(source, "add", ".")
        git(source, "commit", "--quiet", "-m", "synthetic work")
        task.update(phase="open", decision_sha256=flow.check(key)["sha256"], checkout=str(source),
                    base=git_line(source, "rev-parse", "HEAD"))
        write(folder / "task.json", task)
        execution.register(flow, key, {"steps": [{"id": "checks", "title": "相同合成检查", "output": "实际检查日志",
                                                   "recipe": "workflow-checks"}]})
    execution.set_limit(flow, limit)
    start = time.monotonic()
    result = execution.run_ready(flow)
    elapsed = time.monotonic() - start
    assert len(result["completed"]) == 2 and all(r["status"] == "pass" for r in result["completed"])
    assert not execution.run_ready(flow)["completed"]
    return {"limit": limit, "end_to_end_seconds": elapsed, **execution.metrics(flow)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="parallel-rehearsal-") as name:
        root = Path(name).resolve()
        serial, parallel = trial(root / "serial", 1), trial(root / "parallel", 2)
        report = {"kind": "synthetic-only", "serial": serial, "parallel": parallel, "model_requests": 0,
                  "ratio": serial["end_to_end_seconds"] / parallel["end_to_end_seconds"],
                  "limitation": "实际执行器与相同合成等待工作；不能证明真实开发、构建或用户体验提速"}
        proofs = args.output.resolve().parent / (args.output.stem + "-evidence")
        proofs.mkdir(parents=True, exist_ok=True)
        report["evidence"] = {}
        for path in root.rglob("check.log"):
            target = proofs / (path.parent.name + ".log")
            shutil.copy2(path, target)
            report["evidence"][str(target)] = digest(target.read_bytes())
        report["executor_sha256"] = digest(Path(execution.__file__).read_bytes())
        write(args.output, report)
        print({"serial_seconds": serial["end_to_end_seconds"], "parallel_seconds": parallel["end_to_end_seconds"],
               "ratio": report["ratio"], "record": str(args.output)})


if __name__ == "__main__":
    main()
