"""Behavioral probes for numbering, evidence boundaries and legacy migration."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import collab
import delivery
import delivery_feedback as feedback
from common import WorkflowError, digest, git, git_line, locked, read, write
from desktop_review_request import CHECKS, RELAY_MODEL, packet_for
from workflow import HERE, Workflow

HEAD, BASE = "a" * 40, "b" * 40


def snapshot(path):
    return {str(p.relative_to(path)): (p.read_bytes(), p.stat().st_mtime_ns)
            for p in path.rglob("*") if p.is_file()}


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = Mock(name="repository")
        self.repo.name = "example/arcfold"
        self.flow = Workflow(self.repo, self.root / "state")
        env = patch.dict(os.environ, {"ARCFOLD_AGENT_ID": "fixture-agent", "ARCFOLD_DAILY_PROFILE": str(self.root / "absent")})
        env.start()
        self.addCleanup(env.stop)

    def register(self):
        result = self.flow.new({"title": "编号场景", "authorization_ref": "synthetic scenario", "scope": ["tools/"],
                                "observed_in_version": "dev fixture"})
        path = Path(result["decision"])
        path.write_text(path.read_text().replace("[TBD]", "具体行为"))
        return result

    def legacy(self):
        folder = self.flow.state / "tasks" / "old-task"
        body = (HERE / "decision-template.md").read_text().format(title="旧任务", observed="0.4.1", source="legacy fixture")
        body = body.replace("[TBD]", "旧的具体行为")
        write(folder / "task.json", {"id": "old-task", "title": "旧任务", "phase": "draft", "scope": ["tools/"],
                                     "repository": self.repo.name, "created_at": "2020-01-01T00:00:00Z"})
        write(folder / "decision.md", body.encode())
        write(folder / "alignment.json", {"decision_sha256": digest(body.encode()), "text": "原决策对齐", "at": "old"})
        ask = {"id": "A4", "kind": "approve", "title": "旧审阅授权", "body": "只批准旧材料", "task": "old-task",
               "binds": {"packet": "a" * 64}, "steps": [], "replies": ["批准 A4"], "status": "answered",
               "answers": [{"verdict": "yes", "text": "批准 A4"}], "created_at": "old"}
        write(self.flow.state / "asks" / "A4.json", ask)
        write(self.flow.state / "feedback" / "F8" / "feedback.json",
              {"id": "F8", "text": "旧原话", "at": "old", "attachments": [], "routes": [{"to": "new:old-task", "at": "old"}],
               "daily": {"packages": {"@arcfold/dsh": "0.4.1"}}})
        return folder

    def test_three_feedback_sequences_continue_old_global_numbers_without_rewriting_words(self):
        self.legacy()
        self.register()
        words = "  具体原话\n第二行  \n"
        one = feedback.record(self.flow, words)
        two = feedback.record(self.flow, "入口建议", target="dev", subject="next", context="查看未归类反馈")
        three = feedback.record(self.flow, "本次入口验收", total="001", target="dev")
        self.assertEqual([one["id"], two["id"], three["id"]], ["F9", "dev-F1", "001-F1"])
        self.assertEqual(one["text"], words)
        self.assertEqual(one["author"], "开发者")
        self.assertEqual(one["recorded_by"], "fixture-agent")
        self.assertIn("commit", two["version"])
        self.assertIn("files", two["version"])
        self.assertEqual(two["daily"]["packages"]["@arcfold/dsh"], "unknown")

    def test_counter_grows_beyond_999_and_never_recycles_a_failed_reservation(self):
        write(self.flow.state / "numbering.json", {"sequences": {"": 999}, "reservations": {}})
        original = delivery.write
        def fail_material(path, content):
            if Path(path).name == "delivery.json":
                raise OSError("synthetic disk failure")
            return original(path, content)
        with patch("delivery.write", side_effect=fail_material), self.assertRaises(OSError):
            self.register()
        following = self.register()
        self.assertEqual(following["id"], "1001")
        self.assertIn("1000", [r["id"] for r in delivery.reservations(self.flow)])
        self.assertIn("1000", [r["id"] for r in collab.progress(self.flow)["incomplete_records"]])

    def test_parallel_processes_never_allocate_the_same_number(self):
        code = ("from common import Repository,WorkflowError; from workflow import Workflow; import delivery,sys; "
                "f=Workflow(Repository('example/arcfold'),sys.argv[1]); "
                "print(delivery.allocate(f,'F'))")
        env = {**os.environ, "PYTHONPATH": str(HERE), "PYTHONDONTWRITEBYTECODE": "1"}
        workers = [subprocess.Popen([sys.executable, "-B", "-c", code, str(self.root / "state")],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env) for _ in range(8)]
        assigned = []
        for worker in workers:
            out, err = worker.communicate(timeout=20)
            if worker.returncode == 0:
                assigned.append(out.decode().strip())
            else:
                self.assertIn("另一流程", err.decode())
        self.assertTrue(assigned)
        self.assertEqual(len(assigned), len(set(assigned)))
        self.assertEqual(int(delivery.allocate(self.flow, "F")[1:]), len(assigned) + 1)

    def test_links_classification_and_corrections_preserve_original_feedback_and_pending_status(self):
        self.register()
        self.register()
        item = feedback.record(self.flow, "保持这段原话")
        original = (self.flow.state / "feedback" / "F1" / "feedback.json").read_bytes()
        feedback.route(self.flow, "F1", "new:001")
        feedback.link(self.flow, "F1", "002", "context", "发生场景")
        feedback.classify(self.flow, "F1", "dev", "核查为入口的进度问题")
        self.assertEqual(feedback.load(self.flow, "F1")[1]["version"]["commit"], "unknown")
        self.assertEqual(delivery.show(self.flow, "dev")["feedback"][0]["id"], "F1")
        self.assertEqual(delivery.show(self.flow, "001")["pending"]["feedback"], ["F1"])
        self.assertEqual(delivery.show(self.flow, "002")["materials"]["F"][0]["id"], "F1")
        feedback.link(self.flow, "F1", "001", "source", "纠正误关联", remove=True)
        self.assertEqual(delivery.show(self.flow, "001")["materials"]["F"], [])
        corrected = feedback.record(self.flow, "原提供者的更正", target="dev", corrects=item["id"])
        self.assertEqual(corrected["id"], "F2")
        self.assertEqual(corrected["corrects"], "F1")
        self.assertEqual(delivery.show(self.flow, "F1")["corrections"], ["F2"])
        self.assertEqual([f["id"] for f in delivery.show(self.flow, "002")["materials"]["F"]], ["F1", "F2"])
        self.assertEqual((self.flow.state / "feedback" / "F1" / "feedback.json").read_bytes(), original)
        self.assertEqual([r["id"] for r in collab.progress(self.flow)["feedback"]], ["F1", "F2"])

    def test_unbound_record_only_feedback_remains_discoverable_in_overview(self):
        feedback.record(self.flow, "暂存意见", target="dev")
        feedback.route(self.flow, "dev-F1", "note", "本轮只记录")
        overview = collab.progress(self.flow)
        self.assertEqual(overview["feedback"], [])
        self.assertEqual(overview["unassigned_feedback"][0]["id"], "dev-F1")
        self.assertEqual(overview["dev_feedback"][0]["status"], "record-only")
        rendered = collab.render(overview)
        self.assertIn("尚未关联交付的反馈", rendered)
        self.assertIn("dev-F1 · record-only", rendered)

    def test_record_only_feedback_returns_to_pending_when_linked_or_routed(self):
        registered = self.register()
        for relation in delivery.RELATIONS:
            with self.subTest(relation=relation):
                row = feedback.record(self.flow, "deferred feedback")
                original = snapshot(self.flow.state / "feedback" / row["id"])
                feedback.route(self.flow, row["id"], "note", "deferred")
                linked = feedback.link(self.flow, row["id"], "001", relation, "follow up")
                self.assertEqual(linked["status"], "pending")
                self.assertIn(row["id"], delivery.show(self.flow, "001")["pending"]["feedback"])
                self.assertIn(row["id"], [r["id"] for r in collab.progress(self.flow)["feedback"]])
                self.assertEqual(snapshot(self.flow.state / "feedback" / row["id"])["feedback.json"],
                                 original["feedback.json"])
                self.assertTrue(any(e.get("status") == "record-only" for e in linked["history"]))
                feedback.resolved(self.flow, row["id"], "synthetic acceptance", "pass")
                self.assertEqual(feedback.link(self.flow, row["id"], "001", relation, "add evidence")["status"], "resolved")
        for target in ["issue:17", "new:" + registered["task"], "close-loop:" + registered["task"]]:
            with self.subTest(route=target):
                row = feedback.record(self.flow, "deferred route")
                feedback.route(self.flow, row["id"], "note", "deferred")
                self.assertEqual(feedback.route(self.flow, row["id"], target)["status"], "pending")

    def test_new_from_dev_feedback_uses_dev_source_instead_of_daily_package(self):
        item = feedback.record(self.flow, "入口输出不对", target="dev", version={"commit": "unknown", "reason": "未保留现场"})
        result = collab.new_from_feedback(self.flow, {"title": "修复入口输出", "scope": ["tools/"]}, item["id"])
        body = Path(result["decision"]).read_text()
        self.assertIn("observed_in_version: dev unknown；未保留现场", body)
        self.assertEqual(delivery.show(self.flow, result["id"])["materials"]["F"][0]["id"], "dev-F1")

    def test_unconfirmed_draft_can_change_but_confirmed_decision_needs_new_id_and_confirmation(self):
        first = self.register()
        body = Path(first["decision"]).read_bytes().replace("具体行为".encode(), "修改草稿".encode())
        result = delivery.revise(self.flow, "001", body)
        self.assertEqual(result["decision_id"], "001-D1")
        collab.align(self.flow, "001", "这一份已对齐")
        confirmed = delivery.show(self.flow, "001-D1")
        changed = body.replace("修改草稿".encode(), "新增边界".encode())
        second = delivery.revise(self.flow, "001", changed)
        self.assertEqual(second["decision_id"], "001-D2")
        self.assertEqual(delivery.show(self.flow, "001-D1")["confirmation"], confirmed["confirmation"])
        with self.assertRaisesRegex(WorkflowError, "对齐"):
            self.flow.start("001")
        self.assertEqual(collab.progress(self.flow)["tasks"][0]["id"], "001")
        self.assertEqual(len(collab.progress(self.flow)["tasks"]), 1)
        self.repo.fetch.assert_not_called()

    def test_same_decision_reopen_preserves_execution_and_reuses_only_matching_confirmation(self):
        first = self.register()
        collab.align(self.flow, "001", "按此开发")
        original = snapshot(self.flow.state / "tasks")
        second = delivery.revise(self.flow, "001", Path(first["decision"]).read_bytes(), restart_reason="相同方案重新执行")
        self.assertEqual(second["decision_id"], "001-D1")
        self.assertNotEqual(first["task"], second["task"])
        for key, value in original.items():
            self.assertEqual(snapshot(self.flow.state / "tasks")[key], value)
        self.assertEqual(len(delivery.show(self.flow, "001")["executions"]), 2)
        with self.assertRaisesRegex(WorkflowError, "取代"):
            delivery.ensure_current(self.flow, self.flow.task(first["task"])[1])

    def test_requests_require_delivery_keep_step_answers_and_do_not_transfer_superseded_grants(self):
        self.register()
        with self.assertRaisesRegex(WorkflowError, "所属交付"):
            collab.create_ask(self.flow, {"kind": "act", "title": "操作", "body": "后果"})
        one = collab.create_ask(self.flow, {"delivery": "001", "kind": "approve", "title": "旧材料", "body": "费用",
                                          "binds": {"packet": "a" * 64}})
        collab.answer(self.flow, one["id"], "yes", "批准 001-A1")
        two = collab.create_ask(self.flow, {"delivery": "001", "kind": "approve", "title": "新材料", "body": "费用变化",
                                          "binds": {"packet": "b" * 64}, "supersedes": one["id"]})
        self.assertEqual(two["id"], "001-A2")
        self.assertEqual(two["answers"], [])
        old = delivery.show(self.flow, "001-A1")
        self.assertEqual(old["answers"][0]["text"], "批准 001-A1")
        self.assertFalse(collab.granted(old))
        three = collab.create_ask(self.flow, {"delivery": "001", "kind": "act", "title": "两步操作", "body": "按步骤操作",
                                            "steps": ["第一步", "第二步"]})
        collab.answer(self.flow, three["id"], "yes", "第一步完成", 1)
        self.assertEqual(delivery.show(self.flow, three["id"])["status"], "open")
        self.assertEqual(len(delivery.show(self.flow, "001")["materials"]["A"]), 3)
        collab.cancel_ask(self.flow, three["id"], "后续步骤撤销")
        cancelled = delivery.show(self.flow, three["id"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["answers"][0]["text"], "第一步完成")

    def test_reference_another_delivery_does_not_grant_a_different_packet(self):
        self.register()
        self.register()
        ask = collab.create_ask(self.flow, {"delivery": "001", "kind": "approve", "title": "一次审阅", "body": "指定材料",
                                          "binds": {"packet": "a" * 64}})
        collab.answer(self.flow, ask["id"], "yes", "批准 001-A1")
        delivery.reference(self.flow, "002", ask["id"], "reference", "仅作来源")
        with self.assertRaisesRegex(WorkflowError, "另一份"):
            collab.review_approval(self.flow, ask["id"], 3, "b" * 64, {})

    def test_review_preview_is_stable_and_new_request_cannot_hide_unknown_cost(self):
        self.register()
        target = {"repo": self.repo.name, "pr": 5, "head": HEAD, "base": BASE,
                  "delivery": "001", "decision": "delivery-001", "decision_id": "001-D1"}
        pair = self.flow.state / "prs" / "5" / (HEAD + "-" + BASE)
        with patch.object(self.flow, "preflight", return_value=(pair, target, {"src/a.mjs": "export {};\n"}, None)), \
                patch("workflow.command") as run:
            with locked(delivery.root(self.flow, "001"), "review"), self.assertRaisesRegex(WorkflowError, "另一流程"):
                self.flow.review(5)
            self.assertEqual(len(delivery.reviews(self.flow, "001")), 0)
            first = self.flow.review(5)
            again = self.flow.review(5)
            self.assertEqual(first["review_id"], "001-R1")
            self.assertEqual(first["packet"], again["packet"])
            run.assert_not_called()
            folder = Path(first["material"]).parent
            write(folder / "attempt.json", {"client_request_id": "pending", "provider": "lmuai", "started_at": "now"})
            with self.assertRaisesRegex(WorkflowError, "未知"):
                self.flow.review(5, new_attempt=True)
            self.assertEqual(len(delivery.reviews(self.flow, "001")), 1)
            other_target = {**target, "pr": 6}
            other_pair = self.flow.state / "prs" / "6" / (HEAD + "-" + BASE)
            with patch.object(self.flow, "preflight", return_value=(other_pair, other_target, {"src/a.mjs": "export {};\n"}, None)), \
                    self.assertRaisesRegex(WorkflowError, "未知"):
                self.flow.review(6)
            self.assertEqual(len(delivery.reviews(self.flow, "001")), 1)
            write(folder / "response.json", {"response": {"usage": {"input_tokens": 10, "output_tokens": 2}}, "billing": {}})
            with self.assertRaisesRegex(WorkflowError, "费用未知"):
                self.flow.review(5, new_attempt=True)
            write(folder / "billing-reconciliation.json", {"client_request_id": "pending", "outcome": "usage_confirmed", "evidence": "usage exists but cost is unknown"})
            with self.assertRaisesRegex(WorkflowError, "费用未知"):
                self.flow.review(5, new_attempt=True)
            write(folder / "billing-reconciliation.json", {"client_request_id": "pending", "outcome": "no_usage", "evidence": "synthetic reconciliation"})
            with self.assertRaisesRegex(WorkflowError, "未知"):
                self.flow.review(5, new_attempt=True)
            write(folder / "result-reconciliation.json", {
                "client_request_id": "pending", "outcome": "invalid_response", "reason": "response has no report",
                "evidence": ["synthetic response evidence"], "at": "now", "recorded_by": "fixture-agent",
            })
            self.assertEqual(delivery.show(self.flow, "001-R1")["status"], "failed")
            self.assertIsNone(delivery.show(self.flow, "001-R1")["conclusion"])
            second = self.flow.review(5, new_attempt=True)
            self.assertEqual(second["review_id"], "001-R2")
            self.assertEqual(delivery.review_directory(self.flow, 5, HEAD, BASE), Path(second["material"]).parent)
            self.assertEqual(delivery.show(self.flow, "001-R2")["conclusion"], None)
            run.assert_not_called()

    def test_a_local_pass_label_is_not_an_independent_conclusion(self):
        self.register()
        target = {"repo": self.repo.name, "pr": 5, "head": HEAD, "base": BASE, "delivery": "001", "decision_id": "001-D1"}
        pair = self.flow.state / "prs" / "5" / (HEAD + "-" + BASE)
        folder, _ = delivery.prepare_review(self.flow, pair, target, packet_for(target, {"file": "test"}))
        write(folder / "receipt.json", {"verdict": "pass", "review": {}, "sha256": "fake"})
        report = delivery.show(self.flow, "001-R1")
        self.assertEqual(report["status"], "unconfirmed")
        self.assertIsNone(report["conclusion"])

    def test_migration_is_read_only_until_checked_and_preserves_old_files_authority_and_feedback(self):
        folder = self.legacy()
        before = snapshot(self.flow.state)
        plan = delivery.migration_preview(self.flow)
        self.assertEqual(snapshot(self.flow.state), before)
        self.assertEqual(plan["tasks"][0]["asks"], {"A4": "001-A1"})
        delivery.migrate(self.flow, plan, "归属对照已核对")
        after = snapshot(self.flow.state)
        for key, value in before.items():
            self.assertEqual(after[key], value)
        self.assertEqual(delivery.show(self.flow, "001")["materials"]["F"][0]["id"], "F8")
        self.assertEqual(delivery.show(self.flow, "001-A1")["binds"], delivery.show(self.flow, "A4")["binds"])
        with self.assertRaisesRegex(WorkflowError, "另一份"):
            collab.review_approval(self.flow, "001-A1", 5, "b" * 64, {})
        self.assertTrue(delivery.migrate(self.flow, plan, "同一对照再次读取")["already_applied"])
        write(folder / "observations" / "actual.json", {"feedback": "F8", "outcome": "pass", "at": "actual"})
        self.assertEqual(feedback.load(self.flow, "F8")[1]["status"], "resolved")
        self.assertEqual(collab.progress(self.flow)["feedback"], [])

    def test_migration_refuses_stale_plans_and_can_resume_its_own_reserved_numbers(self):
        folder = self.legacy()
        plan = delivery.migration_preview(self.flow)
        old = (folder / "decision.md").read_bytes()
        write(folder / "decision.md", old + b"\n")
        with self.assertRaisesRegex(WorkflowError, "改变"):
            delivery.migrate(self.flow, plan, "确认")
        write(folder / "decision.md", old)
        original = delivery.complete
        def interrupt(flow, item, path):
            if item == "001-D1":
                raise OSError("synthetic interruption")
            return original(flow, item, path)
        with patch("delivery.complete", side_effect=interrupt), self.assertRaises(OSError):
            delivery.migrate(self.flow, plan, "确认")
        with self.assertRaisesRegex(WorkflowError, "迁移未完成"):
            self.register()
        delivery.migrate(self.flow, plan, "继续同一份核对")
        self.assertEqual(delivery.reservations(self.flow), [])
        self.assertEqual(self.register()["id"], "002")

    def test_migrated_supersession_preserves_files_and_revokes_both_aliases(self):
        self.legacy()
        original = read(self.flow.state / "asks/A4.json")
        write(self.flow.state / "asks/A5.json", {**original, "id": "A5", "status": "open", "answers": []})
        before = snapshot(self.flow.state)
        delivery.migrate(self.flow, delivery.migration_preview(self.flow), "checked")
        for old, alias, reference in [("A4", "001-A1", "001-A1"), ("A5", "001-A2", "A5")]:
            replacement = collab.create_ask(self.flow, {"delivery": "001", "kind": "approve", "title": "replacement",
                                                       "body": "changed packet", "binds": {"packet": "b" * 64},
                                                       "supersedes": reference})
            self.assertEqual(replacement["answers"], [])
            for ref in [old, alias]:
                self.assertEqual(delivery.show(self.flow, ref)["status"], "superseded")
                self.assertFalse(collab.granted(delivery.show(self.flow, ref)))
                with self.assertRaises(WorkflowError):
                    collab.answer(self.flow, ref, "yes", "late answer")
        after = snapshot(self.flow.state)
        for name, value in before.items():
            self.assertEqual(after[name], value, name)

    def test_migrated_answers_and_cancellation_preserve_the_original_request(self):
        self.legacy()
        path = self.flow.state / "asks/A4.json"
        write(path, {**read(path), "status": "open", "answers": []})
        before = snapshot(self.flow.state)
        delivery.migrate(self.flow, delivery.migration_preview(self.flow), "checked")
        collab.answer(self.flow, "001-A1", "other", "need to check")
        collab.answer(self.flow, "A4", "yes", "approved original packet")
        self.assertEqual(len(delivery.show(self.flow, "001-A1")["answers"]), 2)
        self.assertTrue(collab.granted(delivery.show(self.flow, "A4")))
        collab.cancel_ask(self.flow, "001-A1", "withdraw original approval")
        self.assertFalse(collab.granted(delivery.show(self.flow, "A4")))
        self.assertEqual(delivery.show(self.flow, "A4")["status"], "cancelled")
        self.assertEqual(delivery.show(self.flow, "001-A1")["binds"], {"packet": "a" * 64})
        after = snapshot(self.flow.state)
        for name, value in before.items():
            self.assertEqual(after[name], value, name)
        write(path, {**read(path), "body": "unexpected external change"})
        with self.assertRaisesRegex(WorkflowError, "原文件已变化"):
            delivery.show(self.flow, "A4")

    def test_known_billing_does_not_replace_a_valid_independent_report(self):
        parent = self.flow.state / "prs/5"
        old = parent / "previous"
        packet = packet_for({"pr": 5}, {"src/a.mjs": "export {};\n"}, "lmuai")
        write(old / "request.json", packet)
        attempt = {"client_request_id": "earlier", "packet": packet["id"], "provider": "lmuai", "started_at": "then"}
        write(old / "attempt.json", attempt)
        billing = {"before": {"requests": 0, "actual_cost_usd": "0", "key_limit_usd": "0.30"},
                   "after": {"requests": 1, "actual_cost_usd": "0.10"}, "actual_cost_usd": "0.10"}
        result = {"packet": packet["id"], "checks": {name: {"status": "pass", "summary": "synthetic evidence",
                  "evidence": [{"path": "src/a.mjs", "line": 1, "note": "fixture"}]} for name in CHECKS}, "findings": []}
        # A valid failing report is a known result; a bill alone is not.
        result["checks"]["data"]["status"] = "fail"
        raw = {"id": "resp_fixture", "model": RELAY_MODEL, "status": "completed",
               "usage": {"input_tokens": 10, "output_tokens": 2}, "output": []}
        response = {"provider_request_id": "fixture", "response": raw, "billing": billing}
        write(old / "response.json", response)
        self.assertTrue(self.flow.previous_review_uncertainty(parent / "next"))
        raw["output"] = [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": json.dumps(result)}]}]
        write(old / "response.json", response)
        self.assertEqual(self.flow.previous_review_uncertainty(parent / "next"), [])
        write(old / "attempt.json", {**attempt, "packet": "wrong-packet"})
        self.assertTrue(self.flow.previous_review_uncertainty(parent / "next"))

    def test_billing_reconciliation_requires_separate_failed_result_evidence(self):
        parent = self.flow.state / "prs/5"
        old = parent / "previous"
        write(old / "attempt.json", {"client_request_id": "earlier", "provider": "lmuai", "started_at": "then"})
        write(old / "billing-reconciliation.json", {"client_request_id": "earlier", "outcome": "usage_confirmed",
                                                    "actual_cost_usd": "0.10", "evidence": "synthetic usage"})
        self.assertTrue(self.flow.previous_review_uncertainty(parent / "next"))
        resolution = {"client_request_id": "earlier", "outcome": "unavailable", "reason": "connection ended without a report",
                      "evidence": ["synthetic transport evidence"], "at": "then", "recorded_by": "fixture-agent"}
        for invalid in [{**resolution, "outcome": "pass"}, {**resolution, "client_request_id": "another"},
                        {**resolution, "evidence": []}]:
            write(old / "result-reconciliation.json", invalid)
            self.assertTrue(self.flow.previous_review_uncertainty(parent / "next"))
        write(old / "result-reconciliation.json", resolution)
        self.assertEqual(self.flow.previous_review_uncertainty(parent / "next"), [])
        (old / "billing-reconciliation.json").unlink()
        self.assertTrue(self.flow.previous_review_uncertainty(parent / "next"))

    def test_pause_resume_history_is_ordered_even_with_the_same_timestamp(self):
        self.register()
        with patch("delivery.timestamp", return_value="same second"):
            delivery.set_state(self.flow, "001", "paused", "等待现场", "先停")
            delivery.set_state(self.flow, "001", "active", "继续执行", "继续")
        self.assertEqual(delivery.delivery_state(self.flow, "001")["status"], "active")
        self.assertEqual([r["text"] for r in delivery.history(self.flow, "001") if r["action"] == "state"], ["先停", "继续"])

    def test_merged_dev_work_does_not_pass_acceptance_without_actual_matching_feedback(self):
        registration = self.register()
        collab.align(self.flow, "001", "对齐")
        folder, task = self.flow.task("001")
        task.update(phase="open", base=BASE)
        write(folder / "task.json", task)
        write(folder / "submit.json", {"phase": "confirmed", "pr": 5, "head": HEAD, "base": BASE})
        write(self.flow.state / "prs" / "5" / "merge-attempt.json",
              {"phase": "confirmed", "source": HEAD, "target": {"decision": task["id"], "release": None}})
        state = delivery.show(self.flow, "001")
        self.assertFalse(state["accepted"])
        self.assertFalse(state["progress"]["closed"])
        unknown = feedback.record(self.flow, "确实试过，但版本不明", target="dev", version={"commit": "unknown"})
        with self.assertRaisesRegex(WorkflowError, "通过须有"):
            delivery.accept_dev(self.flow, "001", unknown["id"], "pass")
        delivery.accept_dev(self.flow, "001", unknown["id"], "unconfirmed")
        actual = feedback.record(self.flow, "实际入口行为符合约定", target="dev", version={"commit": HEAD, "dirty": False})
        delivery.accept_dev(self.flow, "001", actual["id"], "pass")
        state = delivery.show(self.flow, "001")
        self.assertTrue(state["accepted"])
        self.assertFalse(state["published"])
        self.assertEqual([o["outcome"] for o in state["observations"]], ["unconfirmed", "pass"])
        receipt = next(p for p in (folder / "observations").glob("*.json") if read(p)["outcome"] == "pass")
        feedback.resolve_from_acceptance(self.flow, unknown["id"], receipt)
        self.assertEqual(feedback.load(self.flow, unknown["id"])[1]["status"], "resolved")

    def test_queries_do_not_write_or_contact_remote_and_cli_uses_complete_ids(self):
        registration = self.register()
        feedback.record(self.flow, "独立观察")
        feedback.link(self.flow, "F1", "001", "source", "准备处理")
        before = snapshot(self.flow.state)
        for item in ("001", "001-D1", "F1", "dev"):
            delivery.show(self.flow, item)
        self.assertEqual(snapshot(self.flow.state), before)

        for name in ("api", "main", "pr", "gh", "fetch"):
            getattr(self.repo, name).assert_not_called()
        result = subprocess.run([sys.executable, "-B", str(HERE / "workflow.py"), "--repo", self.repo.name,
                                 "--state-dir", str(self.root / "state"), "show", "001"],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["materials"]["F"][0]["id"], "F1")
        self.assertEqual(snapshot(self.flow.state), before)

    def test_real_local_git_start_submit_and_revision_use_full_number_without_leaking_private_inputs(self):
        source = self.root / "repository"
        source.mkdir()
        git(source, "init", "--quiet", "-b", "main")
        write(source / "tools" / "fixture.txt", b"original\n")
        git(source, "add", ".")
        git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-qm", "base")
        class LocalRepository:
            name, owner, url = "example/arcfold", "example", str(source)
            pull = None
            def main(self):
                return git_line(source, "rev-parse", "main")
            def fetch(self, path):
                path.mkdir(parents=True)
                git(path, "init", "--quiet")
                git(path, "fetch", self.url, "refs/heads/main:refs/arcfold/main")
            def api(self, endpoint, value=None):
                if value is None:
                    return [self.pull] if self.pull else []
                self.pull = {"number": 5, "html_url": "https://example.invalid/pull/5", "body": value["body"],
                             "title": value["title"], "head": {"sha": git_line(source, "rev-parse", value["head"])},
                             "base": {"sha": self.main()}}
                return self.pull
            def pr(self, number):
                return self.pull
        self.flow.repo = LocalRepository()
        registration = self.register()
        feedback.record(self.flow, "private synthetic feedback must stay local", total="001")
        collab.align(self.flow, "001", "private confirmation must stay local")
        started = self.flow.start("001")
        checkout = Path(started["checkout"])
        write(checkout / "tools" / "fixture.txt", b"changed\n")
        git(checkout, "add", ".")
        git(checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-qm", "candidate")
        def local_git(path, *args, **kwargs):
            kwargs.pop("remote", None)
            return git(path, *args, **kwargs)
        with patch("workflow.git", side_effect=local_git):
            submitted = self.flow.submit("001")
        self.assertEqual(submitted["head"], git_line(checkout, "rev-parse", "HEAD"))
        self.assertEqual(self.flow.repo.pull["title"], "[交付 001] 编号场景")
        decision = (checkout / "docs" / "notes" / "delivery-001.md").read_text()
        self.assertIn("[001-D1]", decision)
        self.assertNotIn("private", decision)
        self.assertNotIn("private", self.flow.repo.pull["body"])
        changed = Path(registration["decision"]).read_bytes().replace("具体行为".encode(), "新决策行为".encode())
        revision = delivery.revise(self.flow, "001", changed)
        with self.assertRaisesRegex(WorkflowError, "取代"):
            self.flow.submit(registration["task"])
        self.assertEqual(revision["decision_id"], "001-D2")



if __name__ == "__main__":
    unittest.main()
