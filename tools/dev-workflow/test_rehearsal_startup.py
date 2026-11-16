"""Synthetic handoff checks. Never installs launchd jobs or touches the test account."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import collab
from common import WorkflowError, digest, read, write
import rehearsal_agent as agent
import rehearsal_startup as startup
from workflow import Workflow


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        repo = Mock()
        repo.name = "example/arcfold"
        self.flow = Workflow(repo, self.root / "state")
        self.shared = self.root / "shared"
        self.shared.mkdir(mode=0o755)
        (self.shared / "inbox").mkdir(mode=0o755)
        self.outbox = self.root / "results"
        self.outbox.mkdir(mode=0o755)
        self.home = self.root / "test-home"
        self.home.mkdir(mode=0o700)
        self.config = {"schema": 1, "repo": repo.name, "account": startup.ACCOUNT, "uid": os.getuid(),
                       "issuer_uid": os.getuid(), "shared": str(self.shared), "outbox": str(self.outbox),
                       "home": str(self.home), "node": "/synthetic/node", "label": "synthetic.test",
                       "harness": {name: digest((startup.HERE / "rehearsal" / name).read_bytes()) for name in startup.CONTROLS}}
        write(self.shared / "service.json", self.config)
        self.service_sha = digest((self.shared / "service.json").read_bytes())
        write(startup.local(self.flow) / "service.json", {"shared": str(self.shared), "outbox": str(self.outbox),
            "uid": os.getuid(), "account": startup.ACCOUNT, "service_sha256": self.service_sha})
        self.kit = self.root / "kit"
        self.kit.mkdir()
        rows = []
        for version in ("1.0.0", "1.0.1"):
            for index, name in enumerate(("@arcfold/dsh", "@arcfold/dsh-method-ui")):
                filename = f"fixture-{index}-{version}.tgz"
                data = (name + version).encode()
                (self.kit / filename).write_bytes(data)
                rows.append({"name": name, "version": version, "file": filename,
                             "source": "a" * 40, "sha256": digest(data)})
        self.bundle = {"older": "1.0.0", "newer": "1.0.1", "candidate": "a" * 40, "packages": rows}
        self.bundle["id"] = digest(self.bundle)[:12]
        write(self.kit / "bundle.json", self.bundle)
        for name in startup.CONTROLS:
            shutil.copyfile(startup.HERE / "rehearsal" / name, self.kit / name)
        self.deadline = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        self.plan = self.root / "session.json"
        startup.prepare_run(self.flow, self.kit, self.plan, self.deadline)
        self.ask = self.approve(self.plan)
        here = patch.object(agent, "HERE", self.shared)
        here.start()
        self.addCleanup(here.stop)

    def approve(self, path):
        ask = collab.create_ask(self.flow, {"kind": "approve", "title": "Synthetic exact plan",
            "body": "Test-only approval", "binds": {"files": {str(path): digest(path.read_bytes())}}})
        collab.answer(self.flow, ask["id"], "yes", "Synthetic fixture approved")
        return ask["id"]

    def enqueue(self):
        row = startup.enqueue(self.flow, self.plan, self.ask)
        _, job = startup.job_record(self.flow, row["id"])
        return Path(job["folder"]), read(Path(job["folder"]) / "request.json")

    def ready(self, daemon, request):
        agent.save(daemon.private / (request["id"] + ".json"), {"last_seq": 1, "launches": 1,
                   "pid": 9000, "folder": str(self.shared / "inbox" / request["id"]), "pending": None})
        daemon.report(request, "ready", last_seq=1)
        daemon.heartbeat()

    def test_package_and_control_changes_rejected_before_queue(self):
        (self.kit / "run.mjs").write_text("unapproved")
        with self.assertRaisesRegex(WorkflowError, "脚本"):
            startup.inventory(self.kit)
        with self.assertRaisesRegex(WorkflowError, "脚本"):
            startup.enqueue(self.flow, self.plan, self.ask)
        self.assertEqual(list((self.shared / "inbox").iterdir()), [])

    def test_pair_source_and_unique_archive_names_required(self):
        self.bundle["packages"][3]["source"] = "b" * 40
        self.bundle["id"] = digest({k: v for k, v in self.bundle.items() if k != "id"})[:12]
        write(self.kit / "bundle.json", self.bundle)
        with self.assertRaisesRegex(WorkflowError, "候选"):
            startup.inventory(self.kit)

    def test_stale_approval_does_not_enqueue(self):
        plan = read(self.plan)
        plan["expires_at"] = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
        write(self.plan, plan)
        with self.assertRaisesRegex(WorkflowError, "授权"):
            startup.enqueue(self.flow, self.plan, self.ask)

    def test_repeated_queue_and_interrupted_local_record_reuse_original(self):
        folder, request = self.enqueue()
        original = (folder / "request.json").read_bytes()
        self.assertEqual(startup.enqueue(self.flow, self.plan, self.ask)["id"], request["id"])
        startup.job_record(self.flow, request["id"])[0].unlink()
        self.assertEqual(startup.enqueue(self.flow, self.plan, self.ask)["id"], request["id"])
        self.assertEqual((folder / "request.json").read_bytes(), original)
        self.assertEqual(len(list((folder / "commands").iterdir())), 1)

    def test_restrictive_umask_still_allows_readonly_cross_account_handoff(self):
        previous = os.umask(0o077)
        try:
            folder, _ = self.enqueue()
            self.outbox.rmdir()
            agent.outbox(self.config)
        finally:
            os.umask(previous)
        for path in (folder, folder / "kit", folder / "commands", self.outbox):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755)
        for path in (folder / "request.json", folder / "commands" / "000001.json"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)

    def test_another_approval_cannot_start_same_bundle_again(self):
        self.enqueue()
        other = self.approve(self.plan)
        with self.assertRaisesRegex(WorkflowError, "已经登记"):
            startup.enqueue(self.flow, self.plan, other)

    def test_agent_rejects_account_binding_and_non_whitelisted_action(self):
        folder, request = self.enqueue()
        agent.validate_request(self.config, folder)
        with self.assertRaisesRegex(RuntimeError, "不符"):
            agent.validate_request({**self.config, "uid": os.getuid() + 1}, folder)
        write(folder / "commands" / "000001.json", {"seq": 1, "job": request["id"], "action": "shell"})
        daemon = agent.Agent(self.config)
        with patch.object(agent.subprocess, "Popen") as spawn, self.assertRaisesRegex(RuntimeError, "动作无效"):
            daemon.handle(folder)
        spawn.assert_not_called()

    def test_foreign_owner_writable_or_symlink_material_rejected(self):
        folder, _ = self.enqueue()
        material = folder / "kit" / "run.mjs"
        material.chmod(0o666)
        with self.assertRaisesRegex(RuntimeError, "权限"):
            agent.validate_request(self.config, folder)
        material.unlink()
        material.symlink_to(self.kit / "run.mjs")
        with self.assertRaisesRegex(RuntimeError, "类型"):
            agent.validate_request(self.config, folder)
        with self.assertRaises(RuntimeError):
            agent.owned(folder / "request.json", os.getuid() + 1)

    def test_ready_requires_actual_probe_and_repeated_handle_does_not_spawn(self):
        folder, request = self.enqueue()
        daemon = agent.Agent(self.config)
        process = Mock(pid=9000)
        process.poll.return_value = None
        observed = {"ready": True, "uid": os.getuid(), "pid": 9001}
        with patch.object(agent.subprocess, "Popen", return_value=process) as spawn, \
             patch.object(daemon, "observe", return_value=observed), patch.object(agent, "matching_runner", return_value=True):
            daemon.handle(folder)
            daemon.handle(folder)
        spawn.assert_called_once()
        receipt = startup.status(self.flow, request["id"])
        self.assertEqual((receipt["state"], receipt["last_seq"]), ("ready", 1))
        self.assertNotIn("pass", receipt)

    def test_failed_start_preserves_unknown_and_never_replays(self):
        folder, request = self.enqueue()
        daemon = agent.Agent(self.config)
        process = Mock(pid=9000)
        process.poll.return_value = 1
        with patch.object(agent.subprocess, "Popen", return_value=process) as spawn, \
             patch.object(agent, "matching_runner", return_value=False):
            daemon.handle(folder)
            daemon.handle(folder)
        spawn.assert_called_once()
        self.assertEqual(startup.status(self.flow, request["id"])["state"], "unknown")
        self.assertIsNotNone(daemon.state(request)["pending"])

    def test_restart_recovers_only_recorded_live_window(self):
        folder, request = self.enqueue()
        daemon = agent.Agent(self.config)
        agent.save(daemon.private / (request["id"] + ".json"), {"last_seq": 0, "launches": 1,
            "pid": 9000, "folder": str(folder), "pending": {"seq": 1, "action": "launch"}})
        with patch.object(agent.subprocess, "Popen") as spawn, patch.object(agent, "matching_runner", return_value=True), \
             patch.object(daemon, "observe", return_value={"ready": True, "uid": os.getuid()}):
            daemon.handle(folder)
        spawn.assert_not_called()
        receipt = read(self.outbox / (request["id"] + ".json"))
        self.assertTrue(receipt["recovered"])
        self.assertEqual(daemon.state(request)["last_seq"], 1)

    def test_live_other_job_and_pause_block_new_spawn(self):
        folder, request = self.enqueue()
        daemon = agent.Agent(self.config)
        agent.save(daemon.private / "prior.json", {"pid": 8000, "folder": str(self.root / "prior")})
        with patch.object(agent, "matching_runner", return_value=True), patch.object(agent.subprocess, "Popen") as spawn:
            daemon.handle(folder)
        spawn.assert_not_called()
        self.assertEqual(read(self.outbox / (request["id"] + ".json"))["state"], "waiting_window_exit")
        (daemon.private / "prior.json").unlink()
        startup.pause(self.flow, True)
        with patch.object(agent.subprocess, "Popen") as spawn:
            daemon.tick()
        spawn.assert_not_called()
        self.assertTrue(read(self.outbox / "heartbeat.json")["paused"])

    def test_cancel_immediately_before_spawn_stops_unsent_action(self):
        folder, request = self.enqueue()
        daemon = agent.Agent(self.config)
        with patch.object(agent, "stopped", side_effect=[False, True]), patch.object(agent.subprocess, "Popen") as spawn:
            daemon.handle(folder)
        spawn.assert_not_called()
        self.assertIsNone(daemon.state(request)["pending"])
        self.assertEqual(read(self.outbox / (request["id"] + ".json"))["state"], "cancelled")

    def test_unknown_one_shot_and_cancel_never_replay_or_kill(self):
        folder, request = self.enqueue()
        daemon = agent.Agent(self.config)
        agent.save(daemon.private / (request["id"] + ".json"), {"last_seq": 1, "launches": 1,
                   "pending": {"seq": 2, "action": "finish"}})
        startup.cancel(self.flow, request["id"])
        with patch.object(agent.subprocess, "Popen") as spawn, patch.object(agent.os, "kill") as kill:
            daemon.handle(folder)
        spawn.assert_not_called()
        kill.assert_not_called()

    def test_main_requires_fresh_heartbeat_and_reports_rejected_material(self):
        folder, request = self.enqueue()
        daemon = agent.Agent(self.config)
        self.ready(daemon, request)
        (self.outbox / "heartbeat.json").unlink()
        self.assertEqual(startup.status(self.flow, request["id"])["state"], "waiting_session")
        (folder / "request.json").write_text("{}")
        daemon.tick()
        self.assertEqual(startup.status(self.flow, request["id"])["state"], "request_rejected")

    def test_steps_wait_for_receipt_and_export_actual_evidence(self):
        folder, request = self.enqueue()
        with self.assertRaisesRegex(WorkflowError, "前一动作"):
            startup.step(self.flow, request["id"], "finish")
        daemon = agent.Agent(self.config)
        self.ready(daemon, request)
        startup.step(self.flow, request["id"], "finish")
        evidence = self.home / ("Arcfold-DSH-Rehearsal-" + self.bundle["id"] + "-evidence")
        agent.save(evidence / "result.json", {"checks": {"synthetic": "unconfirmed"}})
        process = Mock()
        process.wait.return_value = 0
        with patch.object(agent, "matching_runner", return_value=True), \
             patch.object(agent.subprocess, "Popen", return_value=process):
            daemon.handle(folder)
        receipt = startup.status(self.flow, request["id"])
        exported = self.outbox / receipt["evidence"]["result.json"]["file"]
        self.assertEqual(read(exported)["checks"]["synthetic"], "unconfirmed")

    def test_expired_or_rewritten_request_is_not_executed(self):
        folder, request = self.enqueue()
        with patch.object(agent, "datetime") as clock, self.assertRaisesRegex(RuntimeError, "到期"):
            clock.fromisoformat.side_effect = datetime.fromisoformat
            clock.now.return_value = datetime.now(timezone.utc) + timedelta(hours=2)
            agent.validate_request(self.config, folder)
        request["plan"]["expires_at"] = "2000-01-01T00:00:00+00:00"
        write(folder / "request.json", request)
        daemon = agent.Agent(self.config)
        with patch.object(agent.subprocess, "Popen") as spawn:
            daemon.tick()
        spawn.assert_not_called()
        self.assertEqual(startup.status(self.flow, request["id"])["state"], "request_rejected")

    def test_os_spawn_failure_keeps_attempt_without_automatic_retry(self):
        folder, request = self.enqueue()
        daemon = agent.Agent(self.config)
        with patch.object(agent.subprocess, "Popen", side_effect=OSError) as spawn:
            daemon.handle(folder)
            daemon.handle(folder)
        spawn.assert_called_once()
        self.assertEqual(startup.status(self.flow, request["id"])["state"], "failed")
        self.assertIsNone(daemon.state(request)["pending"])

    def test_probe_process_matching_requires_exact_owner_directory_and_port(self):
        node = shutil.which("node")
        self.assertIsNotNone(node)
        script = """
import assert from 'node:assert/strict';
import {matchingProcesses} from MODULE;
const base = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --user-data-dir=/test/electron --remote-debugging-address=127.0.0.1 --remote-debugging-port=48622';
const rows = ['100 503 '+base, '101 501 '+base, '102 503 '+base.replace('/test/electron', '/daily/electron'),
 '103 503 '+base.replace('48622', '48623'), '104 503 '+base.replace('127.0.0.1', '0.0.0.0')].join('\\n');
assert.deepEqual(matchingProcesses(rows, {uid:503,userData:'/test/electron'}), [100]);
""".replace("MODULE", json.dumps((startup.HERE / "rehearsal_probe.mjs").as_uri()))
        subprocess.run([node, "--input-type=module", "-e", script], check=True, capture_output=True, timeout=15)


    def test_prepared_upgrade_uses_distinct_path_and_keeps_old_material(self):
        source = self.root / "source"
        source.mkdir()
        for name in ("rehearsal_agent.py", "rehearsal_probe.mjs"):
            shutil.copyfile(startup.HERE / name, source / name)
        shutil.copytree(startup.HERE / "rehearsal", source / "rehearsal")
        account = {"account": startup.ACCOUNT, "uid": os.getuid(), "home": str(self.home)}
        with patch.object(startup, "identity", return_value=account), patch.object(startup, "HERE", source), \
             patch.object(startup, "NODE", shutil.which("node")), patch.object(startup, "PYTHON", sys.executable):
            old = read(startup.prepare_service(self.flow, self.root / "old-stage")["plan"])
            (source / "rehearsal_agent.py").write_text("# changed approved runtime\n")
            new = read(startup.prepare_service(self.flow, self.root / "new-stage")["plan"])
        self.assertNotEqual(old["shared"], new["shared"])
        self.assertNotEqual(old["outbox"], new["outbox"])
        self.assertNotEqual((Path(old["stage"]) / "rehearsal_agent.py").read_bytes(),
                            (Path(new["stage"]) / "rehearsal_agent.py").read_bytes())

    def test_changed_entry_can_pause_and_prepare_removal_of_old_service(self):
        with patch.object(startup, "HERE", self.root / "different-version"):
            with self.assertRaises(OSError):
                startup.service(self.flow)
            self.assertTrue(startup.pause(self.flow, True)["paused"])
            plan = startup.removal_plan(self.flow, self.root / "remove.json")
        self.assertEqual(read(plan["plan"])["service_sha256"], self.service_sha)

    def test_upgrade_waits_for_test_account_stopped_receipt(self):
        stage = self.root / "replacement"
        stage.mkdir()
        write(stage / "service.json", {**self.config, "version": "replacement"})
        shared = self.root / "new-shared"
        plan = {"action": "enable-test-startup", "repo": self.flow.repo.name,
                "state_root": str(self.flow.state.parents[1]), "stage": str(stage), "shared": str(shared),
                "outbox": str(self.root / "new-results"), "uid": os.getuid(), "account": startup.ACCOUNT,
                "service_sha256": digest((stage / "service.json").read_bytes()),
                "files": {"service.json": digest((stage / "service.json").read_bytes())}}
        with patch.object(startup, "approve", return_value=plan):
            with self.assertRaisesRegex(WorkflowError, "尚未确认停止"):
                startup.enable(self.flow, self.plan, self.ask)
            self.assertFalse(shared.exists())
            agent.save(self.outbox / "service-status.json", {"state": "stopping", "uid": os.getuid(),
                       "service_sha256": self.service_sha}, public=True)
            running = (str(self.shared / "rehearsal_agent.py") + " run").encode()
            with patch.object(startup.subprocess, "run", return_value=Mock(stdout=running)), \
                 self.assertRaisesRegex(WorkflowError, "仍在退出"):
                startup.enable(self.flow, self.plan, self.ask)
            with patch.object(startup.subprocess, "run", return_value=Mock(stdout=b"")):
                startup.enable(self.flow, self.plan, self.ask)
        self.assertTrue(shared.is_dir())
        self.assertTrue(self.shared.is_dir())


if __name__ == "__main__":
    unittest.main()
