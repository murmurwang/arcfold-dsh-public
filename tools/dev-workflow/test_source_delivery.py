import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from collab import Row, after_merge
from common import WorkflowError, digest, git, git_line, read, write
import source_delivery as sources
from workflow import COMPATIBLE_DSH, Workflow, release_notes
from desktop_review_request import CHECKS, MODEL, TIER, packet_for, validate


class SourceDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.checkout = self.root / "source"
        self.checkout.mkdir()
        git(self.checkout, "init", "--quiet")
        git(self.checkout, "config", "user.name", "Synthetic fixture")
        git(self.checkout, "config", "user.email", "fixture@example.invalid")
        self.repo = Mock()
        self.repo.name = "example/arcfold"
        self.flow = Workflow(self.repo, self.root / "state")
        self.number = 0
        write(self.checkout / "seed.json", {"fixture": True})
        self.commit("seed", None, record=False)
        self.versions("0.5.1")
        self.base = self.commit("old-release", {"version": "0.5.1"})["source"]

    def versions(self, version):
        write(self.checkout / "package.json", {"version": version, "engines": {"dsh": COMPATIBLE_DSH}})
        write(self.checkout / "packages/method-ui/package.json", {"version": version})
        write(self.checkout / "package-lock.json", {"version": version, "packages": {"": {"version": version}}})

    def commit(self, task, release, record=True):
        try:
            parent = git_line(self.checkout, "rev-parse", "HEAD")
        except WorkflowError:
            parent = None
        git(self.checkout, "add", ".")
        git(self.checkout, "commit", "--quiet", "--allow-empty", "-m", task)
        source = git_line(self.checkout, "rev-parse", "HEAD")
        self.number += 1
        row = {"phase": "confirmed", "source": source, "review_sha256": digest(task.encode()),
               "review_comment": "https://example.invalid/review", "confirmed_at": str(self.number),
               "target": {"decision": task, "pr": self.number, "base": parent, "head": source,
                          "tree": git_line(self.checkout, "rev-parse", "HEAD^{tree}"), "release": release}}
        if record:
            self.review_fixture(row)
            write(self.flow.state / "prs" / str(self.number) / "merge-attempt.json", row)
            sources.register_merge(self.flow, row)
        return row

    def review_fixture(self, merge):
        target = merge["target"]
        directory = self.flow.state / "prs" / str(target["pr"]) / (target["head"] + "-" + target["base"])
        packet = packet_for(target, {"fixture.txt": "Synthetic review fixture\n"})
        result = {"packet": packet["id"], "checks": {name: {"status": "pass", "summary": "synthetic only",
                  "evidence": [{"path": "fixture.txt", "line": 1, "note": "synthetic only"}]} for name in CHECKS}, "findings": []}
        response = {"provider_request_id": "req_synthetic", "response": {"id": "resp_synthetic", "model": MODEL,
                    "service_tier": TIER, "status": "completed", "usage": {"input_tokens": 0, "output_tokens": 0},
                    "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": json.dumps(result)}]}]}}
        receipt = {"target": target, "packet": packet["id"], "attempt": "synthetic-attempt", "verdict": "pass",
                   "blocking_checks": [], "review": validate(packet, response)}
        receipt["sha256"] = digest(receipt)
        merge["review_sha256"] = receipt["sha256"]
        for name, value in (("receipt", receipt), ("request", packet), ("response", response),
                            ("attempt", {"packet": packet["id"], "client_request_id": "synthetic-attempt"}),
                            ("comment", {"phase": "confirmed", "url": merge["review_comment"]})):
            write(directory / (name + ".json"), value)

    def source(self, task):
        self.flow.new({"id": task, "title": task, "authorization_ref": "synthetic", "scope": ["src/"],
                       "observed_in_version": "0.5.1"})
        write(self.checkout / "src" / (task + ".json"), {"change": task})
        return self.commit(task, {"kind": "source", "note": task + " change"})

    def test_two_source_deliveries_merge_without_competing_version_bumps(self):
        a, b = self.source("feature-one"), self.source("feature-two")
        result = sources.plan(self.flow, self.checkout, b["source"], self.base)
        self.assertEqual(result["includes"], ["feature-one", "feature-two"])
        self.assertEqual(len(result["history"]), 2)
        self.assertEqual(read(self.checkout / "package.json")["version"], "0.5.1")
        fields = {"fixed_in": "pending", "release_mode": "source", "release_note": "feature two"}
        actual = release_notes(self.checkout, b["source"], a["source"], ["src/feature-two.json"], fields)
        self.assertEqual(actual, {"kind": "source", "note": "feature two"})

    def test_assembly_must_include_every_source_and_keep_unrecorded_commits_visible(self):
        self.source("feature-one")
        b = self.source("feature-two")
        task = {"id": "release-assembly"}
        note = {"release_mode": "assembly", "release_base": self.base, "release_includes": ["feature-one"]}
        with self.assertRaisesRegex(WorkflowError, "完整"):
            sources.check_release(self.flow, self.checkout, task, b["source"], ["package.json"], note, {"version": "0.6.0"})
        note["release_includes"] = ["feature-one", "feature-two"]
        result = sources.check_release(self.flow, self.checkout, task, b["source"], ["package.json"], note, {"version": "0.6.0"})
        self.assertEqual(result["kind"], "assembly")
        with self.assertRaisesRegex(WorkflowError, "功能源码"):
            sources.check_release(self.flow, self.checkout, task, b["source"], ["src/unlisted.mjs"], note, {"version": "0.6.0"})
        unrecorded = self.commit("unrecorded", None, record=False)
        with self.assertRaisesRegex(WorkflowError, "未核对"):
            sources.plan(self.flow, self.checkout, unrecorded["source"], self.base)

    def test_missing_or_changed_merge_proof_never_becomes_release_evidence(self):
        item = self.source("feature-one")
        path = self.flow.state / "prs" / str(item["target"]["pr"]) / "merge-attempt.json"
        for key, value in (("review_sha256", None), ("review_comment", None)):
            broken = {**item, key: value}
            write(path, broken)
            with self.assertRaisesRegex(WorkflowError, "审阅"):
                sources.plan(self.flow, self.checkout, item["source"], self.base)
        broken = {**item, "target": {**item["target"], "tree": "a" * 40}}
        write(path, broken)
        with self.assertRaisesRegex(WorkflowError, "实际文件"):
            sources.plan(self.flow, self.checkout, item["source"], self.base)

    def test_source_cannot_change_version_or_bypass_assembly_with_legacy_release(self):
        source = self.source("feature-one")
        with self.assertRaisesRegex(WorkflowError, "assembly"):
            sources.check_release(self.flow, self.checkout, {"id": "legacy"}, source["source"], [], {}, {"version": "0.6.0"})
        self.versions("0.6.0")
        changed = self.commit("unexpected-version", None, record=False)
        with self.assertRaisesRegex(WorkflowError, "共享发行版本"):
            release_notes(self.checkout, changed["source"], source["source"], ["package.json"],
                          {"fixed_in": "pending", "release_mode": "source", "release_note": "fixture"})

    def test_merge_summary_without_original_review_files_cannot_be_assembled(self):
        item = self.source("feature-one")
        target = item["target"]
        directory = self.flow.state / "prs" / str(target["pr"]) / (target["head"] + "-" + target["base"])
        (directory / "response.json").unlink()
        with self.assertRaisesRegex(WorkflowError, "完整独立审阅"):
            sources.plan(self.flow, self.checkout, item["source"], self.base)

    def test_waiting_release_is_not_closed_and_assembly_has_no_hidden_sources(self):
        source = self.source("feature-one")
        directory = self.flow.state / "tasks/feature-one"
        task = {"id": "feature-one", "title": "feature"}
        result = after_merge(self.flow, directory, source, source["target"]["pr"], Row(task, []))
        self.assertFalse(result["closed"])
        self.assertTrue(result["release_required"])
        plan = sources.plan(self.flow, self.checkout, source["source"], self.base)
        self.versions("0.6.0")
        assembly = self.commit("release-assembly", {"kind": "assembly", "version": "0.6.0", **plan})
        self.assertEqual(sources.pending(self.flow, self.checkout, assembly["source"]), [])
        result = after_merge(self.flow, directory, source, source["target"]["pr"], Row(task, []))
        self.assertEqual(result["version"], "0.6.0")
        self.assertFalse(result["closed"])
        self.assertEqual(result["assembly_pr"], assembly["target"]["pr"])

    def test_version_target_and_includes_are_in_the_decision_not_inferred(self):
        with self.assertRaisesRegex(WorkflowError, "改动说明"):
            sources.headers("release_mode: source\n")
        with self.assertRaisesRegex(WorkflowError, "起点"):
            sources.headers("release_mode: assembly\n")
        header = "release_mode: assembly\nrelease_base: " + self.base + "\nrelease_includes: feature-two,feature-one\n"
        self.assertEqual(sources.headers(header)["release_includes"], ["feature-one", "feature-two"])
