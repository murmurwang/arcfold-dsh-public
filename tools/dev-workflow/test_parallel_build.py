from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from common import WorkflowError, digest, git, git_line, locked, read, write
import execution
import parallel_build
import release
from workflow import COMPATIBLE_DSH, Workflow


class LocalRemote:
    name = "example/arcfold"

    def __init__(self, source, tip):
        self.source, self.tip = source, tip

    def main(self):
        return self.tip

    def fetch(self, path):
        git(self.source, "clone", "--quiet", "--no-hardlinks", str(self.source), str(path))
        git(path, "update-ref", "refs/arcfold/main", self.tip)

    def api(self, path):
        before, after = path.removeprefix("/compare/").split("...")
        base = git_line(self.source, "merge-base", before, after)
        return {"status": "ahead" if base == before else "diverged", "merge_base_commit": {"sha": base}}


class ParallelBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "repository"
        self.source.mkdir()
        git(self.source, "init", "--quiet")
        git(self.source, "config", "user.name", "Synthetic fixture")
        git(self.source, "config", "user.email", "fixture@example.invalid")
        for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            write(self.source / name, b"synthetic\n")
        git(self.source, "add", ".")
        git(self.source, "commit", "--quiet", "-m", "accepted fixture")
        self.accepted = git_line(self.source, "rev-parse", "HEAD")
        self.tree = git_line(self.source, "rev-parse", "HEAD^{tree}")
        write(self.source / "later.json", {"another": "delivery"})
        git(self.source, "add", ".")
        git(self.source, "commit", "--quiet", "-m", "later fixture")
        self.later = git_line(self.source, "rev-parse", "HEAD")
        self.remote = LocalRemote(self.source, self.accepted)
        self.flow = Workflow(self.remote, self.root / "state")
        self.folder = self.flow.state / "releases/0.6.0"
        self.merge = {"phase": "confirmed", "source": self.accepted, "review_sha256": "b" * 64,
                      "review_comment": "https://example.invalid/review", "target": {
                          "tree": self.tree, "ci": {"head": self.accepted},
                          "release": {"version": "0.6.0", "engines_dsh": COMPATIBLE_DSH, "notes": "synthetic"}}}
        write(self.flow.state / "merges/0.6.0.json", self.merge)
        self.starts, self.barrier, self.proceed = [], None, None
        self.guard = threading.Lock()
        self.install_paths = []
        for name, callback in (("install_dependencies", self.install), ("python_archive", self.archive),
                               ("build", self.build), ("verify_package", lambda *a: {"verified": "synthetic"})):
            mock = patch("release." + name, side_effect=callback)
            mock.start()
            self.addCleanup(mock.stop)

    def install(self, checkout, env):
        self.install_paths.append((str(checkout), env["npm_config_cache"]))
        (checkout / "node_modules").mkdir()

    def archive(self, source, local, env):
        path = local / "archive.tar.gz"
        write(path, b"synthetic archive")
        return path

    def build(self, source, folder, kind, version, archive, env):
        with self.guard:
            self.starts.append(str(source))
        if self.barrier:
            self.barrier.wait(timeout=5)
            self.proceed.wait(timeout=5)
        rows = []
        for name in ("@arcfold/dsh", "@arcfold/dsh-method-ui"):
            data = (name + " fixture").encode()
            file = name.replace("/", "-") + ".tgz"
            write(folder / file, data)
            rows.append({"name": name, "version": version, "file": file, "sha256": digest(data),
                         "integrity": "sha512-synthetic", "bytes": len(data)})
        write(folder / "dependency-lock.json", {"packages": {}})
        return {"packages": rows, "source": {"commit": git_line(source, "rev-parse", "HEAD"),
                                              "tree": git_line(source, "rev-parse", "HEAD^{tree}")}}

    def test_builds_overlap_without_main_lock_and_tip_can_advance(self):
        self.barrier, self.proceed = threading.Barrier(3), threading.Event()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(release.prepare, self.flow, self.folder, "0.6.0", self.merge)
            self.barrier.wait(timeout=5)
            with locked(self.flow.state, "main"):
                self.remote.tip = self.later
            self.proceed.set()
            receipt = future.result(timeout=5)
        self.assertEqual(receipt["source"], self.accepted)
        self.assertEqual(receipt["parallel_builds"], 2)
        self.assertEqual(len(set(p[0] for p in self.install_paths)), 2)
        self.assertEqual(len(set(p[1] for p in self.install_paths)), 2)
        release.verify_release(self.folder, receipt)
        self.assertEqual(execution.view(self.flow)["active"], [])
        before = len(self.starts)
        self.assertEqual(release.prepare(self.flow, self.folder, "0.6.0", self.merge), receipt)
        self.assertEqual(len(self.starts), before)

    def test_shared_pool_limits_nested_build_workers(self):
        occupied = execution.reserve_work(self.flow, "other/check", {"fixture": True}, maximum=1)
        receipt = release.prepare(self.flow, self.folder, "0.6.0", self.merge)
        self.assertEqual(receipt["parallel_builds"], 1)
        self.assertEqual([r["id"] for r in execution.view(self.flow)["active"]], [occupied["id"]])

    def test_selection_change_during_build_prevents_publication_ready_receipt(self):
        self.barrier, self.proceed = threading.Barrier(3), threading.Event()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(release.prepare, self.flow, self.folder, "0.6.0", self.merge)
            self.barrier.wait(timeout=5)
            write(self.flow.state / "merges/0.6.0.json", {**self.merge, "source": self.later})
            self.proceed.set()
            with self.assertRaisesRegex(WorkflowError, "来源已变化"):
                future.result(timeout=5)
        self.assertFalse((self.folder / "release.json").exists())
        self.assertEqual(execution.view(self.flow)["active"], [])
        failures = list((self.folder / "build-attempts").glob("*-result.json"))
        self.assertEqual(read(failures[0])["outcome"], "fail")

    def test_second_manifest_is_part_of_the_saved_proof(self):
        receipt = release.prepare(self.flow, self.folder, "0.6.0", self.merge)
        write(self.folder / "rebuild-manifest.json", {"changed": True})
        with self.assertRaisesRegex(WorkflowError, "第二次"):
            release.verify_release(self.folder, receipt)

    def test_removed_source_is_rejected_before_any_build(self):
        with patch.object(self.remote, "main", return_value="f" * 40), patch.object(self.remote, "api", return_value={
                "status": "diverged", "merge_base_commit": {"sha": "e" * 40}}), self.assertRaisesRegex(WorkflowError, "主线历史"):
            release.prepare(self.flow, self.folder, "0.6.0", self.merge)
        self.assertEqual(self.starts, [])
        self.assertEqual(execution.state(self.flow)["runs"], {})

    def test_legacy_publication_cannot_bypass_an_activated_candidate_index(self):
        release.prepare(self.flow, self.folder, "0.6.0", self.merge)
        write(self.folder / "candidates.json", {"active": "synthetic-new-candidate"})
        with self.assertRaisesRegex(WorkflowError, "旧发行入口"):
            release.release(self.flow, "0.6.0", False, False, None)
