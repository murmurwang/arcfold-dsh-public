"""Exercise release recovery with synthetic packages and an in-memory registry."""
import copy
import json
from pathlib import Path
import tempfile
import importlib.util
import io
import tarfile
import unittest
from unittest.mock import patch

from common import WorkflowError, digest, locked, read, write
from collab import answer, create_ask, pending_writes, progress
from release import REHEARSAL_CHECKS, release, verify_isolated
import release_candidates as candidates
from workflow import Workflow, decision_note, release_notes

REPO = "example/arcfold"
VERSION = "0.6.0"
BASE, FIRST, SECOND = (letter * 40 for letter in "abc")


class Remote:
    name = REPO

    def __init__(self):
        self.head = FIRST
        self.refs, self.releases, self.writes = [], [], []
        self.packages = {name: {"exists": False, "ever_published": False} for name in candidates.PACKAGES}
        self.fail_tag = False

    def main(self):
        return self.head

    def api(self, path, value=None, **options):
        if value is not None:
            self.writes.append((path, value))
            if path == "/git/refs":
                if self.fail_tag:
                    raise WorkflowError("synthetic unknown tag write")
                row = {"ref": value["ref"], "object": {"type": "commit", "sha": value["sha"]}}
                self.refs.append(row)
                return copy.deepcopy(row)
            if path == "/releases":
                row = {**value, "id": 1, "assets": [], "html_url": "https://example.invalid/release"}
                self.releases.append(row)
                return copy.deepcopy(row)
            raise AssertionError(path)
        if path.startswith("/git/matching-refs/"):
            return copy.deepcopy(self.refs)
        if path.startswith("/releases?"):
            return copy.deepcopy(self.releases)
        if path == "/releases/1":
            return copy.deepcopy(self.releases[0])
        if path.startswith("/compare/"):
            return {"status": "ahead", "merge_base_commit": {"sha": FIRST}}
        raise AssertionError(path)

    def gh(self, *args, **options):
        self.writes.append(args)
        if args[:2] == ("release", "upload"):
            path = Path(args[3])
            self.releases[0]["assets"].append({"name": path.name, "digest": "sha256:" + digest(path.read_bytes())})
        elif args[:2] == ("release", "edit"):
            self.releases[0]["draft"] = False
        else:
            raise AssertionError(args)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = Remote()
        self.flow = Workflow(self.repo, self.root / "state")
        network = patch("release_candidates.npm_state", side_effect=lambda n, v: copy.deepcopy(self.repo.packages[n]))
        network.start()
        self.addCleanup(network.stop)
        builder = patch("release.prepare", side_effect=self.build)
        builder.start()
        self.addCleanup(builder.stop)

    def merged(self, source=FIRST, base=BASE, prior=None, requirement=False):
        info = {"version": VERSION, "notes": "synthetic change", "engines_dsh": "0.2.2-rc.1", "requirements": []}
        if prior:
            info.update(repair_of=prior["id"], repair_reason="补齐随包材料")
        target = {"repo": REPO, "pr": 1 if source == FIRST else 2, "head": source, "base": base,
                  "tree": source, "decision": "original" if source == FIRST else "repair",
                  "ci": {"id": 1}, "release": info}
        return {"phase": "confirmed", "source": source, "target": target, "review_sha256": digest(source.encode()),
                "review_comment": "https://example.invalid/review", "release_requirements_confirmed": True,
                "release_requirements": [{"title": "许可", "description": "补齐材料", "evidence": ["synthetic"]}]
                                        if requirement else []}

    def build(self, flow, directory, version, merge, candidate=None):
        directory.mkdir(parents=True, exist_ok=True)
        packages = []
        for name in candidates.PACKAGES:
            content = (name + merge["source"]).encode()
            filename = name.split("/")[-1] + ".tgz"
            (directory / filename).write_bytes(content)
            packages.append({"name": name, "version": version, "file": filename, "sha256": digest(content),
                             "integrity": "sha512-synthetic-" + digest(content), "bytes": len(content)})
        receipt = {"version": version, "source": merge["source"], "review_sha256": merge["review_sha256"],
                   "target": merge["target"], "engines_dsh": "0.2.2-rc.1", "reproduced": True,
                   "packages": packages, "release_notes": "synthetic", "candidate": candidate,
                   "builder_recipe": candidates.build_recipe()}
        for filename, key in (("build-manifest.json", "build_manifest_sha256"), ("npm-dry-run.json", "npm_dry_run_sha256"),
                              ("dependency-lock.json", "dependency_lock_sha256")):
            (directory / filename).write_bytes(b"{}")
            receipt[key] = digest(b"{}")
        write(directory / "release.json", receipt)
        return receipt

    def candidate(self, requirement=False):
        row = candidates.register_merge(self.flow, self.merged(requirement=requirement))
        release(self.flow, VERSION, True, False, None)
        return row

    def receipt(self, row):
        return read(candidates.artifacts(self.flow, row) / "release.json")

    def proof(self, row, outcome="pass"):
        return {"candidate": row["id"], "source": row["source"], "account": "arcfold-test", "host": "0.2.2-rc.1",
                "older": "0.5.1", "newer": VERSION,
                "packages": {p["name"]: p["sha256"] for p in self.receipt(row)["packages"]},
                "checks": {check: {"status": outcome, "evidence": check + ".json"} for check in REHEARSAL_CHECKS}}

    def evidence(self, row, outcome="pass", requirement_outcome="pass"):
        path = self.root / (row["id"] + "-" + outcome + ".json")
        write(path, self.proof(row, outcome))
        return candidates.record_evidence(self.flow, VERSION, row["id"], {
            "candidate": row["id"], "source": row["source"], "packages": self.proof(row)["packages"],
            "requirements": {r["id"]: {"status": requirement_outcome, "evidence": "synthetic-inventory.json"}
                             for r in row["requirements"]}, "isolated": str(path)})

    def approval(self, row):
        ask = create_ask(self.flow, {"kind": "approve", "title": "发布实际候选", "body": "synthetic publication",
            "binds": {"repo": REPO, "version": VERSION, "candidate": row["id"], "packages": self.proof(row)["packages"]}})
        answer(self.flow, ask["id"], "yes", "批准测试请求")
        return ask["id"]

    def repair(self, first):
        merge = self.merged(SECOND, FIRST, first)
        candidates.check_repair(self.flow, merge["target"]["release"], FIRST)
        self.repo.head = SECOND
        second = candidates.register_merge(self.flow, merge)
        release(self.flow, VERSION, True, False, None)
        return second

    def test_failed_candidate_repaired_same_version_preserves_packages_and_every_receipt(self):
        first = self.candidate(requirement=True)
        failed = self.evidence(first, "fail")
        old_directory = candidates.artifacts(self.flow, first)
        old_files = {p.name: p.read_bytes() for p in old_directory.iterdir() if p.is_file()}
        old_merge = (self.flow.state / "merges" / (VERSION + ".json")).read_bytes()
        second = self.repair(first)
        self.assertEqual((first["number"], second["number"], second["replaces"]), (1, 2, first["id"]))
        self.assertEqual(old_merge, (self.flow.state / "merges" / (VERSION + ".json")).read_bytes())
        self.assertEqual(old_files, {p.name: p.read_bytes() for p in old_directory.iterdir() if p.is_file()})
        self.assertEqual(read(Path(failed["record"]))["isolated_result"]["checks"]["fresh_install"]["status"], "fail")
        self.assertEqual(second["decisions"], ["original", "repair"])
        self.evidence(second)
        result = release(self.flow, VERSION, False, True, None, second["id"], self.approval(second))
        self.assertEqual(result["github"]["phase"], "published")
        self.assertEqual(self.repo.refs[0]["object"]["sha"], SECOND)

    def test_retries_reuse_candidate_and_do_not_select_an_old_candidate_again(self):
        first = self.candidate()
        again = candidates.register_merge(self.flow, self.merged())
        self.assertEqual(first, again)
        second = self.repair(first)
        candidates.register_merge(self.flow, self.merged())
        self.assertEqual(candidates.current(self.flow, VERSION)[1]["id"], second["id"])
        with self.assertRaisesRegex(WorkflowError, "被取代"):
            candidates.check_repair(self.flow, self.merged(SECOND, FIRST, first)["target"]["release"], FIRST)

    def test_missing_source_reference_and_unrelated_base_are_refused(self):
        first = self.candidate()
        with self.assertRaisesRegex(WorkflowError, "引用原候选"):
            candidates.check_repair(self.flow, {"version": VERSION}, FIRST)
        self.repo.api = lambda *args, **kwargs: {"status": "diverged"}
        with self.assertRaisesRegex(WorkflowError, "不包含"):
            candidates.check_repair(self.flow, self.merged(SECOND, BASE, first)["target"]["release"], BASE)

    def test_ordinary_release_never_writes_remote_and_requirements_gate_publication(self):
        row = self.candidate(requirement=True)
        self.evidence(row, requirement_outcome="unconfirmed")
        result = release(self.flow, VERSION, False, False, None)
        self.assertEqual(result["pending"], ["许可"])
        with self.assertRaisesRegex(WorkflowError, "仍有待办"):
            release(self.flow, VERSION, False, True, None, row["id"], self.approval(row))
        self.assertEqual(self.repo.writes, [])

    def test_publication_requires_explicit_candidate_and_matching_authorization(self):
        first = self.candidate()
        old_approval = self.approval(first)
        second = self.repair(first)
        self.evidence(second)
        with self.assertRaisesRegex(WorkflowError, "显式指定"):
            release(self.flow, VERSION, False, True, None)
        with self.assertRaisesRegex(WorkflowError, "授权须绑定"):
            release(self.flow, VERSION, False, True, None, second["id"], old_approval)
        with self.assertRaisesRegex(WorkflowError, "另一候选"):
            verify_isolated(self.proof(first), {**self.receipt(first), "candidate": second["id"]})
        self.assertEqual(self.repo.writes, [])

    def test_remote_tag_and_draft_and_either_npm_package_freeze_the_version(self):
        row = self.candidate()
        info = self.merged(SECOND, FIRST, row)["target"]["release"]
        self.repo.releases = [{"tag_name": "v" + VERSION, "draft": True}]
        with self.assertRaisesRegex(WorkflowError, "不能同版修补"):
            candidates.check_repair(self.flow, info, FIRST)
        self.repo.releases = []
        with self.assertRaisesRegex(WorkflowError, "删除远端"):
            candidates.check_repair(self.flow, info, FIRST)
        self.assertEqual(self.repo.writes, [])

    def test_tag_or_single_npm_package_prevents_same_version_merge_before_any_write(self):
        first = self.candidate()
        merge = self.merged(SECOND, FIRST, first)
        self.repo.refs = [{"ref": "refs/tags/v" + VERSION, "object": {"type": "commit", "sha": FIRST}}]
        pr = {"state": "open", "draft": False, "head": {"sha": SECOND},
              "base": {"sha": FIRST, "ref": "main", "repo": {"full_name": REPO}}}
        receipt = {"target": merge["target"], "sha256": "synthetic", "review": {"result": {"release_requirements": []}}}
        with patch.object(self.repo, "pr", return_value=pr, create=True), \
                patch.object(self.flow, "verify_receipt", return_value=(receipt, {"url": "synthetic"})):
            with self.assertRaisesRegex(WorkflowError, "不能同版修补"):
                self.flow.merge(2)
        self.assertEqual(self.repo.writes, [])
        self.repo.refs = []
        self.repo.packages[candidates.PACKAGES[1]] = {"exists": True, "ever_published": True, "integrity": "synthetic"}
        with self.assertRaisesRegex(WorkflowError, "不能同版修补"):
            candidates.check_repair(self.flow, merge["target"]["release"], FIRST)

    def test_remote_query_failure_is_not_absence(self):
        first = self.candidate()
        with patch("release_candidates.npm_state", side_effect=WorkflowError("查询失败")):
            with self.assertRaisesRegex(WorkflowError, "查询失败"):
                candidates.check_repair(self.flow, self.merged(SECOND, FIRST, first)["target"]["release"], FIRST)
        self.assertEqual(self.repo.writes, [])

    def test_unknown_write_can_only_be_reconciled_with_bound_evidence_and_absent_remote(self):
        row = self.candidate()
        self.evidence(row)
        ask = self.approval(row)
        self.repo.fail_tag = True
        with self.assertRaisesRegex(WorkflowError, "unknown tag"):
            release(self.flow, VERSION, False, True, None, row["id"], ask)
        self.assertTrue(candidates.frozen_reasons(self.flow, VERSION))

        records = candidates.journal_records(self.flow, VERSION)
        document = {"outcome": "no_write", "evidence": "operator checked request completion and remote history",
                    "journals": {r["file"]: r["sha256"] for r in records}}
        with self.assertRaisesRegex(WorkflowError, "绑定全部"):
            candidates.reconcile(self.flow, VERSION, {**document, "journals": {}})
        candidates.reconcile(self.flow, VERSION, document)
        self.assertFalse(candidates.frozen_reasons(self.flow, VERSION))
        self.assertEqual(pending_writes(self.flow.state), [])
        self.assertEqual(candidates.publication_record(self.flow, row, "github.json"), {})
        with self.assertRaisesRegex(WorkflowError, "unknown tag"):
            release(self.flow, VERSION, False, True, None, row["id"], ask)
        # The old no-write conclusion must not exempt a later identical operation.
        self.assertTrue(candidates.frozen_reasons(self.flow, VERSION))
        self.assertTrue(pending_writes(self.flow.state))

    def test_observed_tag_remains_frozen_when_later_registry_query_fails_then_tag_is_deleted(self):
        row = self.candidate()
        self.repo.refs = [{"ref": "refs/tags/v" + VERSION, "object": {"type": "commit", "sha": FIRST}}]
        with patch("release_candidates.npm_state", side_effect=WorkflowError("synthetic registry failure")):
            with self.assertRaisesRegex(WorkflowError, "registry failure"):
                candidates.probe(self.flow, VERSION)
        self.repo.refs = []
        with self.assertRaisesRegex(WorkflowError, "删除远端"):
            candidates.check_repair(self.flow, self.merged(SECOND, FIRST, row)["target"]["release"], FIRST)

    def test_partial_npm_publication_only_resumes_the_same_artifacts(self):
        row = self.candidate()
        self.evidence(row)
        ask = self.approval(row)
        release(self.flow, VERSION, False, True, None, row["id"], ask)
        candidates.npm_publication(self.flow, VERSION, row["id"], ask, True)
        with self.assertRaisesRegex(WorkflowError, "结果未知"):
            candidates.npm_publication(self.flow, VERSION, row["id"], ask, True)
        packages = self.receipt(row)["packages"]
        self.repo.packages[packages[0]["name"]] = {"exists": True, "ever_published": True, "integrity": packages[0]["integrity"]}
        self.assertEqual(candidates.npm_publication(self.flow, VERSION, row["id"])["phase"], "partial")
        with self.assertRaisesRegex(WorkflowError, "不能同版修补"):
            candidates.check_repair(self.flow, self.merged(SECOND, FIRST, row)["target"]["release"], FIRST)
        self.repo.packages[packages[1]["name"]] = {"exists": True, "ever_published": True, "integrity": "different"}
        with self.assertRaisesRegex(WorkflowError, "本候选不同"):
            candidates.npm_publication(self.flow, VERSION, row["id"])
        self.repo.packages[packages[1]["name"]]["integrity"] = packages[1]["integrity"]
        self.assertEqual(candidates.npm_publication(self.flow, VERSION, row["id"])["phase"], "published")

    def test_legacy_index_preserves_original_files_and_requires_explicit_audit(self):
        merge = self.merged()
        merge.pop("release_requirements_confirmed")
        write(self.flow.state / "merges" / (VERSION + ".json"), merge)
        root = candidates.folder(self.flow, VERSION)
        self.build(self.flow, root, VERSION, merge)
        before = {p: p.read_bytes() for p in self.flow.state.rglob("*") if p.is_file()}
        row = candidates.import_legacy(self.flow, VERSION)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertTrue(row["legacy"])
        self.assertTrue(any(r["source"] == "legacy-review" for r in row["requirements"]))
        self.assertEqual(candidates.import_legacy(self.flow, VERSION), row)
        self.assertEqual(candidates.artifacts(self.flow, row), root)

    def test_legacy_draft_continues_original_bytes_and_keeps_original_journals(self):
        merge = self.merged()
        write(self.flow.state / "merges" / (VERSION + ".json"), merge)
        root = candidates.folder(self.flow, VERSION)
        self.build(self.flow, root, VERSION, merge)
        write(root / "github.json", {"phase": "confirmed", "source": FIRST, "tag": "v" + VERSION})
        self.repo.refs = [{"ref": "refs/tags/v" + VERSION, "object": {"type": "commit", "sha": FIRST}}]
        from release import release_assets
        self.repo.releases = [{"id": 1, "tag_name": "v" + VERSION, "draft": True,
            "html_url": "https://example.invalid/legacy", "assets": [
                {"name": name, "digest": "sha256:" + sha} for name, sha in release_assets(root, read(root / "release.json")).items()]}]
        originals = {p: p.read_bytes() for p in root.iterdir() if p.is_file()}
        row = candidates.import_legacy(self.flow, VERSION)
        self.evidence(row)
        result = release(self.flow, VERSION, False, True, None, row["id"], self.approval(row))
        self.assertEqual(result["github"]["phase"], "published")
        self.assertEqual(len(self.repo.writes), 1)
        for path, content in originals.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(candidates.view(self.flow, VERSION)["candidates"][0]["github"]["phase"], "published")
        self.assertTrue(candidates.frozen_reasons(self.flow, VERSION))

    def test_build_failure_is_retained_and_retry_keeps_same_candidate(self):
        row = candidates.register_merge(self.flow, self.merged())
        with patch("release.prepare", side_effect=WorkflowError("synthetic build failure")):
            with self.assertRaisesRegex(WorkflowError, "synthetic build failure"):
                release(self.flow, VERSION, True, False, None)
        result = release(self.flow, VERSION, True, False, None)
        self.assertEqual(result["candidate"], row["id"])
        self.assertEqual(len(list((candidates.artifacts(self.flow, row) / "build-failures").glob("*.json"))), 1)

    def test_swapped_receipt_cannot_be_used_for_evidence_or_publication(self):
        row = self.candidate()
        source = candidates.artifacts(self.flow, row)
        write(source / "release.json", {**self.receipt(row), "source": SECOND})
        with self.assertRaisesRegex(WorkflowError, "候选源码"):
            self.evidence(row)
        self.assertEqual(self.repo.writes, [])

    def test_npm_begin_requires_explicit_candidate_and_rechecks_readiness_and_open_decisions(self):
        row = self.candidate()
        self.evidence(row)
        ask = self.approval(row)
        release(self.flow, VERSION, False, True, None, row["id"], ask)
        with self.assertRaisesRegex(WorkflowError, "显式指定"):
            candidates.npm_publication(self.flow, VERSION, None, ask, True)
        self.evidence(row, "fail")
        with self.assertRaisesRegex(WorkflowError, "仍有待办"):
            candidates.npm_publication(self.flow, VERSION, row["id"], ask, True)
        self.evidence(row)
        write(self.flow.state / "tasks/original/task.json", {"id": "original", "title": "original", "phase": "open"})
        create_ask(self.flow, {"kind": "decide", "title": "发布前变更待决定", "body": "synthetic change", "task": "original"})
        with self.assertRaisesRegex(WorkflowError, "决策尚待答复"):
            candidates.npm_publication(self.flow, VERSION, row["id"], ask, True)

    def test_changed_build_recipe_creates_new_candidate_without_changing_old_source(self):
        row = self.candidate()
        with self.assertRaisesRegex(WorkflowError, "没有变化"):
            candidates.rebuild(self.flow, VERSION, row["id"], "same inputs")
        with patch("release_candidates.build_recipe", return_value={"release.py": "changed"}):
            new = candidates.rebuild(self.flow, VERSION, row["id"], "builder was repaired")
        self.assertEqual(new["source"], row["source"])
        self.assertNotEqual(new["id"], row["id"])
        self.assertTrue((candidates.artifacts(self.flow, row) / "release.json").is_file())

    def test_version_lock_refuses_competing_writer_without_overwriting_index(self):
        row = self.candidate()
        path = candidates.folder(self.flow, VERSION) / "candidates.json"
        before = path.read_bytes()
        with locked(candidates.folder(self.flow, VERSION), "candidate"):
            with self.assertRaisesRegex(WorkflowError, "另一流程"):
                candidates.register_merge(self.flow, self.merged(SECOND, FIRST, row))
        self.assertEqual(path.read_bytes(), before)

    def test_registration_resumes_after_index_was_saved_but_merge_history_write_failed(self):
        save = candidates.once
        def interrupted(path, value):
            if path == self.flow.state / "merges" / (VERSION + ".json"):
                raise OSError("synthetic crash")
            return save(path, value)
        with patch("release_candidates.once", side_effect=interrupted):
            with self.assertRaises(OSError):
                candidates.register_merge(self.flow, self.merged())
        result = candidates.register_merge(self.flow, self.merged())
        self.assertEqual(len(candidates.index(self.flow, VERSION)["candidates"]), 1)
        self.assertEqual(read(self.flow.state / "merges" / (VERSION + ".json")), result["merge"])
        self.assertTrue((self.flow.state / "merges" / VERSION / (FIRST + ".json")).is_file())

    def test_submitted_repair_prevents_publishing_original_candidate_while_fix_is_pending(self):
        row = self.candidate()
        self.evidence(row)
        info = self.merged(SECOND, FIRST, row)["target"]["release"]
        candidates.begin_repair(self.flow, info, "repair", SECOND)
        candidates.begin_repair(self.flow, info, "repair", SECOND)
        self.assertEqual(len(list((candidates.folder(self.flow, VERSION) / "candidates" / row["id"] / "repairs").glob("*.json"))), 1)
        with self.assertRaisesRegex(WorkflowError, "等待替代候选"):
            release(self.flow, VERSION, False, True, None, row["id"], self.approval(row))
        self.assertEqual(self.repo.writes, [])

    def test_repair_rechecks_publication_after_acquiring_the_candidate_lock(self):
        row = self.candidate()
        self.evidence(row)
        info = self.merged(SECOND, FIRST, row)["target"]["release"]
        candidates.check_repair(self.flow, info, FIRST)
        release(self.flow, VERSION, False, True, None, row["id"], self.approval(row))
        with self.assertRaisesRegex(WorkflowError, "不能同版修补"):
            candidates.begin_repair(self.flow, info, "repair", SECOND)
        self.assertFalse(list((candidates.artifacts(self.flow, row) / "repairs").glob("*.json")))

    def test_release_metadata_requires_bound_equal_version_repair_and_rejects_downgrade(self):
        core = {"version": VERSION, "engines": {"dsh": "0.2.2-rc.1"}}
        lock = {"version": VERSION, "packages": {"": {"version": VERSION}}}
        def blob(path, commit, name):
            if name == "CHANGELOG.md":
                return ("## " + VERSION + "\nFixed.\n").encode()
            return json.dumps(lock if name == "package-lock.json" else core).encode()
        fields = {"fixed_in": VERSION}
        with patch("workflow.blob", side_effect=blob):
            with self.assertRaisesRegex(WorkflowError, "引用原候选"):
                release_notes(None, SECOND, FIRST, ["src/a.mjs", "CHANGELOG.md"], fields)
            fields.update(repair_of="d" * 64, repair_reason="fixed")
            self.assertEqual(release_notes(None, SECOND, FIRST, ["CHANGELOG.md"], fields)["repair_of"], "d" * 64)
        def downgrade(path, commit, name):
            return json.dumps({"version": "0.7.0"}).encode() if commit == FIRST else blob(path, commit, name)
        with patch("workflow.blob", side_effect=downgrade):
            with self.assertRaisesRegex(WorkflowError, "不能低于"):
                release_notes(None, SECOND, FIRST, ["CHANGELOG.md"], fields)

    def test_same_version_rehearsals_use_different_kits_and_reject_old_package_bytes(self):
        spec = importlib.util.spec_from_file_location("candidate_rehearsal_prepare", Path(__file__).parent / "rehearsal/prepare.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        def bundle(folder, version, content, identity):
            folder.mkdir()
            rows = []
            for name in candidates.PACKAGES:
                path = folder / (name.split("/")[-1] + ".tgz")
                files = {"package.json": json.dumps({"name": name, "version": version}).encode(), "entry.js": content}
                with tarfile.open(path, "w:gz") as archive:
                    for filename, data in files.items():
                        entry = tarfile.TarInfo("package/" + filename)
                        entry.size = len(data)
                        archive.addfile(entry, io.BytesIO(data))
                rows.append({"name": name, "file": path.name, "sha256": digest(path.read_bytes()), "integrity": "synthetic"})
            write(folder / "release.json", {"version": version, "source": FIRST, "candidate": identity, "packages": rows})
            write(folder / "dependency-lock.json", {"packages": {}})
        old, first, second = (self.root / name for name in ("old", "first", "second"))
        bundle(old, "0.5.1", b"old", "1" * 64)
        bundle(first, VERSION, b"first", "2" * 64)
        bundle(second, VERSION, b"second", "3" * 64)
        one = module.prepare(old, first, self.root / "kit-one", self.root)
        two = module.prepare(old, second, self.root / "kit-two", self.root)
        self.assertNotEqual(one["id"], two["id"])
        self.assertEqual(read(self.root / "kit-two/bundle.json")["release_candidate"], "3" * 64)
        (second / "dsh.tgz").write_bytes((first / "dsh.tgz").read_bytes())
        with self.assertRaisesRegex(WorkflowError, "演练包与发行记录不符"):
            module.prepare(old, second, self.root / "kit-three", self.root)

    def test_candidate_view_and_progress_are_read_only_and_stop_pointing_to_old_release(self):
        row = self.candidate()
        second = self.repair(row)
        write(self.flow.state / "tasks/original/task.json", {"id": "original", "title": "original", "phase": "open"})
        write(self.flow.state / "tasks/original/submit.json", {"phase": "confirmed", "pr": 1})
        write(self.flow.state / "prs/1/merge-attempt.json", self.merged())
        before = {p: p.read_bytes() for p in self.flow.state.rglob("*") if p.is_file()}
        with patch.object(self.repo, "api", side_effect=AssertionError("no network in next")):
            view = candidates.view(self.flow, VERSION)
            status = progress(self.flow)["tasks"][0]
        self.assertEqual(view["active"], second["id"])
        self.assertIn("取代", status["next"])
        self.assertNotIn("release --version", status["next"])
        self.assertEqual(before, {p: p.read_bytes() for p in self.flow.state.rglob("*") if p.is_file()})


if __name__ == "__main__":
    unittest.main()
