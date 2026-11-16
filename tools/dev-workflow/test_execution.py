from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import execution
from collab import align, progress
from common import WorkflowError, git, git_line, read, write
from workflow import Workflow


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = Mock()
        self.repo.name = "example/arcfold"
        self.flow = Workflow(self.repo, self.root / "state")
        for key in ("task-one", "task-two"):
            self.flow.new({"id": key, "title": key, "authorization_ref": "synthetic", "scope": ["src/"],
                           "observed_in_version": "0.5.1"})
            path, task = self.flow.task(key)
            decision = path / "decision.md"
            decision.write_text(decision.read_text().replace("[TBD]", "具体合成场景"))
            note = self.flow.check(key)
            align(self.flow, key, "合成确认")
            task.update(phase="open", decision_sha256=note["sha256"], base="a" * 40,
                        checkout=str(self.root / key))
            write(path / "task.json", task)
        self.proof = self.root / "result.json"
        write(self.proof, {"check": "synthetic", "outcome": "pass"})

    def step(self, name="develop", **extra):
        return {"id": name, "title": name, "output": "actual evidence", **extra}

    def plan(self, key, *steps):
        return execution.register(self.flow, key, {"steps": list(steps)})

    def rows(self):
        return {r["step"]: r for r in execution.view(self.flow)["steps"]}

    def complete(self, key, step="develop"):
        run = execution.claim(self.flow, key, step)["run"]
        return execution.finish(self.flow, run["id"], "pass", [str(self.proof)])

    def test_dependency_waits_only_for_the_consuming_step_and_automatically_unblocks(self):
        self.plan("task-one", self.step())
        self.plan("task-two", self.step("local-work"), self.step("integrate", needs=[
            {"step": "task-one/develop", "reason": "use completed producer output"}]))
        rows = self.rows()
        self.assertEqual(rows["task-two/local-work"]["state"], "ready")
        self.assertEqual(rows["task-two/integrate"]["state"], "waiting")
        self.complete("task-one")
        self.assertEqual(self.rows()["task-two/integrate"]["state"], "ready")

    def test_cycle_rejected_without_committing_partial_plan(self):
        self.plan("task-one", self.step(needs=[{"step": "task-two/develop", "reason": "fixture input"}]))
        before = execution.state(self.flow)
        with self.assertRaisesRegex(WorkflowError, "循环"):
            self.plan("task-two", self.step(needs=[{"step": "task-one/develop", "reason": "fixture input"}]))
        self.assertEqual(execution.state(self.flow), before)

    def test_two_processes_claim_once_and_other_task_keeps_running(self):
        self.plan("task-one", self.step())
        self.plan("task-two", self.step())
        program = ("import json,sys; from common import Repository; from workflow import Workflow; "
                   "import execution; f=Workflow(Repository('example/arcfold'),sys.argv[1]); "
                   "print(json.dumps(execution.claim(f,'task-one','develop')))")
        def invoke():
            return json.loads(subprocess.run([sys.executable, "-B", "-c", program, str(self.root / "state")],
                                             cwd=Path(__file__).parent, check=True, capture_output=True, text=True).stdout)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: invoke(), range(2)))
        self.assertEqual(sum(row["acquired"] for row in results), 1)
        self.assertEqual(results[0]["run"]["id"], results[1]["run"]["id"])
        second = execution.claim(self.flow, "task-two", "develop")
        self.assertTrue(second["acquired"])
        self.assertEqual(len(execution.view(self.flow)["active"]), 2)

    def test_unknown_effect_retains_object_and_does_not_block_other_objects(self):
        self.plan("task-one", self.step(resources=["version:0.6.0"], external=True))
        self.plan("task-two", self.step(resources=["version:0.6.0"]), self.step("different", resources=["version:0.7.0"]))
        run = execution.claim(self.flow, "task-one", "develop")["run"]
        execution.finish(self.flow, run["id"], "unknown", [str(self.proof)])
        self.assertEqual(self.rows()["task-two/develop"]["state"], "waiting")
        self.assertEqual(self.rows()["task-two/different"]["state"], "ready")
        with self.assertRaisesRegex(WorkflowError, "未知"):
            execution.retry(self.flow, run["id"], str(self.proof))
        execution.finish(self.flow, run["id"], "pass", [str(self.proof)])
        self.assertEqual(self.rows()["task-two/develop"]["state"], "ready")

    def test_changed_inputs_keep_old_history_without_overwriting_new_generation(self):
        self.plan("task-one", self.step(inputs={"revision": 1}), self.step("unrelated"))
        self.complete("task-one", "unrelated")
        old = execution.claim(self.flow, "task-one", "develop")["run"]
        self.plan("task-one", self.step(inputs={"revision": 2}), self.step("unrelated"))
        self.assertEqual(self.rows()["task-one/develop"]["state"], "waiting")
        execution.finish(self.flow, old["id"], "pass", [str(self.proof)])
        self.assertEqual(self.rows()["task-one/develop"]["state"], "ready")
        self.assertEqual(self.rows()["task-one/unrelated"]["state"], "pass")
        new = self.complete("task-one")
        self.assertNotEqual(old["id"], new["id"])
        self.assertEqual(execution.state(self.flow)["runs"][old["id"]]["status"], "pass")

    def test_readonly_progress_never_creates_state_and_does_not_use_remote(self):
        self.assertFalse(execution.root(self.flow).exists())
        execution.view(self.flow)
        self.assertFalse(execution.root(self.flow).exists())
        self.plan("task-one", self.step())
        before = (execution.root(self.flow) / "state.json").read_bytes()
        self.assertEqual(progress(self.flow)["execution"]["steps"][0]["state"], "ready")
        self.assertEqual((execution.root(self.flow) / "state.json").read_bytes(), before)
        self.repo.main.assert_not_called()
        self.repo.api.assert_not_called()

    def test_tampered_evidence_cannot_unblock_consumer(self):
        self.plan("task-one", self.step())
        self.plan("task-two", self.step(needs=[{"step": "task-one/develop", "reason": "actual producer result"}]))
        result = self.complete("task-one")
        Path(next(iter(result["evidence"]))).write_text("changed")
        self.assertEqual(self.rows()["task-one/develop"]["state"], "unknown")
        self.assertEqual(self.rows()["task-two/develop"]["state"], "waiting")

    def test_explicit_local_retry_preserves_failure(self):
        self.plan("task-one", self.step())
        run = execution.claim(self.flow, "task-one", "develop")["run"]
        execution.finish(self.flow, run["id"], "fail", [str(self.proof)])
        execution.retry(self.flow, run["id"], str(self.proof))
        next_run = execution.claim(self.flow, "task-one", "develop")
        self.assertTrue(next_run["acquired"])
        self.assertNotEqual(next_run["run"]["id"], run["id"])
        self.assertTrue(execution.state(self.flow)["runs"][run["id"]]["evidence"])

    def test_dependency_alias_is_resolved_by_the_existing_task_owner(self):
        original = self.flow.task
        with patch.object(self.flow, "task", side_effect=lambda key: original({"001-D1": "task-one"}.get(key, key))):
            self.plan("task-one", self.step())
            self.plan("task-two", self.step(needs=[{"step": "001-D1/develop", "reason": "fixed upstream input"}]))
            self.assertEqual(execution.state(self.flow)["plans"]["task-two"]["steps"][0]["needs"][0]["step"], "task-one/develop")
            self.complete("task-one")
            self.assertEqual(self.rows()["task-two/develop"]["state"], "ready")

    def test_changed_dependency_bytes_or_link_changes_the_actual_input_identity(self):
        folder = self.root / "dependencies"
        folder.mkdir()
        (folder / "package-lock.json").write_text("unchanged lock")
        (folder / "file.mjs").write_text("first version")
        first = execution.directory_identity(folder)
        (folder / "file.mjs").write_text("other version")
        self.assertNotEqual(first, execution.directory_identity(folder))
        before = execution.directory_identity(folder)
        (folder / "link.mjs").symlink_to("file.mjs")
        self.assertNotEqual(before, execution.directory_identity(folder))
        (folder / "outside.mjs").symlink_to(self.proof)
        with self.assertRaisesRegex(WorkflowError, "冻结目录"):
            execution.directory_identity(folder)

    def test_unknown_resolution_preserves_the_original_unknown_evidence(self):
        self.plan("task-one", self.step(external=True, resources=["object:one"]))
        run = execution.claim(self.flow, "task-one", "develop")["run"]
        unknown = execution.finish(self.flow, run["id"], "unknown", [str(self.proof)])
        final = execution.finish(self.flow, run["id"], "pass", [str(self.proof)])
        self.assertEqual(final["resolutions"][0]["status"], "unknown")
        self.assertEqual(final["resolutions"][0]["evidence"], unknown["evidence"])

    def test_dependency_cache_is_readonly_until_claim_and_same_mtime_does_not_hide_changes(self):
        installation = self.root / "frozen"
        modules = installation / "node_modules"
        modules.mkdir(parents=True)
        file = modules / "fixture.mjs"
        file.write_text("old bytes")
        prior = file.stat()
        identity = execution.dependency_content(self.flow, modules)
        self.assertFalse(execution.root(self.flow).exists())
        execution.remember_dependencies(self.flow, {"dependencies": str(installation), "dependency_tree": identity})
        with patch.object(execution, "directory_identity", wraps=execution.directory_identity) as rehash:
            self.assertEqual(execution.dependency_content(self.flow, modules), identity)
            rehash.assert_not_called()
            file.write_text("new bytes")
            os.utime(file, ns=(prior.st_atime_ns, prior.st_mtime_ns))
            self.assertNotEqual(execution.dependency_content(self.flow, modules), identity)
            rehash.assert_called_once()

    def test_actual_runner_freezes_source_runs_two_checks_and_keeps_logs(self):
        for key in ("task-one", "task-two"):
            source = self.root / key
            source.mkdir()
            git(source, "init", "--quiet")
            git(source, "config", "user.name", "Synthetic test")
            git(source, "config", "user.email", "test@example.invalid")
            path = source / "tools/dev-workflow/test_synthetic.py"
            path.parent.mkdir(parents=True)
            path.write_text("import time,unittest\nclass Check(unittest.TestCase):\n def test_work(self):\n  time.sleep(0.2)\n")
            git(source, "add", ".")
            git(source, "commit", "--quiet", "-m", "fixture")
            self.plan(key, self.step("checks", recipe="workflow-checks"))
        result = execution.run_ready(self.flow)
        self.assertEqual(len(result["completed"]), 2)
        self.assertTrue(all(r["status"] == "pass" and execution.intact(r) for r in result["completed"]))
        a, b = sorted(result["completed"], key=lambda r: r["started_ns"])
        self.assertLess(b["started_ns"], a["started_ns"] + a["elapsed_seconds"] * 1e9)
        self.assertEqual(execution.run_ready(self.flow)["completed"], [])
        for key in ("task-one", "task-two"):
            self.assertEqual(git_line(self.root / key, "status", "--porcelain"), "")


if __name__ == "__main__":
    unittest.main()
