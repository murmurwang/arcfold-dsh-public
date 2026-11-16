from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from common import WorkflowError, read, write
import merge_queue
import source_delivery
from workflow import Workflow


class MergeQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        repo = Mock(name="remote")
        repo.name = "example/arcfold"
        self.flow = Workflow(repo, self.temp.name)
        for key in ("first-task", "second-task"):
            self.flow.new({"id": key, "title": key, "authorization_ref": "synthetic", "scope": ["src/"],
                           "observed_in_version": "0.5.1"})
            path, row = self.flow.task(key)
            row["phase"] = "open"
            write(path / "task.json", row)
        self.first = {"pr": 1, "decision": "first-task", "head": "a" * 40, "base": "b" * 40}
        self.second = {"pr": 2, "decision": "second-task", "head": "c" * 40, "base": "b" * 40}

    def test_oldest_ready_first_and_changed_base_waits_locally(self):
        merge_queue.enqueue(self.flow, self.first)
        merge_queue.enqueue(self.flow, self.second)
        with self.assertRaisesRegex(WorkflowError, "等待更久"):
            merge_queue.require_turn(self.flow, self.second)
        merge_queue.require_turn(self.flow, self.first)
        moved = {**self.second, "base": "d" * 40}
        merge_queue.enqueue(self.flow, moved)
        merge_queue.require_turn(self.flow, moved)
        before = list(merge_queue.folder(self.flow).rglob("*"))
        self.assertEqual(merge_queue.view(self.flow, moved["base"])[0]["state"], "waiting")
        self.assertEqual(list(merge_queue.folder(self.flow).rglob("*")), before)

    def test_unknown_other_merge_keeps_main_owned_after_process_exit(self):
        merge_queue.enqueue(self.flow, self.second)
        write(self.flow.state / "prs/1/merge-attempt.json", {"phase": "merging"})
        with self.assertRaisesRegex(WorkflowError, "主线写入结果未知"):
            merge_queue.require_turn(self.flow, self.second)
        write(self.flow.state / "prs/1/merge-attempt.json", {"phase": "confirmed"})
        merge_queue.require_turn(self.flow, self.second)
        self.flow.repo.api.assert_not_called()

    def test_cancel_removes_turn_but_never_resolves_unknown_remote_effect(self):
        merge_queue.enqueue(self.flow, self.first)
        merge_queue.enqueue(self.flow, self.second)
        merge_queue.cancel(self.flow, 1, "synthetic scope withdrawn")
        merge_queue.require_turn(self.flow, self.second)
        write(self.flow.state / "prs/1/merge-attempt.json", {"phase": "merging"})
        with self.assertRaises(WorkflowError):
            merge_queue.require_turn(self.flow, self.second)

    def test_only_one_active_assembly_owns_a_version(self):
        note = {"release_mode": "assembly", "fixed_in": "0.6.0", "sha256": "e" * 64}
        source_delivery.reserve_target(self.flow, {"id": "first-task"}, note)
        source_delivery.reserve_target(self.flow, {"id": "first-task"}, note)
        with self.assertRaisesRegex(WorkflowError, "已有发行组装"):
            source_delivery.reserve_target(self.flow, {"id": "second-task"}, note)
        write(self.flow.task("first-task")[0] / "retired.json", {"reason": "synthetic withdrawal"})
        source_delivery.reserve_target(self.flow, {"id": "second-task"}, note)
        self.assertTrue(list((self.flow.state / "release-targets/history").glob("*.json")))
