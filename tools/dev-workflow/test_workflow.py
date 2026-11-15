import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from common import WorkflowError, digest, read, write
from desktop_review_request import (
    CHECKS, HOST, RELAY_MODEL, blockers, connect, estimate, make_attempt, maximum_cost, relay_preflight, request,
    review_key, validate, worker,
)
from release import REHEARSAL_CHECKS, verify_isolated, verify_release
from workflow import CI_STEPS, WORKFLOW, Workflow, ci_review_record, compact_lock_evidence, decision_note, inside_scope, scan

HEAD = "a" * 40
BASE = "b" * 40
OTHER = "c" * 40
REPO = "example/arcfold"
CI = {"id": 13, "attempt": 1, "head": HEAD, "url": "https://github.com/example/arcfold/actions/runs/13"}


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Mock()
        self.repo.name = REPO
        self.repo.main.return_value = BASE
        self.repo.pr.return_value = {"state": "open", "head": {"sha": HEAD},
                                     "base": {"sha": BASE, "ref": "main", "repo": {"full_name": REPO}}}
        self.flow = Workflow(self.repo, self.temp.name)

    def new(self):
        return self.flow.new({"id": "simple-change", "title": "体验文字", "authorization_ref": "用户提出换行问题", "scope": ["src/"],
                              "observed_in_version": "0.4.0"})

    @patch.dict("os.environ", {"ARCFOLD_AGENT_ID": "other-agent", "CODEX_THREAD_ID": ""})
    def test_missing_decision_blocks_even_with_registered_contributor(self):
        self.new()
        with self.assertRaisesRegex(WorkflowError, "Problem"):
            self.flow.start("simple-change")
        self.repo.main.assert_not_called()
        self.repo.fetch.assert_not_called()

    def test_decision_requires_actual_fields_and_ignores_hidden_text(self):
        sample = Path(self.new()["decision"])
        filled = sample.read_text().replace("[TBD]", "要检查的行为")
        fields = decision_note(filled.encode())
        self.assertEqual(fields["observed_in_version"], "0.4.0")
        self.assertEqual(fields["criteria"], ["要检查的行为"])
        with self.assertRaises(WorkflowError):
            decision_note(filled.replace("## Problem", "<!-- ## Problem -->").encode())

    def test_scope_and_secret(self):
        self.assertTrue(inside_scope("src/real.mjs", ["src/"]))
        self.assertFalse(inside_scope("src-copy/real.mjs", ["src/"]))
        with self.assertRaisesRegex(WorkflowError, "密钥"):
            scan("prod.mjs", b"let x = '" + b"sk-" + b"x" * 24 + b"'")
        with self.assertRaisesRegex(WorkflowError, "本机"):
            scan("prod.mjs", b"/" + b"Users" + b"/example/app")

    def test_ci_needs_exact_head_run_steps(self):
        steps = [{"name": name, "conclusion": "success"} for name in
                 ("核对检查使用的提交", "在独立副本运行 Desktop 模拟检查", "运行工作流检查")]
        run = {"head_sha": HEAD, "event": "pull_request", "path": WORKFLOW, "status": "completed", "conclusion": "success",
               "id": 13, "run_attempt": 1, "html_url": CI["url"]}
        jobs = {"jobs": [{"name": "Desktop checks", "conclusion": "success", "steps": steps}]}
        self.repo.api.side_effect = [
            {"workflow_runs": [{**run, "head_sha": OTHER}]}, {"workflow_runs": [{**run, "conclusion": "failure"}]},
            {"workflow_runs": [run]}, jobs,
        ]
        for _ in range(2):
            with self.assertRaisesRegex(WorkflowError, "尚未通过"):
                self.flow.successful_ci(HEAD)
        self.assertEqual(self.flow.successful_ci(HEAD), CI)

    def test_review_ci_record_includes_outcomes_only_from_the_required_steps(self):
        job = {"id": 20, "name": "Desktop checks", "conclusion": "success", "html_url": CI["url"] + "/job/20",
               "steps": [{"name": name, "conclusion": "success"} for name in CI_STEPS]}
        desktop, workflow = CI_STEPS[1:]
        lines = [
            ("Desktop checks", desktop, "✔ packaged description (2.4ms)"),
            ("Desktop checks", desktop, "ℹ skipped 1"),
            ("Desktop checks", desktop, "ignored debug output"),
            ("Another job", desktop, "✔ separate task (1ms)"),
            ("Desktop checks", workflow, "test_note (test_workflow.WorkflowTests.test_note) ... ok"),
            ("Desktop checks", workflow, "Ran 1 test in 0.007s"),
        ]
        log = "\n".join(f"{name}\t{step}\t2026-11-15T10:00:00Z {line}" for name, step, line in lines)
        actual = ci_review_record(CI, job, log)
        self.assertEqual(actual["run"], CI)
        self.assertEqual(actual["steps"], {name: "success" for name in CI_STEPS})
        self.assertEqual(actual["desktop_results"], [row[2] for row in lines[:2]])
        self.assertEqual(actual["workflow_results"], [row[2] for row in lines[-2:]])

    def test_review_lock_record_has_a_comparison_for_each_unchanged_dependency(self):
        entries = {"node_modules/outer": {"version": "1.0.0", "integrity": "sha512-outer"},
                   "node_modules/outer/node_modules/inner": {"version": "2.0.0", "integrity": "sha512-inner"}}
        old = json.dumps({"packages": {"": {"version": "0.4.0"}, **entries}}).encode()
        new = json.dumps({"packages": {"": {"version": "0.4.1"}, **entries}}).encode()
        files = compact_lock_evidence(old, new)
        summary = json.loads(files["review/lock-summary.json"])
        self.assertEqual(summary["entries_compared"], 2)
        self.assertEqual((summary["base_sha256"], summary["sha256"]), (digest(old), digest(new)))
        rows = [line.split("\t") for line in files["review/lock-entry-comparison.tsv"].splitlines()[1:]]
        self.assertEqual(rows, [[name, entry["version"], entry["integrity"], digest(entry), digest(entry)]
                                for name, entry in entries.items()])
        self.assertEqual(compact_lock_evidence(old, new.replace(b"sha512-inner", b"sha512-other")), {})

    def test_base_advancing_refuses_pair(self):
        self.repo.main.return_value = OTHER
        with self.assertRaisesRegex(WorkflowError, "main 已前进"):
            self.flow.pair(10)

    def test_review_decline_before_any_model_when_ci_fails(self):
        self.repo.api.return_value = {"workflow_runs": []}
        with patch("workflow.command") as launch, self.assertRaisesRegex(WorkflowError, "尚未通过"):
            self.flow.review(10, "ignored")
        launch.assert_not_called()

    def test_review_connects_through_https_proxy_before_sending_any_body(self):
        with patch("desktop_review_request.getproxies", return_value={"https": "http://localhost:8123"}), \
                patch("desktop_review_request.proxy_bypass", return_value=False), \
                patch("desktop_review_request.http.client.HTTPSConnection") as https:
            connection = connect()
        https.assert_called_once_with("localhost", 8123, timeout=15)
        connection.set_tunnel.assert_called_once_with(HOST, port=443, headers={})
        connection.connect.assert_called_once()
        connection.request.assert_not_called()

    @patch.dict("os.environ", {"ARCFOLD_REVIEW_API_KEY": "sk-" + "fake-review"})
    def test_review_transport_failure_before_send_is_recorded(self):
        directory = Path(self.temp.name)
        packet = {"id": "synthetic", "files": {}}
        write(directory / "request.json", packet)
        write(directory / "attempt.json", make_attempt(packet))
        with patch("desktop_review_request.connect", side_effect=TimeoutError), \
                patch("desktop_review_request.post") as send, self.assertRaises(TimeoutError):
            worker(directory)
        send.assert_not_called()
        recorded = read(directory / "attempt.json")
        self.assertEqual(recorded["phase"], "not-sent")
        self.assertIs(recorded["request_sent"], False)

    def test_relay_request_binds_model_service_and_requires_provider_limit(self):
        packet = {"id": "synthetic", "provider": "lmuai", "files": {"src/sample.mjs": "first\nsecond\n"}}
        self.assertEqual(request(packet)["model"], RELAY_MODEL)
        sent = json.loads(request(packet)["input"][0]["content"])
        self.assertEqual(sent["files"]["src/sample.mjs"], "1\tfirst\n2\tsecond")
        self.assertNotIn("service_tier", request(packet))
        self.assertFalse(request(packet)["store"])
        self.assertEqual(estimate(packet)["estimate_basis"], "public_starting_price")
        models = {"data": [{"id": RELAY_MODEL}]}
        uncapped = {"is_active": True, "balance": 30, "unit": "USD"}
        with patch("desktop_review_request.relay_get", side_effect=[models, uncapped]), \
                patch("desktop_review_request.relay_usage") as usage, self.assertRaisesRegex(WorkflowError, "总额度"):
            relay_preflight("synthetic")
        usage.assert_not_called()

    def test_relay_can_use_an_opaque_key_and_rejects_header_injection(self):
        sample = "synthetic-relay-credential"
        with patch.dict("os.environ", {"ARCFOLD_REVIEW_API_KEY": sample}):
            self.assertEqual(review_key("lmuai"), sample)
            with self.assertRaisesRegex(WorkflowError, "密钥"):
                review_key("openai")
        with patch.dict("os.environ", {"ARCFOLD_REVIEW_API_KEY": sample + "\r\nHeader: injected"}), \
                self.assertRaisesRegex(WorkflowError, "密钥"):
            review_key("lmuai")

    def test_relay_receipt_is_bound_to_actual_deducted_usage(self):
        evidence = [{"path": "src/file.mjs", "line": 1, "note": "Synthetic check"}]
        packet = {"id": "relay", "provider": "lmuai", "files": {"src/file.mjs": "export const check = true;\n"}}
        verdict = {"packet": "relay", "checks": {
            name: {"status": "pass", "summary": "Covered", "evidence": evidence} for name in CHECKS
        }, "findings": []}
        raw = {"id": "resp_synthetic", "model": RELAY_MODEL, "status": "completed",
               "usage": {"input_tokens": 42, "output_tokens": 20},
               "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": json.dumps(verdict)}]}]}
        response = {"provider_request_id": "synthetic", "response": raw}
        with self.assertRaisesRegex(WorkflowError, "用量"):
            validate(packet, response)
        response["billing"] = {"before": {"requests": 1, "actual_cost_usd": "0.01", "key_limit_usd": "3.50"},
                               "after": {"requests": 2, "actual_cost_usd": "0.07"}, "actual_cost_usd": "0.06"}
        self.assertEqual(validate(packet, response)["billing"]["actual_cost_usd"], "0.06")

    def test_changing_head_cannot_skip_an_unknown_review_attempt(self):
        directory = self.flow.state / "prs" / "10"
        old = directory / HEAD
        pending = {"phase": "sending", "client_request_id": "one", "started_at": "earlier"}
        write(old / "attempt.json", pending)
        self.assertEqual(self.flow.previous_review_uncertainty(directory / OTHER),
                         [{"request": "one", "started_at": "earlier"}])
        write(old / "billing-reconciliation.json", {
            "client_request_id": "one", "outcome": "no_usage", "evidence": "synthetic provider usage history",
        })
        self.assertEqual(self.flow.previous_review_uncertainty(directory / OTHER), [])

    def test_self_written_result_or_changed_head_cannot_merge(self):
        directory = self.flow.state / "prs" / "10" / (HEAD + "-" + BASE)
        write(directory / "receipt.json", {"verdict": "pass", "reviewer": "someone else"})
        with self.assertRaisesRegex(WorkflowError, "独立审阅"):
            self.flow.merge(10)
        self.repo.pr.return_value["head"]["sha"] = OTHER
        with self.assertRaisesRegex(WorkflowError, "独立审阅"):
            self.flow.merge(10)
        self.repo.gh.assert_not_called()

    def test_unknown_merge_is_checked_and_never_retried(self):
        write(self.flow.state / "prs" / "10" / "merge-attempt.json", {"phase": "merging"})
        with self.assertRaisesRegex(WorkflowError, "结果未知"):
            self.flow.merge(10)
        self.repo.pr.assert_called_once_with(10)
        self.repo.gh.assert_not_called()

    def test_merge_uses_matched_head_then_checks_squash_tree(self):
        open_pr = {**self.repo.pr.return_value, "draft": False}
        merged = {**open_pr, "merge_commit_sha": OTHER, "merged": True}
        target = {"head": HEAD, "base": BASE, "tree": "tree", "ci": CI, "release": None}
        self.repo.pr.side_effect = [open_pr, open_pr, open_pr, merged]
        self.repo.main.side_effect = [BASE, BASE, OTHER]
        self.repo.commit.return_value = {"tree": {"sha": "tree"}, "parents": [{"sha": BASE}]}
        with patch.object(self.flow, "verify_receipt", return_value=({"target": target, "sha256": "receipt"}, {"url": "comment"})), \
                patch.object(self.flow, "successful_ci", return_value=CI):
            result = self.flow.merge(10)
        self.repo.gh.assert_called_once_with("pr", "merge", "10", "--repo", REPO, "--squash", "--match-head-commit", HEAD)
        self.assertEqual(result["source"], OTHER)

    def test_expense_and_evidence_checked_and_advisory_nonblocking(self):
        evidence = [{"path": "src/file.mjs", "line": 1, "note": "Synthetic check"}]
        result = {"packet": "one", "checks": {
            name: {"status": "pass", "summary": "Covered", "evidence": evidence} for name in CHECKS
        }, "findings": [{"impact": "advisory", "title": "Small issue", "description": "Observation", "evidence": evidence}]}
        packet = {"id": "one", "files": {"src/file.mjs": "export const answer = true;\n"}}
        raw = {"id": "resp_example", "model": "gpt-5.4-2026-03-05", "status": "completed", "service_tier": "flex",
               "usage": {"input_tokens": 500, "output_tokens": 25},
               "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": json.dumps(result)}]}]}
        response = {"provider_request_id": "req_example", "response": raw}
        self.assertFalse(blockers(validate(packet, response)["result"]))
        self.assertLess(maximum_cost(), 3.50)
        self.assertEqual(estimate(packet)["tier"], "flex")
        result["checks"]["data"]["status"] = "unknown"
        self.assertIn("data", blockers(result))
        evidence[0]["line"] = 99
        raw["output"][0]["content"][0]["text"] = json.dumps(result)
        with self.assertRaisesRegex(WorkflowError, "无法定位"):
            validate(packet, response)

    def test_releases_require_same_archives_and_real_rehearsal_versions(self):
        directory = Path(self.temp.name)
        release = {"source": HEAD, "version": "0.4.0", "reproduced": True, "engines_dsh": "0.2.2-rc.1",
                   "packages": [{"file": name + ".tgz", "sha256": digest(name.encode()), "name": "@arcfold/" + name}
                                for name in ("dsh", "dsh-method-ui")]}
        for row in release["packages"]:
            (directory / row["file"]).write_bytes(row["name"].split("/")[1].encode())
        for name, key in (("build-manifest.json", "build_manifest_sha256"), ("npm-dry-run.json", "npm_dry_run_sha256"),
                          ("dependency-lock.json", "dependency_lock_sha256")):
            (directory / name).write_bytes(b"{}")
            release[key] = digest(b"{}")
        verify_release(directory, release)
        path = directory / "test-result.json"
        proof = {"source": HEAD, "account": "arcfold-test", "host": "0.2.2-rc.1", "newer": "0.4.0",
                 "packages": {row["name"]: row["sha256"] for row in release["packages"]},
                 "checks": {name: {"status": "pass", "evidence": "test.json"} for name in REHEARSAL_CHECKS}}
        write(path, proof)
        verify_isolated(path, release)
        proof["checks"]["github_source_version_section"] = {"status": "unknown", "evidence": None}
        write(path, proof)
        verify_isolated(path, release)
        proof["checks"]["restart_readback"]["status"] = "unknown"
        write(path, proof)
        with self.assertRaisesRegex(WorkflowError, "restart_readback"):
            verify_isolated(path, release)
        (directory / "dsh.tgz").write_bytes(b"different")
        with self.assertRaisesRegex(WorkflowError, "安装包"):
            verify_release(directory, release)


if __name__ == "__main__":
    unittest.main()
