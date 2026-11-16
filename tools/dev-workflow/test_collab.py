import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import Mock, patch

from collab import (
    MARK_START, align, answer, create_ask, load_ask, load_feedback, new_from_feedback, progress, record_feedback,
    render, retire, review_approval, route, write_section,
)
from common import WorkflowError, digest, read, write
from workflow import SECTIONS, Workflow, decision_note, parse_args

HEAD = "a" * 40
BASE = "b" * 40
OTHER = "c" * 40
REPO = "example/arcfold"
UNKNOWN = {"@arcfold/dsh": "unknown", "@arcfold/dsh-method-ui": "unknown"}


def snapshot(root):
    return sorted((path.relative_to(root).as_posix(), path.stat().st_mtime_ns, path.stat().st_size)
                  for path in Path(root).rglob("*"))


class CollabTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = Mock()
        self.repo.name = REPO
        self.repo.main.return_value = BASE
        self.flow = Workflow(self.repo, self.root / "state")
        self.profile = self.root / "profile"
        environment = patch.dict("os.environ", {"ARCFOLD_DAILY_PROFILE": str(self.profile), "ARCFOLD_AGENT_ID": "test-agent"})
        environment.start()
        self.addCleanup(environment.stop)

    def register(self, key="sample-task"):
        self.flow.new({"id": key, "title": "示例问题", "authorization_ref": "开发者的反馈", "scope": ["src/"],
                       "observed_in_version": "0.4.0"})
        path = self.flow.state / "tasks" / key / "decision.md"
        path.write_text(path.read_text().replace("[TBD]", "具体内容"))
        return path

    def install_daily(self, version):
        for name in ("dsh", "dsh-method-ui"):
            write(self.profile / "node_modules" / "@arcfold" / name / "package.json",
                  {"name": "@arcfold/" + name, "version": version})

    def released_task(self):
        key, state = "shipped", self.flow.state
        write(state / "tasks" / key / "task.json", {"id": key, "title": "已发布的修复", "phase": "open", "base": BASE,
                                                   "checkout": str(self.root / "missing-checkout")})
        write(state / "tasks" / key / "submit.json", {"phase": "confirmed", "pr": 4, "head": HEAD, "base": BASE})
        write(state / "prs" / "4" / "merge-attempt.json", {
            "phase": "confirmed", "source": OTHER, "target": {"decision": key, "release": {"version": "0.4.1"}}})
        folder = state / "releases" / "0.4.1"
        write(folder / "release.json", {"version": "0.4.1"})
        for name in ("github.json", "finalize.json", "npm-publish.json"):
            write(folder / name, {"phase": "published"})
        write(state / "tasks" / key / "observations" / "first.json",
              {"at": "2026-11-15T13:44:23+00:00", "user_verified": "更新超时后回到 0.4.0"})
        write(state / "tasks" / key / "diagnostics" / "issue.json", {"phase": "confirmed", "outcome_comment": {"phase": "unknown"}})
        write(state / "prs" / "9" / "run" / "attempt.json", {"phase": "sending", "client_request_id": "one"})
        return key

    def test_next_places_a_released_task_in_d6_and_lists_unknown_writes_offline_without_writing(self):
        key = self.released_task()
        before = snapshot(self.root)
        result = progress(self.flow)
        self.assertEqual(snapshot(self.root), before)
        row = [item for item in result["tasks"] if item["id"] == key][0]
        self.assertEqual((row["stage"], row["closed"], row["outcome"]), ("D6", False, "unconfirmed"))
        self.assertIn({"file": f"tasks/{key}/diagnostics/issue.json", "field": "outcome_comment.phase",
                       "phase": "unknown", "what": "结果未知的记录"}, result["pending_writes"])
        self.assertIn("prs/9/run/attempt.json", [item["file"] for item in result["pending_writes"]])
        self.assertEqual(result["daily"]["packages"], UNKNOWN)
        for call in (self.repo.main, self.repo.api, self.repo.pr, self.repo.gh, self.repo.fetch):
            call.assert_not_called()

    def test_start_requires_alignment_with_the_current_decision_and_no_open_decisions(self):
        decision = self.register()
        with self.assertRaisesRegex(WorkflowError, "对齐"):
            self.flow.start("sample-task")
        align(self.flow, "sample-task", "决策对齐了")
        decision.write_text(decision.read_text().replace("具体内容", "改过的内容", 1))
        with self.assertRaisesRegex(WorkflowError, "重新确认"):
            self.flow.start("sample-task")
        aligned = align(self.flow, "sample-task", "改过的也对齐了")
        self.assertEqual(aligned["previous"][0]["text"], "决策对齐了")
        ask = create_ask(self.flow, {"kind": "decide", "title": "进度怎么显示", "body": "两种方式的实际后果", "task": "sample-task",
                                     "options": ["显示下载进度", "提前放进缓存"]})
        with self.assertRaisesRegex(WorkflowError, "决定单"):
            self.flow.start("sample-task")
        self.repo.main.assert_not_called()
        self.repo.fetch.assert_not_called()
        self.assertEqual(progress(self.flow)["tasks"][0]["waiting_on"], "开发者")
        answer(self.flow, ask["id"], "other", "选显示下载进度")
        with self.assertRaises((WorkflowError, OSError)):
            self.flow.start("sample-task")
        self.repo.main.assert_called()
        with self.assertRaisesRegex(WorkflowError, "冻结"):
            align(self.flow, "sample-task", "再对齐一次")

    def test_answer_refuses_missing_and_already_answered_requests(self):
        ask = create_ask(self.flow, {"kind": "approve", "title": "PR #5 的审阅费用", "body": "估算 0.26 美元",
                                     "binds": {"packet": "a" * 64}})
        self.assertEqual((ask["id"], ask["replies"]), ("A1", ["批准 A1", "不批准 A1"]))
        with self.assertRaisesRegex(WorkflowError, "没有请求单 A9"):
            answer(self.flow, "A9", "yes", "批准 A9")
        self.assertEqual(answer(self.flow, "A1", "other", "等我看看")["status"], "open")
        self.assertEqual(answer(self.flow, "A1", "yes", "批准 A1")["status"], "answered")
        with self.assertRaisesRegex(WorkflowError, "已经答过"):
            answer(self.flow, "A1", "no", "不批准 A1")
        with self.assertRaisesRegex(WorkflowError, "绑定"):
            create_ask(self.flow, {"kind": "approve", "title": "没有对象", "body": "缺少绑定"})
        plan = self.root / "plan.json"
        plan.write_text("{}")
        with self.assertRaisesRegex(WorkflowError, "不一致"):
            create_ask(self.flow, {"kind": "approve", "title": "写入日常缓存", "body": "按计划",
                                   "binds": {"files": {str(plan): "0" * 64}}})
        steps = create_ask(self.flow, {"kind": "act", "title": "隔离验收", "body": "按步骤操作", "steps": ["切换账户", "安装插件"]})
        self.assertEqual(steps["replies"], ["A2.1 好了", "A2.2 好了"])
        answer(self.flow, "A2", "yes", "A2.1 好了", step=1)
        with self.assertRaisesRegex(WorkflowError, "已经答过"):
            answer(self.flow, "A2", "yes", "A2.1 又好了", step=1)
        self.assertEqual(answer(self.flow, "A2", "yes", "A2.2 好了", step=2)["status"], "answered")

    def test_review_approval_must_match_the_material_or_stay_under_the_pr_cap(self):
        packet, estimate = "b" * 64, {"estimated_usd_at_output_limit": "0.20"}
        with self.assertRaisesRegex(WorkflowError, "没有请求单"):
            review_approval(self.flow, "A1", 5, packet, estimate)
        exact = create_ask(self.flow, {"kind": "approve", "title": "审阅", "body": "估算", "binds": {"packet": packet}})
        with self.assertRaisesRegex(WorkflowError, "还没有"):
            review_approval(self.flow, exact["id"], 5, packet, estimate)
        answer(self.flow, exact["id"], "no", "不批准")
        with self.assertRaisesRegex(WorkflowError, "没有获得同意"):
            review_approval(self.flow, exact["id"], 5, packet, estimate)
        other = create_ask(self.flow, {"kind": "approve", "title": "审阅", "body": "估算", "binds": {"packet": "c" * 64}})
        answer(self.flow, other["id"], "yes", "批准")
        with self.assertRaisesRegex(WorkflowError, "另一份"):
            review_approval(self.flow, other["id"], 5, packet, estimate)
        capped = create_ask(self.flow, {"kind": "approve", "title": "PR #5 审阅累计", "body": "累计不超过 0.40 美元",
                                        "binds": {"pr": 5, "cap_usd": "0.40"}})
        answer(self.flow, capped["id"], "yes", "PR #5 的审阅累计批到 0.4 美元")
        write(self.flow.state / "prs" / "5" / "old" / "response.json", {"billing": {"actual_cost_usd": "0.30"}, "response": {}})
        with self.assertRaisesRegex(WorkflowError, "超过"):
            review_approval(self.flow, capped["id"], 5, packet, estimate)
        self.assertEqual(review_approval(self.flow, capped["id"], 5, packet, {"estimated_usd_at_output_limit": "0.10"})["spent_usd"],
                         "0.30")
        with self.assertRaisesRegex(WorkflowError, "PR #6"):
            review_approval(self.flow, capped["id"], 6, packet, estimate)

    def test_review_without_a_granted_request_never_launches_the_reviewer(self):
        run_dir = self.flow.state / "prs" / "5" / (HEAD + "-" + BASE)
        target = {"repo": REPO, "pr": 5, "head": HEAD, "base": BASE}
        ask = create_ask(self.flow, {"kind": "approve", "title": "审阅", "body": "估算", "binds": {"packet": "d" * 64}})
        with patch.object(Workflow, "preflight", return_value=(run_dir, target, {"src/a.mjs": "export {};\n"}, None)), \
                patch("workflow.command") as launch:
            self.assertIn("estimated_usd_at_output_limit", self.flow.review(5))
            with self.assertRaisesRegex(WorkflowError, "还没有"):
                self.flow.review(5, ask["id"])
            answer(self.flow, ask["id"], "yes", "批准")
            with self.assertRaisesRegex(WorkflowError, "另一份"):
                self.flow.review(5, ask["id"])
        launch.assert_not_called()
        self.assertFalse((run_dir / "attempt.json").exists())

    def test_feedback_records_the_daily_version_and_stays_listed_until_routed(self):
        self.install_daily("0.4.0")
        shot = self.root / "screen.png"
        shot.write_bytes(b"png")
        item = record_feedback(self.flow, "更新时一直显示安装中\n看不出进度", [shot])
        self.assertEqual(item["daily"]["packages"]["@arcfold/dsh"], "0.4.0")
        self.assertEqual(item["attachments"], [{"file": "01-screen.png", "sha256": digest(b"png"), "bytes": 3}])
        self.assertEqual([(row["id"], row["summary"]) for row in progress(self.flow)["feedback"]],
                         [(item["id"], "更新时一直显示安装中")])
        with self.assertRaisesRegex(WorkflowError, "原因"):
            route(self.flow, item["id"], "note")
        with self.assertRaisesRegex(WorkflowError, "去向"):
            route(self.flow, item["id"], "somewhere")
        route(self.flow, item["id"], "issue:7")
        self.assertEqual(progress(self.flow)["feedback"], [])
        with self.assertRaisesRegex(WorkflowError, "已经记过"):
            route(self.flow, item["id"], "issue:7")
        shutil.rmtree(self.profile)
        self.assertEqual(record_feedback(self.flow, "另一条观察")["daily"]["packages"], UNKNOWN)

    def test_new_from_feedback_prefills_source_and_version_and_routes_it(self):
        self.install_daily("0.4.0")
        item = record_feedback(self.flow, "更新时看不出进度")
        result = new_from_feedback(self.flow, {"id": "slow-update", "title": "更新时看不出进度", "scope": ["src/"]}, item["id"])
        text = Path(result["decision"]).read_text()
        self.assertTrue(text.startswith("# 决策：更新时看不出进度\n"))
        self.assertIn("observed_in_version: 0.4.0", text)
        self.assertIn(item["id"], text)
        self.assertEqual([row["to"] for row in load_feedback(self.flow, item["id"])[1]["routes"]], ["new:slow-update"])

    def test_close_loop_requires_an_outcome_and_records_it(self):
        decision = self.register()
        decision.write_text(decision.read_text().replace("fixed_in: pending", "fixed_in: 0.4.1"))
        write(self.flow.state / "releases" / "0.4.1" / "release.json",
              {"target": {"decision": "sample-task"}, "source": OTHER, "packages": []})
        item = record_feedback(self.flow, "更新到 0.4.1 后旧对话能打开")
        with patch("release.published") as published:
            with self.assertRaisesRegex(WorkflowError, "验收结论"):
                self.flow.close_loop("sample-task", "0.4.1", "已更新", None)
            published.assert_not_called()
            result = self.flow.close_loop("sample-task", "0.4.1", None, "pass", item["id"])
        self.assertEqual((result["outcome"], result["user_verified"]), ("pass", "更新到 0.4.1 后旧对话能打开"))
        self.assertEqual(load_feedback(self.flow, item["id"])[1]["routes"][0]["to"], "close-loop:sample-task")
        argv = ["workflow.py", "--repo", REPO, "close-loop", "sample-task", "--version", "0.4.1", "--observation-file", "x"]
        with patch("sys.argv", argv), patch("sys.stderr"), self.assertRaises(SystemExit):
            parse_args()

    def test_existing_english_decisions_and_the_new_chinese_template_both_pass(self):
        english = ("# Agent Note: Earlier task\n\nStatus: proposed\nobserved_in_version: 0.4.0\nfixed_in: 0.4.1\n"
                   "user_verified: pending\n\n" + "".join(f"## {name}\n\n- detail\n\n" for name in SECTIONS))
        self.assertEqual(decision_note(english.encode())["title"], "Earlier task")
        chinese = decision_note(self.register().read_bytes())
        self.assertEqual((chinese["title"], chinese["criteria"]), ("示例问题", ["具体内容"]))
        with self.assertRaisesRegex(WorkflowError, "Problem"):
            decision_note(english.replace("## Problem", "## 问题").encode())

    def test_retired_tasks_leave_the_active_list(self):
        self.register("first-task")
        self.register("second-task")
        retire(self.flow, "first-task", "被 second-task 取代", "second-task")
        result = progress(self.flow)
        self.assertEqual([row["id"] for row in result["tasks"]], ["second-task"])
        self.assertEqual(result["tasks"][0]["next"], "决策已写完，等开发者读完全文后确认对齐")
        self.assertEqual(result["retired"][0]["replaced_by"], "second-task")
        with self.assertRaisesRegex(WorkflowError, "已经退场"):
            retire(self.flow, "first-task", "再退一次")

    def test_merge_refuses_while_the_task_has_an_open_decision(self):
        self.register()
        create_ask(self.flow, {"kind": "decide", "title": "要不要改范围", "body": "两种后果", "task": "sample-task"})
        self.repo.pr.return_value = {"state": "open", "draft": False, "head": {"sha": HEAD},
                                     "base": {"sha": BASE, "ref": "main", "repo": {"full_name": REPO}}}
        receipt = {"target": {"decision": "sample-task"}, "sha256": "receipt"}
        with patch.object(self.flow, "verify_receipt", return_value=(receipt, {"url": "comment"})), \
                self.assertRaisesRegex(WorkflowError, "决定单 A1"):
            self.flow.merge(10)
        self.repo.gh.assert_not_called()

    def test_write_replaces_only_the_marked_section_and_keeps_the_file_mode(self):
        target = self.root / "README.md"
        target.write_text("# 标题\n\n手写内容\n")
        os.chmod(target, 0o644)
        self.released_task()
        write_section(target, render(progress(self.flow)))
        write_section(target, render(progress(self.flow)))
        text = target.read_text()
        self.assertTrue(text.startswith("# 标题\n\n手写内容\n"))
        self.assertEqual(text.count(MARK_START), 1)
        self.assertIn("| shipped | D6 |", text)
        self.assertEqual(target.stat().st_mode & 0o777, 0o644)


if __name__ == "__main__":
    unittest.main()
