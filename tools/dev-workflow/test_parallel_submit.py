from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from collab import align
from common import WorkflowError, git, git_line, write
from workflow import Workflow


class ParallelSubmitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "source"
        self.source.mkdir()
        git(self.source, "init", "--quiet")
        git(self.source, "config", "user.name", "Synthetic fixture")
        git(self.source, "config", "user.email", "fixture@example.invalid")
        write(self.source / "initial.txt", b"initial\n")
        git(self.source, "add", ".")
        git(self.source, "commit", "--quiet", "-m", "initial")
        self.base = git_line(self.source, "rev-parse", "HEAD")
        write(self.source / "other.txt", b"another delivery\n")
        git(self.source, "add", ".")
        git(self.source, "commit", "--quiet", "-m", "other accepted change")
        self.main = git_line(self.source, "rev-parse", "HEAD")
        self.remote = self.root / "remote.git"
        git(self.root, "clone", "--bare", "--quiet", str(self.source), str(self.remote))
        git(self.source, "switch", "--detach", self.base)
        self.repo = Mock()
        self.repo.name, self.repo.owner, self.repo.url = "example/arcfold", "example", str(self.remote)
        self.repo.main.return_value = self.main
        self.repo.fetch.side_effect = self.fetch
        self.repo.api.side_effect = self.api
        self.flow = Workflow(self.repo, self.root / "state")
        self.flow.new({"id": "draft-work", "title": "Draft fixture", "authorization_ref": "synthetic", 
                       "scope": ["tools/dev-workflow/", "docs/notes/draft-work.md"], "observed_in_version": "0.5.1"})
        path, row = self.flow.task("draft-work")
        note = path / "decision.md"
        note.write_text(note.read_text().replace("[TBD]", "合成检查"))
        align(self.flow, "draft-work", "合成确认")
        row.update(phase="open", base=self.base, checkout=str(self.source), branch="arcfold/draft-work",
                   decision_sha256=self.flow.check("draft-work")["sha256"])
        write(path / "task.json", row)
        write(self.source / "docs/notes/draft-work.md", note.read_bytes())
        write(self.source / "tools/dev-workflow/fixture.txt", b"draft\n")
        git(self.source, "add", ".")
        git(self.source, "commit", "--quiet", "-m", "independent candidate")
        self.head = git_line(self.source, "rev-parse", "HEAD")
        self.pr = {"number": 7, "state": "open", "draft": True, "html_url": "https://example.invalid/pull/7",
                   "body": "Decision: docs/notes/draft-work.md\n", "head": {"sha": self.head},
                   "base": {"sha": self.main, "ref": "main", "repo": {"full_name": self.repo.name}}}
        self.repo.pr.return_value = self.pr

    def fetch(self, checkout, number=None):
        if not checkout.exists():
            git(self.root, "clone", "--quiet", str(self.remote), str(checkout))
        git(checkout, "fetch", "--quiet", str(self.remote), "+refs/heads/*:refs/remotes/fixture/*")
        git(checkout, "update-ref", "refs/arcfold/main", self.main)
        if number:
            git(checkout, "update-ref", "refs/arcfold/pr", self.head)

    def api(self, path, data=None):
        return self.pr if path == "/pulls" else []

    def test_stale_base_can_submit_draft_and_prepare_but_cannot_final_review(self):
        result = self.flow.submit("draft-work")
        self.assertEqual(result["base"], self.base)
        self.assertTrue(result["needs_rebase"])
        self.assertEqual(git_line(self.remote, "rev-parse", "refs/heads/arcfold/draft-work"), self.head)
        with patch("workflow.command") as model:
            preview = self.flow.review_materials(7)
            self.assertTrue(preview["target"]["preparation_only"])
            self.assertTrue(Path(preview["material"]).is_file())
            with patch.object(self.flow, "completed_ci", return_value=({}, {})), self.assertRaisesRegex(WorkflowError, "当前 main"):
                self.flow.preflight(7)
            model.assert_not_called()
        self.assertFalse((self.flow.state / "prs/7" / (self.head + "-" + self.main) / "receipt.json").exists())

    def test_rewritten_starting_history_blocks_submit_before_push(self):
        git(self.source, "checkout", "--orphan", "unrelated")
        git(self.source, "commit", "--quiet", "-m", "unrelated base")
        self.main = git_line(self.source, "rev-parse", "HEAD")
        git(self.source, "push", "--quiet", str(self.remote), "HEAD:refs/heads/unrelated")
        git(self.source, "switch", "--detach", self.head)
        self.repo.main.return_value = self.main
        with self.assertRaises(WorkflowError):
            self.flow.submit("draft-work")
        self.assertEqual(git(self.remote, "for-each-ref", "refs/heads/arcfold/draft-work"), b"")
