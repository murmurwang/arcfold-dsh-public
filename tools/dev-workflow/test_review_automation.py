import json
import shutil
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import desktop_review_request as reviewer
import review_queue as queue
from collab import answer, create_ask, granted, load_ask, progress
from common import WorkflowError, digest, read, write
from review_policy import check_balance, execution_approval, key_root, revoke
from review_service import authorize_plan, verify_files, verify_installation
from workflow import Workflow

ORIGINAL_PROFILE = queue.profile

HEAD, BASE = "a" * 40, "b" * 40
REPO = "example/arcfold"
KEY = digest(b"synthetic-credential")
CI = {"id": 1, "attempt": 1, "head": HEAD, "url": "https://example.invalid/checks"}


class AutomationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        repo = Mock()
        repo.name = REPO
        self.flow = Workflow(repo, self.root / "state")
        self.flow.pair = Mock(return_value=({}, HEAD, BASE))
        self.flow.successful_ci = Mock(return_value=CI)
        self.flow.ensure_comment = Mock(return_value={"url": "https://example.invalid/comment"})
        self.flow.advisory_issues = Mock(return_value=[])
        self.flow.new({"id": "sample-change", "title": "示例问题", "authorization_ref": "合成测试",
                       "observed_in_version": "0.5.1", "scope": ["src/"]})
        self.target = {"repo": REPO, "pr": 5, "head": HEAD, "base": BASE, "ci": CI, "decision": "sample-change"}
        self.files = {"src/example.py": "result = 1\n"}
        self.flow.preflight = Mock(side_effect=self.preflight)
        self.installed = {"key_id": KEY, "manifest_sha256": "d" * 64, "install_dir": str(self.root / "installed")}
        patched = patch("review_queue.profile", return_value=self.installed)
        patched.start()
        self.addCleanup(patched.stop)
        self.evidence = self.root / "tariff.json"
        write(self.evidence, {"provider": "lmuai", "model": reviewer.RELAY_MODEL, "verified_by_operator": True,
              "kind": "provider_request_cap", "covers_inflight": True, "maximum_request_usd": "0.50",
              "source": "synthetic provider guarantee", "valid_until": "2099-01-01T00:00:00+00:00"})
        self.calls = []

    def preflight(self, number):
        target = {**self.target, "pr": number}
        directory = self.flow.state / "prs" / str(number) / (HEAD + "-" + BASE)
        return directory, target, self.files, None

    def grant(self, number=5, **changes):
        _, target, files, _ = self.preflight(number)
        packet = reviewer.packet_for(target, files, "lmuai")
        policy = {"version": 1, "provider": "lmuai", "model": reviewer.RELAY_MODEL, "key_id": KEY,
                  "max_requests": 1, "expires_at": "2098-01-01T00:00:00+00:00", "max_cost_usd": "0.80",
                  "cost_bound_usd": "0.50", "bound_evidence": str(self.evidence), "publish": False}
        policy.update(changes)
        ask = create_ask(self.flow, {"kind": "approve", "title": "合成审阅授权", "body": "一次固定材料审阅",
              "task": "sample-change", "binds": {"packet": packet["id"], "files": {str(self.evidence): digest(self.evidence.read_bytes())}},
              "execution": policy})
        answer(self.flow, ask["id"], "yes", "批准这次合成测试")
        return ask

    def enqueue(self, number=5, **changes):
        ask = self.grant(number, **changes)
        return queue.enqueue(self.flow, number, ask["id"], "default")

    def response(self, directory, cost="0.20"):
        packet = read(directory / "request.json")
        evidence = [{"path": "src/example.py", "line": 1, "note": "synthetic evidence"}]
        result = {"packet": packet["id"], "checks": {
            name: {"status": "pass", "summary": "synthetic", "evidence": evidence} for name in reviewer.CHECKS}, "findings": []}
        raw = {"id": "resp_synthetic", "model": reviewer.RELAY_MODEL, "status": "completed",
               "usage": {"input_tokens": 10, "output_tokens": 20},
               "output": [{"type": "message", "role": "assistant",
                           "content": [{"type": "output_text", "text": json.dumps(result)}]}]}
        before = {"requests": 2, "actual_cost_usd": "0.30", "key_limit_usd": "3.50",
                  "key_used_usd": "0.30", "balance_usd": "3.20"}
        after = {"requests": 3, "actual_cost_usd": str(reviewer.Decimal("0.30") + reviewer.Decimal(cost))}
        return {"provider_request_id": "synthetic", "response": raw,
                "billing": {"before": before, "after": after, "actual_cost_usd": cost}}

    def launch(self, installed, directory, mode):
        self.calls.append(mode)
        if mode == "dispatch":
            attempt = read(directory / "attempt.json")
            attempt.update(request_sent=True, phase="sending", billing_before=self.response(directory)["billing"]["before"])
            write(directory / "attempt.json", attempt)
            write(directory / "response.json", self.response(directory))
        elif mode == "observe":
            write(directory / "reconciliation-observation.json", {"requests": 3, "actual_cost_usd": "0.50"})
        else:
            returned = read(directory / "response.json")
            returned["billing"] = self.response(directory)["billing"]
            write(directory / "response.json", returned)

    def test_approved_queue_is_idempotent_and_completes_locally_without_publication(self):
        ask = self.grant()
        job = queue.enqueue(self.flow, 5, ask["id"], "default")
        self.assertEqual(queue.enqueue(self.flow, 5, ask["id"], "default")["id"], job["id"])
        self.assertFalse(list((self.flow.state / "prs").glob("*/*/attempt.json")))
        result = queue.process(self.flow, job["id"], launch=self.launch)
        self.assertEqual((result["status"], result["verdict"], result["actual_cost_usd"]), ("complete", "pass", "0.20"))
        self.assertEqual(result["remaining_usd"], "3.00")
        queue.process(self.flow, job["id"], launch=self.launch)
        self.assertEqual(self.calls, ["dispatch"])
        self.flow.ensure_comment.assert_not_called()
        self.flow.advisory_issues.assert_not_called()
        self.assertEqual(progress(self.flow)["review_queue"][0]["status"], "complete")

    def test_legacy_approval_cannot_be_enqueued(self):
        packet = reviewer.packet_for(self.target, self.files, "lmuai")
        ask = create_ask(self.flow, {"kind": "approve", "title": "旧授权", "body": "人工终端发起", "binds": {"packet": packet["id"]}})
        answer(self.flow, ask["id"], "yes", "批准")
        with self.assertRaisesRegex(WorkflowError, "执行条件"):
            queue.enqueue(self.flow, 5, ask["id"], "default")
        self.assertFalse(list((self.flow.state / "prs").glob("*/*/attempt.json")))

    def test_expired_or_revoked_or_changed_material_never_dispatches(self):
        with self.assertRaisesRegex(WorkflowError, "到期"):
            queue.enqueue(self.flow, 5, self.grant(expires_at="2000-01-01T00:00:00+00:00")["id"], "default")
        job = self.enqueue()
        revoke(self.flow, job["approval"], "撤回本次费用授权")
        result = queue.process(self.flow, job["id"], launch=self.launch)
        self.assertEqual(result["status"], "blocked")
        self.assertFalse(granted(load_ask(self.flow, job["approval"])[1]))
        self.assertEqual(self.calls, [])
        another = self.enqueue(6)
        self.files = {"src/example.py": "result = 2\n"}
        self.assertEqual(queue.process(self.flow, another["id"], launch=self.launch)["status"], "blocked")
        self.assertEqual(self.calls, [])

    def test_requires_verified_bound_not_just_estimate_or_public_starting_price(self):
        with self.assertRaisesRegex(WorkflowError, "低于"):
            self.grant(cost_bound_usd="0.10")
        data = read(self.evidence)
        data["covers_inflight"] = False
        write(self.evidence, data)
        with self.assertRaisesRegex(WorkflowError, "在途"):
            self.grant()
        data.update(kind="verified_tariff", covers_all_charges=True, input_token_ceiling=reviewer.CONTEXT,
                    output_token_ceiling=reviewer.MAX_OUTPUT, input_usd_per_million="0.10",
                    output_usd_per_million="0.20", fixed_usd="0")
        write(self.evidence, data)
        self.grant()
        data["input_token_ceiling"] = 100
        write(self.evidence, data)
        with self.assertRaisesRegex(WorkflowError, "最大输入"):
            self.grant()

    def test_balance_checks_do_not_mix_quota_with_lifetime_usage(self):
        policy = self.grant()["execution"]
        before = {"key_limit_usd": "3.50", "key_used_usd": "3.30", "balance_usd": "0.20",
                  "actual_cost_usd": "3.30", "requests": 2}
        with self.assertRaisesRegex(WorkflowError, "余额不足"):
            check_balance(before, policy)
        before.update(key_used_usd="0.30", balance_usd="3.20", actual_cost_usd="0.30")
        check_balance(before, policy)
        with self.assertRaisesRegex(WorkflowError, "不一致"):
            check_balance({**before, "actual_cost_usd": "0.40"}, policy)
        with self.assertRaisesRegex(WorkflowError, "队列之外"):
            check_balance(before, policy, {**before, "requests": 1})

    def test_unknown_send_blocks_other_prs_and_resume_only_observes_usage(self):
        job, second = self.enqueue(), self.enqueue(6)
        def fail(installed, directory, mode):
            if mode == "dispatch":
                self.calls.append(mode)
                attempt = read(directory / "attempt.json")
                attempt.update(request_sent=True, phase="sending", billing_before=self.response(directory)["billing"]["before"])
                write(directory / "attempt.json", attempt)
                raise TimeoutError()
            self.launch(installed, directory, mode)
        result = queue.process(self.flow, job["id"], launch=fail)
        self.assertEqual(result["status"], "needs_reconciliation")
        self.assertIn("attention_ask", result)
        self.assertEqual(queue.process(self.flow, second["id"], launch=fail)["status"], "queued")
        queue.control(self.flow, job["id"], "resume")
        self.assertEqual(queue.process(self.flow, job["id"], launch=fail)["status"], "needs_reconciliation")
        self.assertEqual(self.calls, ["dispatch", "observe"])
        directory = Path(read(queue.job_path(self.flow, job["id"]))["directory"])
        attempt = read(directory / "attempt.json")
        write(directory / "billing-reconciliation.json", {"client_request_id": attempt["client_request_id"],
              "outcome": "usage_confirmed", "actual_cost_usd": "0.20", "evidence": "synthetic provider item"})
        self.assertEqual(queue.reconcile(self.flow, job["id"])["status"], "settled_without_result")
        self.assertIsNone(read(key_root(self.flow, KEY) / "reservation.json")["job"])
        self.assertEqual(queue.process(self.flow, second["id"], launch=self.launch)["status"], "complete")

    def test_no_send_failure_can_resume_and_retains_original_attempt(self):
        job = self.enqueue()
        with patch("review_queue.invoke", side_effect=WorkflowError("KEYCHAIN_LOCKED")):
            result = queue.process(self.flow, job["id"], launch=lambda *args: (_ for _ in ()).throw(WorkflowError("KEYCHAIN_LOCKED")))
        self.assertEqual(result["status"], "needs_unlock")
        queue.control(self.flow, job["id"], "resume")
        self.assertEqual(queue.process(self.flow, job["id"], launch=self.launch)["status"], "complete")
        directory = Path(read(queue.job_path(self.flow, job["id"]))["directory"])
        self.assertEqual(len(list((directory / "unsent").glob("*.json"))), 1)
        self.assertEqual(self.calls, ["dispatch"])

    def test_delayed_billing_never_sends_the_model_again(self):
        job = self.enqueue()
        def delayed(installed, directory, mode):
            self.launch(installed, directory, mode)
            if mode == "dispatch":
                raw = read(directory / "response.json")
                raw.pop("billing")
                write(directory / "response.json", raw)
                raise TimeoutError()
        self.assertEqual(queue.process(self.flow, job["id"], launch=delayed)["status"], "billing_pending")
        self.assertEqual(queue.process(self.flow, job["id"], launch=delayed)["status"], "complete")
        self.assertEqual(self.calls, ["dispatch", "settle"])

    def test_spending_above_bound_keeps_the_key_reserved(self):
        job, second = self.enqueue(), self.enqueue(6)
        def overspend(installed, directory, mode):
            self.launch(installed, directory, mode)
            write(directory / "response.json", self.response(directory, cost="0.60"))
        self.assertEqual(queue.process(self.flow, job["id"], launch=overspend)["status"], "blocked")
        self.assertEqual(queue.process(self.flow, second["id"], launch=self.launch)["status"], "queued")
        self.assertEqual(self.calls, ["dispatch"])

    def test_cancel_and_pause_do_not_touch_existing_requests(self):
        job = self.enqueue()
        self.assertTrue(queue.pause(self.flow, "default", True)["paused"])
        self.assertEqual(queue.process(self.flow, job["id"], launch=self.launch)["status"], "queued")
        self.assertEqual(self.calls, [])
        queue.pause(self.flow, "default", False)
        self.assertEqual(queue.control(self.flow, job["id"], "cancel")["status"], "cancelled")
        queue.process(self.flow, job["id"], launch=self.launch)
        self.assertEqual(self.calls, [])

    def test_publication_failure_reuses_paid_response(self):
        job = self.enqueue(publish=True)
        self.flow.ensure_comment.side_effect = [WorkflowError("synthetic remote result unknown"),
                                                {"url": "https://example.invalid/comment"}]
        self.assertEqual(queue.process(self.flow, job["id"], launch=self.launch)["status"], "publication_pending")
        self.assertEqual(queue.process(self.flow, job["id"], launch=self.launch)["status"], "complete")
        self.assertEqual(self.calls, ["dispatch"])

    def test_crash_after_raw_response_is_recovered_without_another_send(self):
        job = self.enqueue()
        def crash(installed, directory, mode):
            self.launch(installed, directory, mode)
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            queue.process(self.flow, job["id"], launch=crash)
        self.assertEqual(queue.process(self.flow, job["id"], launch=self.launch)["status"], "complete")
        self.assertEqual(self.calls, ["dispatch"])

    def test_changed_ci_preserves_billing_and_does_not_claim_current_code_passed(self):
        job = self.enqueue()
        self.flow.successful_ci.return_value = {**CI, "attempt": 2}
        result = queue.process(self.flow, job["id"], launch=self.launch)
        self.assertEqual((result["status"], result["actual_cost_usd"]), ("stale", "0.20"))
        self.flow.ensure_comment.assert_not_called()

    def test_install_plan_needs_exact_file_approval(self):
        plan = self.root / "install-plan.json"
        write(plan, {"repo": REPO, "state_root": str(self.flow.state.parents[1]), "action": "install"})
        ask = create_ask(self.flow, {"kind": "approve", "title": "安装程序", "body": "固定计划",
              "binds": {"files": {str(plan): digest(plan.read_bytes())}}})
        with self.assertRaisesRegex(WorkflowError, "有效授权"):
            authorize_plan(self.flow, plan, ask["id"])
        answer(self.flow, ask["id"], "yes", "批准这份计划")
        self.assertEqual(authorize_plan(self.flow, plan, ask["id"])["action"], "install")
        plan.write_text("{}")
        with self.assertRaisesRegex(WorkflowError, "有效授权"):
            authorize_plan(self.flow, plan, ask["id"])

    def test_runtime_hash_rejects_changes_and_symlinks(self):
        runtime = self.root / "runtime"
        runtime.mkdir()
        code = runtime / "worker.py"
        code.write_text("pass\n")
        files = {"worker.py": digest(code.read_bytes())}
        verify_files(runtime, files)
        code.write_text("raise Exception()\n")
        with self.assertRaisesRegex(WorkflowError, "不符"):
            verify_files(runtime, files)
        code.unlink()
        code.symlink_to(self.evidence)
        with self.assertRaises(WorkflowError):
            verify_files(runtime, files)

    def test_changed_entry_can_pause_and_remove_intact_old_installation(self):
        import review_service
        directory = self.root / "old-runtime"
        directory.mkdir()
        (directory / "old.py").write_text("pass\n")
        (directory / "ReviewKeychain").write_bytes(b"synthetic native helper")
        runtime = {"install_dir": str(directory), "python": sys.executable,
                   "python_sha256": digest(Path(sys.executable).read_bytes()), "service": "synthetic.review",
                   "files": {"old.py": digest((directory / "old.py").read_bytes())}}
        write(directory / "runtime.json", runtime)
        write(directory / "credential.json", {"service": runtime["service"], "account": "review", "key_id": KEY})
        installed = {"install_dir": str(directory), "service": runtime["service"], "account": "review",
                     "manifest_sha256": digest((directory / "runtime.json").read_bytes()),
                     "helper_sha256": digest((directory / "ReviewKeychain").read_bytes())}
        write(queue.root(self.flow) / "profiles" / "default.json", installed)
        with self.assertRaisesRegex(WorkflowError, "版本不同"):
            ORIGINAL_PROFILE(self.flow, "default")
        with patch("review_queue.profile", side_effect=ORIGINAL_PROFILE):
            self.assertTrue(queue.pause(self.flow, "default", True)["paused"])
            planned = review_service.removal_plan(self.flow, "default", self.root / "remove.json")
        self.assertEqual(read(planned["plan"])["installation"]["install_dir"], str(directory))

    def test_new_install_refuses_active_old_profile_before_native_enrollment(self):
        import review_service
        profile_path = self.root / "profile.json"
        write(profile_path, {"install_dir": "old", "manifest_sha256": "old", "helper_sha256": "old"})
        plan = {"action": "install", "profile_path": str(profile_path), "install_dir": "new",
                "manifest_sha256": "new", "helper_sha256": "new"}
        with patch("review_service.authorize_plan", return_value=plan), \
             patch("review_service.subprocess.run") as native, self.assertRaisesRegex(WorkflowError, "先按绑定计划移除"):
            review_service.install(self.flow, "synthetic", "A1")
        native.assert_not_called()

    def test_native_worker_refuses_wrong_key_before_any_network(self):
        job = self.enqueue()
        directory = Path(read(queue.job_path(self.flow, job["id"]))["directory"])
        packet = read(directory / "request.json")
        write(directory / "attempt.json", {**reviewer.make_attempt(packet), "key_id": "f" * 64})
        with patch.dict("os.environ", {"ARCFOLD_REVIEW_API_KEY": "synthetic-credential"}), \
                patch("desktop_review_request.relay_get") as network, self.assertRaisesRegex(WorkflowError, "不一致"):
            reviewer.worker(directory)
        network.assert_not_called()

    def test_real_worker_rechecks_revocation_after_connecting_before_post(self):
        job = self.enqueue()
        saved = read(queue.job_path(self.flow, job["id"]))
        directory = Path(saved["directory"])
        packet = read(directory / "request.json")
        queue.reserve(self.flow, saved)
        write(directory / "attempt.json", {**reviewer.make_attempt(packet), "key_id": KEY,
              "execution": saved["execution"], "automation": {
                  "state_root": str(self.flow.state.parents[1]), "approval": saved["approval"],
                  "job": saved["id"], "previous_usage": None}})
        def connect():
            revoke(self.flow, saved["approval"], "在连接阶段撤回")
            return Mock()
        with patch.dict("os.environ", {"ARCFOLD_REVIEW_API_KEY": "synthetic-credential"}), \
                patch("desktop_review_request.relay_preflight", return_value=self.response(directory)["billing"]["before"]), \
                patch("desktop_review_request.connect", side_effect=lambda *args, **kwargs: connect()), \
                patch("desktop_review_request.post") as send, self.assertRaisesRegex(WorkflowError, "撤回"):
            reviewer.worker(directory)
        send.assert_not_called()
        self.assertIs(read(directory / "attempt.json")["request_sent"], False)

    def test_cancel_during_connect_is_observed_before_the_sending_marker(self):
        job = self.enqueue()
        saved = read(queue.job_path(self.flow, job["id"]))
        directory = Path(saved["directory"])
        packet = read(directory / "request.json")
        queue.reserve(self.flow, saved)
        write(directory / "attempt.json", {**reviewer.make_attempt(packet), "key_id": KEY,
              "execution": saved["execution"], "automation": {
                  "state_root": str(self.flow.state.parents[1]), "approval": saved["approval"],
                  "job": saved["id"], "previous_usage": None}})
        def connect(*args, **kwargs):
            queue.control(self.flow, job["id"], "cancel")
            return Mock()
        with patch.dict("os.environ", {"ARCFOLD_REVIEW_API_KEY": "synthetic-credential"}), \
                patch("desktop_review_request.relay_preflight", return_value=self.response(directory)["billing"]["before"]), \
                patch("desktop_review_request.connect", side_effect=connect), \
                patch("desktop_review_request.post") as send, self.assertRaises(WorkflowError):
            reviewer.worker(directory)
        send.assert_not_called()
        self.assertIs(read(directory / "attempt.json")["request_sent"], False)


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("xcrun"), "native helper requires macOS compiler")
class NativeBuildTests(unittest.TestCase):
    def test_native_runtime_compiles_and_refuses_modified_code_without_reading_keychain(self):
        from review_service import prepare
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            repo = Mock()
            repo.name = REPO
            flow = Workflow(repo, folder / "state")
            plan = read(prepare(flow, folder / "bundle")["plan"])
            helper = Path(plan["stage"]) / "ReviewKeychain"
            self.assertEqual(subprocess.run([str(helper), "verify"], capture_output=True).returncode, 0)
            (Path(plan["stage"]) / "review_native_worker.py").write_text("raise SystemExit(0)\n")
            rejected = subprocess.run([str(helper), "verify"], capture_output=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertNotIn(b"synthetic-credential", rejected.stdout + rejected.stderr)


if __name__ == "__main__":
    unittest.main()

