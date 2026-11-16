"""Managed workflow from issue registration to a verified main commit."""
from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys
import uuid

from common import Repository, WorkflowError, canonical, command, digest, git, git_line, locked, read, require, timestamp, write

HERE = Path(__file__).resolve().parent
WORKFLOW = ".github/workflows/desktop-checks.yml"
CI_STEPS = ("核对检查使用的提交", "在独立副本运行 Desktop 模拟检查", "运行工作流检查")
DESKTOP_RESULT = re.compile(r"^(?:[✔✖﹣] .+ \([0-9.]+ms\)|ℹ (?:tests|pass|fail|cancelled|skipped|todo) [0-9]+)$")
WORKFLOW_RESULT = re.compile(
    r"^(?:test_\w+ \([\w.]+\) \.\.\. (?:ok|FAIL|ERROR|skipped .+)|Ran [0-9]+ tests? in [0-9.]+s|OK(?: \(.+\))?)$"
)
COMPATIBLE_DSH = "0.2.2-rc.1"
ID = r"[a-z0-9][a-z0-9-]{2,63}"
SHA = r"[a-f0-9]{40}"
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
SECTIONS = (
    "Source", "Problem", "Proposal", "Expected outcome", "Alternatives considered", "Acceptance criteria", "Risks",
)
# New decisions use the Chinese template. Records registered before it keep the English headings.
SECTIONS_ZH = ("来源", "问题", "方案", "预期效果", "考虑过的其他做法", "验收标准", "风险")
TITLE_PREFIXES = ("# 决策：", "# Agent Note: ")
OUTCOMES = ("pass", "fail", "unconfirmed")
RELEASE_PATHS = ("src/", "packages/", "runtime/", "presets/", "patches/", "cordis.patch.yml",
                 "package.json", "scripts/package-release.mjs", "package-lock.json", "bin/")
SECRET = re.compile(
    rb"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:sk-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{16,}\b"
    rb"|\bnpm_[A-Za-z0-9]{36}\b"
    rb"|(?i:\b(?:api[_-]?key|access[_-]?token|password|secret|token)[\"']?\s*[:=]\s*[\"'][A-Za-z0-9_-]{12,}[\"'])"
)
PERSONAL_PATH = re.compile(rb"/(?:Users|home)/[^/\s'\"]+/|codex:" rb"//|/private/" rb"var/folders/")
FIXTURES = {
    "test/deepseek-transport.test.mjs": (b"fake-secret-never-use-real",),
    "test/model-settings-ui.test.mjs": (b"must-not-be-retained", b"fixture-secret-must-never-display"),
    "test/native-openai-flow.test.mjs": (b"sk-" + b"fixture-native-openai-not-a-real-key",),
    "test/openai-provider.test.mjs": (b"sk-" + b"fixture-only-not-real",),
    "test/openai-transport.test.mjs": (b"sk-" + b"fixture-not-real",),
    "test/openai-usage.test.mjs": (b"synthetic-not-real",),
    "test/pi-ai-transport-patch.test.mjs": (b"sk-" + b"fixture-only-not-real",),
    "test/provider-patch.test.mjs": (b"test-only-not-a-secret", b"fixture-credential"),
    "test/release-package.test.mjs": (b"/" + b"Users/example/research/private",),
    "test/runtime-config.test.mjs": (b"not-a-real-key",),
    "test/tree-domain.test.mjs": (b"/" + b"Users/private/name.txt",),
}


def actor():
    # A contribution label is for provenance only. It never grants review authority.
    return os.getenv("ARCFOLD_AGENT_ID") or os.getenv("CODEX_THREAD_ID") or getpass.getuser()


def task_id(value):
    require(isinstance(value, str) and re.fullmatch(ID, value), "问题编号使用 3 至 64 个小写字母、数字或连字符。")
    return value


def text_field(value, label):
    require(isinstance(value, str) and value.strip() and "[TBD]" not in value, f"缺少有效的 {label}。")
    return value.strip()


def decision_note(raw):
    text = re.sub(r"<!--.*?-->", "", raw.decode(), flags=re.S)
    text = re.sub(r"(?ms)^ {0,3}(```+|~~~+)[^\n]*\n.*?^ {0,3}\1[ \t]*$", "", text)
    prefix = next((value for value in TITLE_PREFIXES if text.startswith(value)), None)
    require(prefix and "\nStatus: proposed\n" in text, "决策记录标题或状态不符合模板。")
    header, _, body = text.partition("\n## ")
    fields = {}
    for key in ("observed_in_version", "fixed_in", "user_verified"):
        values = re.findall(rf"(?m)^{key}: ([^\n]+)$", header)
        require(len(values) == 1, f"决策记录必须填写唯一的 {key}。")
        fields[key] = text_field(values[0], key)
    require(fields["fixed_in"] == "pending" or re.fullmatch(VERSION, fields["fixed_in"]), "fixed_in 须为发行版本或 pending。")
    require(fields["user_verified"] == "pending", "候选中的用户验收字段须为 pending，实际观察通过 close-loop 登记。")
    sections = {}
    for section in re.split(r"(?m)^## ", body):
        heading, _, contents = section.partition("\n")
        require(heading not in sections, f"决策章节重复 {heading}。")
        sections[heading] = contents
    names = SECTIONS_ZH if SECTIONS_ZH[0] in sections else SECTIONS
    for name in names:
        text_field(sections.get(name), name)
    criteria = re.findall(r"(?m)^- (.+)$", sections[names[5]])
    require(criteria and len(set(criteria)) == len(criteria), "验收标准至少需要一条独立的检查项。")
    return {"title": text.splitlines()[0].removeprefix(prefix), "criteria": criteria, **fields}


def registered_scope(scope):
    require(isinstance(scope, list) and scope and all(
        isinstance(path, str) and "\\" not in path and not path.startswith("/") and
        all(part not in ("", ".", "..") for part in path.rstrip("/").split("/"))
        for path in scope
    ) and len(set(scope)) == len(scope), "源码范围要用互异的相对路径，目录以 / 结尾。")
    return scope


def inside_scope(path, scope):
    return any(path == allowed or allowed.endswith("/") and path.startswith(allowed) for allowed in scope)


def scan(name, data):
    checked = data
    for literal in FIXTURES.get(name, ()):
        checked = checked.replace(literal, b"synthetic")
    require(not SECRET.search(checked), f"{name} 含疑似密钥，先核查。")
    require(not PERSONAL_PATH.search(checked), f"{name} 含本机路径或会话链接，先核查。")


def blob(path, sha, name):
    return git(path, "show", f"{sha}:{name}")


def changed(path, base, head):
    return git(path, "diff", "--no-renames", "--name-status", "-z", base, head).decode().split("\0")[:-1]


def ci_review_record(ci, job, log):
    desktop, workflow = [], []
    for line in log.splitlines():
        label, step, stamped = (line.split("\t", 2) + ["", ""])[:3]
        if label != job["name"]:
            continue
        result = stamped.partition(" ")[2].strip()
        if step == CI_STEPS[1] and DESKTOP_RESULT.fullmatch(result):
            desktop.append(result)
        elif step == CI_STEPS[2] and WORKFLOW_RESULT.fullmatch(result):
            workflow.append(result)
    steps = {row["name"]: row["conclusion"] for row in job["steps"] if row["name"] in CI_STEPS}
    return {"run": ci, "job": {key: job[key] for key in ("id", "name", "conclusion", "html_url")}, "steps": steps,
            "desktop_results": desktop, "workflow_results": workflow}


def compact_lock_evidence(before_bytes, after_bytes):
    before, after = map(json.loads, (before_bytes, after_bytes))
    before_entries = {name: row for name, row in before["packages"].items() if name}
    after_entries = {name: row for name, row in after["packages"].items() if name}
    if before_entries != after_entries:
        return {}
    summary = {"path": "package-lock.json", "base_sha256": digest(before_bytes), "sha256": digest(after_bytes),
               "dependencies_unchanged": True, "entries_compared": len(after_entries),
               "before": before["packages"][""], "after": after["packages"][""]}
    comparisons = ["path\tversion\tintegrity\tbase_entry_sha256\thead_entry_sha256"]
    for name, row in sorted(after_entries.items()):
        comparisons.append("\t".join([
            name, row.get("version", ""), row.get("integrity", ""), digest(before_entries[name]), digest(row),
        ]))
    return {"review/lock-summary.json": json.dumps(summary, ensure_ascii=False, indent=2),
            "review/lock-entry-comparison.tsv": "\n".join(comparisons)}


def release_notes(path, head, base, paths, fields):
    affects_release = any(inside_scope(name, RELEASE_PATHS) for name in paths)
    version = fields["fixed_in"]
    if version == "pending":
        require(not affects_release, "影响运行或打包的改动须先登记发行版本和更新说明。")
        return None
    require("CHANGELOG.md" in paths, "版本改动缺少本次更新说明。")
    notes = blob(path, head, "CHANGELOG.md").decode()
    match = re.search(rf"(?ms)^## {re.escape(version)}[ \t]*\n(.+?)(?=^## |\Z)", notes)
    require(match and match[1].strip(), "更新记录中缺少版本号对应的说明。")
    previous = json.loads(blob(path, base, "package.json"))["version"]
    require(tuple(map(int, version.split("."))) > tuple(map(int, previous.split("."))), "发行版本须高于 main 中的版本。")
    core = json.loads(blob(path, head, "package.json"))
    ui = json.loads(blob(path, head, "packages/method-ui/package.json"))
    lockfile = json.loads(blob(path, head, "package-lock.json"))
    require(all(row["version"] == version for row in (core, ui, lockfile, lockfile["packages"][""])),
            "源码、锁文件、核心包和界面包的发行版本须一致。")
    require(core["engines"]["dsh"] == COMPATIBLE_DSH, "DSH 兼容范围变化，需要先完成宿主验证。")
    return {"version": version, "notes": match[1].strip(), "engines_dsh": core["engines"]["dsh"]}


class Workflow:
    def __init__(self, repo, state):
        self.repo = repo
        self.state = Path(state).expanduser().resolve() / repo.name

    def task(self, key):
        path = self.state / "tasks" / task_id(key)
        require((path / "task.json").is_file(), f"缺少问题 {key} 的入口登记。")
        return path, read(path / "task.json")

    def new(self, request):
        key = task_id(request["id"])
        title = text_field(request["title"], "问题标题")
        source = text_field(request["authorization_ref"], "问题来源")
        observed = text_field(request["observed_in_version"], "问题发生时的版本")
        require("\n" not in title and "\n" not in observed, "问题标题和发生版本分别使用一行。")
        scope = registered_scope(request["scope"])
        path = self.state / "tasks" / key
        with locked(self.state, "registration"):
            require(not path.exists(), "同编号已登记。")
            template = (HERE / "decision-template.md").read_text()
            write(path / "decision.md", template.format(title=title, observed=observed, source=source).encode())
            write(path / "task.json", {"id": key, "title": title, "scope": scope, "repository": self.repo.name,
                                       "contributors": [actor()], "phase": "draft", "created_at": timestamp()})
        return {"decision": str(path / "decision.md")}

    def check(self, key):
        path, record = self.task(key)
        raw = (path / "decision.md").read_bytes()
        fields = decision_note(raw)
        require(fields["title"] == record["title"], "决策标题与登记不一致。")
        return {"sha256": digest(raw), **fields}

    def start(self, key):
        path, _ = self.task(key)
        with locked(path, "task"):
            _, record = self.task(key)
            note = self.check(key)
            require(record["phase"] == "draft", "此任务已启动。先核对已登记的工作目录。")
            from collab import open_decisions, require_alignment
            require_alignment(self, key, note["sha256"])
            pending = open_decisions(self, key)
            require(not pending, f"本任务还有未答的决定单 {'、'.join(pending)}，先请开发者答复。")
            base = self.repo.main()
            record.update(base=base, decision_sha256=note["sha256"], phase="starting")
            write(path / "task.json", record)
            checkout = self.state / "workspaces" / key
            require(not checkout.exists(), "独立开发目录已存在。")
            self.repo.fetch(checkout)
            require(git_line(checkout, "rev-parse", "refs/arcfold/main") == base == self.repo.main(),
                    "main 已前进，重新取得开发基线。")
            branch = f"arcfold/{key}"
            git(checkout, "switch", "-c", branch, base)
            decision = checkout / "docs/notes" / f"{key}.md"
            write(decision, (path / "decision.md").read_bytes())
            decision.chmod(0o644)
            record.update(phase="open", checkout=str(checkout), branch=branch,
                          contributors=sorted({*record["contributors"], actor()}))
            write(path / "task.json", record)
            return {"checkout": str(checkout), "base": base, "decision": str(decision)}

    def submit(self, key, body_path=None):
        directory, _ = self.task(key)
        with locked(directory, "task"):
            _, task = self.task(key)
            require(task["phase"] == "open" and task["repository"] == self.repo.name, "任务须从入口启动。")
            checkout = Path(task["checkout"])
            require(not git_line(checkout, "status", "--porcelain"), "先提交候选的全部改动。")
            base, head = self.repo.main(), git_line(checkout, "rev-parse", "HEAD")
            require(base == task["base"], "main 已前进。重新组合到当前 main 后再提交。")
            self.material(checkout, task, head, base)
            branch = task["branch"]
            extra = Path(body_path).read_text().strip() if body_path else "改动范围和验收条件见决策记录。"
            body = f"Decision: docs/notes/{key}.md\n\n{extra}\n"
            scan("PR description", body.encode())
            task["contributors"] = sorted({*task["contributors"], actor()})
            write(directory / "task.json", task)
            journal = directory / "submit.json"
            attempt = read(journal) if journal.is_file() else {}
            remote = git(
                checkout, "ls-remote", "--heads", self.repo.url, branch, remote=True).decode().split()
            remote_head = remote[0] if remote else None
            pulls = self.repo.api(f"/pulls?state=open&base=main&head={self.repo.owner}:{branch}")
            require(len(pulls) < 2, "同一分支出现多份开放提案。")
            if remote_head != head:
                require(not attempt or attempt.get("head") != head, "上次推送结果未知，先核对远端分支。")
                ref = f"refs/heads/{branch}"
                options = []
                if remote_head:
                    require(attempt.get("phase") == "confirmed" and attempt.get("head") == remote_head,
                            "上次远端提交与本机登记不一致，先核对。")
                    options = [f"--force-with-lease={ref}:{remote_head}"]
                write(journal, {"phase": "pushing", "head": head})
                git(checkout, "push", *options, self.repo.url, f"{head}:{ref}", remote=True, timeout=120)
                remote_head = git(checkout, "ls-remote", "--heads", self.repo.url, branch, remote=True).decode().split()[0]
                require(remote_head == head, "尚未确认远端分支。")
            require(self.repo.main() == base, "main 已前进，先重新组合。")
            if not pulls:
                require(attempt.get("phase") not in ("creating", "confirmed"), "上次创建提案结果未知。先到 GitHub 核对。")
                write(journal, {"phase": "creating", "head": head})
                pr = self.repo.api("/pulls", {"title": task["title"], "head": branch, "base": "main", "body": body, "draft": True})
            else:
                pr = self.repo.pr(pulls[0]["number"])
            require(pr["head"]["sha"] == head and pr["base"]["sha"] == base and
                    pr["body"].splitlines()[0] == f"Decision: docs/notes/{key}.md", "远端提案与入口候选不一致。")
            result = {"phase": "confirmed", "pr": pr["number"], "url": pr["html_url"], "head": head, "base": base}
            write(journal, result)
            return result

    def rebase(self, key):
        directory, _ = self.task(key)
        with locked(directory, "task"):
            _, task = self.task(key)
            require(task["phase"] == "open", "任务尚未进入开发。先核对任务记录。")
            checkout = Path(task["checkout"])
            require(not git_line(checkout, "status", "--porcelain"), "先整理独立目录中的改动。")
            old_base, base = task["base"], self.repo.main()
            if base == old_base:
                return {"checkout": str(checkout), "base": base, "changed": False}
            self.repo.fetch(checkout)
            require(git_line(checkout, "rev-parse", "refs/arcfold/main") == base, "取回代码时 main 已变化。")
            if git_line(checkout, "merge-base", base, "HEAD") != base:
                git(checkout, "-c", "user.name=Arcfold development", "-c", "user.email=arcfold-dev@users.noreply.github.com",
                    "rebase", "--onto", base, old_base, timeout=120)
            require(git_line(checkout, "merge-base", base, "HEAD") == base and self.repo.main() == base,
                    "重新组合后 main 已变化。")
            task.update(base=base, contributors=sorted({*task["contributors"], actor()}))
            write(directory / "task.json", task)
            return {"checkout": str(checkout), "base": base, "changed": True}

    def pair(self, number):
        pr = self.repo.pr(number)
        require(pr["state"] == "open" and pr["base"]["ref"] == "main" and
                pr["base"]["repo"]["full_name"] == self.repo.name, "提案须开放且指向此仓库的 main。")
        head, base = pr["head"]["sha"], pr["base"]["sha"]
        require(re.fullmatch(SHA, head) and re.fullmatch(SHA, base) and self.repo.main() == base,
                "main 已前进，需重新组合。")
        return pr, head, base

    def completed_ci(self, head):
        runs = self.repo.api(f"/actions/workflows/desktop-checks.yml/runs?head_sha={head}&per_page=5")
        rows = [row for row in runs["workflow_runs"] if row["head_sha"] == head and
                row["path"].split("@", 1)[0] == WORKFLOW and row["event"] in ("pull_request", "workflow_dispatch")]
        require(rows and rows[0]["status"] == "completed" and rows[0]["conclusion"] == "success",
                "此提交的 GitHub Desktop 检查尚未通过。")
        run = rows[0]
        jobs = self.repo.api(f"/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs")["jobs"]
        job = next((row for row in jobs if row["name"] == "Desktop checks" and row["conclusion"] == "success"), None)
        completed = {row["name"] for row in job["steps"] if row["conclusion"] == "success"} if job else set()
        require(set(CI_STEPS) <= completed, "自动检查回执缺少确切提交、Desktop 检查或工作流检查。")
        return {"id": run["id"], "attempt": run["run_attempt"], "head": head, "url": run["html_url"]}, job

    def successful_ci(self, head):
        ci, _ = self.completed_ci(head)
        return ci

    def material(self, checkout, task, head, base):
        require(git_line(checkout, "merge-base", base, head) == base, "候选须包含当前 main，先重新组合。")
        path = f"docs/notes/{task['id']}.md"
        raw = blob(checkout, head, path)
        note = decision_note(raw)
        require(digest(raw) == task["decision_sha256"] and note["title"] == task["title"],
                "仓库中的决策与启动前登记的版本不一致。")
        changes = changed(checkout, base, head)
        pairs = list(zip(changes[::2], changes[1::2]))
        require(("A", path) in pairs, "本提案须提交新登记的决策记录。")
        scope = registered_scope(task["scope"])
        files = {}
        paths = [name for _, name in pairs]
        release = release_notes(checkout, head, base, paths, note)
        for status, name in pairs:
            require(inside_scope(name, scope), f"改动超出登记范围 {name}。")
            # For deletions include the preceding text as review evidence.
            source = blob(checkout, base if status == "D" else head, name)
            scan(name, source)
            require(b"\x00" not in source and len(source) <= 8_000_000, f"需先核对非文本材料 {name}。")
            if name == "package-lock.json" and status == "M":
                comparison = compact_lock_evidence(blob(checkout, base, name), source)
                if comparison:
                    files.update(comparison)
                    continue
            files[name] = source.decode()
        for name in ("package.json", "packages/method-ui/package.json", "cordis.patch.yml",
                     "src/desktop/bootstrap.mjs", "src/desktop/python-runtime.mjs", "scripts/package-release.mjs",
                     "LICENSE", "THIRD_PARTY_NOTICES.md", WORKFLOW):
            if name in files or name in paths:
                continue
            present = git_line(checkout, "ls-tree", head, "--", name)
            if present:
                source = blob(checkout, head, name)
                scan(name, source)
                files[name] = source.decode()
        changes_text = []
        for status, name in pairs:
            if status in ("M", "D") and (name in files or name == "package-lock.json"):
                before = blob(checkout, base, name)
                scan(name, before)
                patch = git(checkout, "diff", "--no-ext-diff", "--no-textconv", "--unified=2", base, head, "--", name)
                changes_text.append(patch.decode())
        if changes_text:
            files["review/changed-lines.diff"] = "\n".join(changes_text)
        return files, note, release, list(pairs)

    def preflight(self, number):
        pr, head, base = self.pair(number)
        ci, job = self.completed_ci(head)
        match = re.findall(rf"(?m)^Decision: docs/notes/({ID})\.md[ \t]*$", pr.get("body") or "")
        require(len(match) == 1, "PR 描述需指向唯一的 docs/notes 决策记录。")
        _, task = self.task(match[0])
        require(task["repository"] == self.repo.name and task["phase"] == "open" and task["base"] == base,
                "PR 需使用当前 main 上已启动的任务。")
        run_dir = self.state / "prs" / str(number) / (head + "-" + base)
        checkout = run_dir / "source"
        self.repo.fetch(checkout, number=number)
        require(git_line(checkout, "rev-parse", "refs/arcfold/pr") == head and
                git_line(checkout, "rev-parse", "refs/arcfold/main") == base and self.pair(number)[1:] == (head, base),
                "准备时 PR 或 main 有变化，旧材料作废。")
        files, note, release, changes = self.material(checkout, task, head, base)
        target = {"repo": self.repo.name, "pr": number, "head": head, "base": base,
                  "tree": git_line(checkout, "rev-parse", f"{head}^{{tree}}"), "decision": task["id"],
                  "decision_sha256": task["decision_sha256"], "ci": ci, "release": release}
        files["review/verification.json"] = json.dumps(
            {"target": target, "checks": {"exact_head_ci": True, "decision": True, "scope": True,
                                         "release_metadata": True, "secret_scan": True}, "changes": changes},
            ensure_ascii=False, indent=2)
        log = self.repo.gh("run", "view", str(ci["id"]), "--repo", self.repo.name,
                           "--attempt", str(ci["attempt"]), "--log", timeout=90)
        evidence = json.dumps(ci_review_record(ci, job, log.decode()), ensure_ascii=False, indent=2)
        scan("review/ci-results.json", evidence.encode())
        files["review/ci-results.json"] = evidence
        return run_dir, target, files, note

    def status(self):
        directory = self.state / "tasks"
        rows = [read(path) for path in sorted(directory.glob("*/task.json"))]
        return {"repo": self.repo.name, "main": self.repo.main(), "tasks": rows}

    def close_loop(self, key, version, observation, outcome, feedback=None):
        from collab import load_feedback, route
        from release import published
        require(outcome in OUTCOMES, "验收结论写 pass、fail 或 unconfirmed。")
        require((observation is None) != (feedback is None), "观察来自文件或一条已登记的反馈，二选一。")
        if feedback is not None:
            _, item = load_feedback(self, feedback)
            require(all(row["to"] != "close-loop:" + key for row in item["routes"]), f"{feedback} 已经关联到 {key}。")
            observation = item["text"]
        directory, _ = self.task(key)
        with locked(directory, "task"):
            fields = self.check(key)
            release = read(self.state / "releases" / version / "release.json")
            require(release["target"]["decision"] == key and fields["fixed_in"] == version,
                    "观察须关联此问题实际修复的发行版本。")
            published(release)
            result = {"observed_in_version": fields["observed_in_version"], "fixed_in": version,
                      "user_verified": text_field(observation, "开发者的实际观察"), "outcome": outcome, "at": timestamp(),
                      "decision": key, "source": release["source"], "packages": release["packages"]}
            if feedback is not None:
                result["feedback"] = feedback
            name = directory / "observations" / (uuid.uuid4().hex + ".json")
            write(name, result)
            write(directory / "user-verification.json", result)
        if feedback is not None:
            route(self, feedback, "close-loop:" + key)
        return {"observation": str(name), **result}

    def ensure_comment(self, number, run_dir, receipt, body, *, publish=True):
        phase = run_dir / "comment.json"
        marker = f"<!-- arcfold-review:{receipt['sha256']} -->"
        content = marker + "\n\n" + body
        scan("PR review comment", content.encode())
        comments = self.repo.api(f"/issues/{number}/comments?per_page=100", paginate=True)
        found = [row for row in comments if row["body"].startswith(marker)]
        require(len(found) <= 1, "同一回执出现多条 PR 评论。先核对。")
        if not found:
            require(publish, "原评论写入尚未核对，公开授权已撤回；不会新增评论。")
            require(not phase.exists(), "上次写入 PR 评论结果未知。先到 GitHub 核对。")
            write(phase, {"phase": "posting", "sha256": receipt["sha256"]})
            posted = self.repo.api(f"/issues/{number}/comments", {"body": content})
        else:
            posted = found[0]
        require(posted["body"] == content, "PR 评论和本机回执不一致。")
        result = {"phase": "confirmed", "id": posted["id"], "url": posted["html_url"], "body_sha256": digest(content.encode())}
        write(phase, result)
        return result

    @staticmethod
    def evidence_text(row):
        return "\n".join(f"- `{item['path']}:{item['line']}` · {item['note']}" for item in row["evidence"])

    def advisory_issues(self, number, run_dir, receipt, *, publish=True):
        result = receipt["review"]["result"]
        advisory = [row for row in result["findings"] if row["impact"] == "advisory"]
        if not advisory and result["checks"]["advisory"]["status"] != "pass":
            row = result["checks"]["advisory"]
            advisory = [{"title": "独立审阅的后续事项", "description": row["summary"], "evidence": row["evidence"]}]
        if not advisory:
            return []
        issues = []
        for index, row in enumerate(advisory):
            phase = run_dir / f"advisory-{index}.json"
            if not publish and not phase.exists():
                continue
            marker = f"<!-- arcfold-advisory:{receipt['sha256']}:{index} -->"
            content = f"{marker}\n\n来自 PR #{number} 的独立审阅。\n\n{row['description']}\n\n{self.evidence_text(row)}"
            try:
                scan("Issue text", content.encode() + row["title"].encode())
                known = self.repo.api("/issues?state=all&per_page=100", paginate=True)
                matches = [issue for issue in known if (issue.get("body") or "").startswith(marker)]
                require(len(matches) <= 1, "同一审阅发现出现多条 Issue。")
                if matches:
                    item = matches[0]
                else:
                    require(publish, "原 Issue 写入尚未核对，公开授权已撤回；不会新增 Issue。")
                    require(not phase.exists(), "上次写入 Issue 结果未知，先核对。")
                    write(phase, {"phase": "posting", "review": receipt["sha256"]})
                    item = self.repo.api("/issues", {"title": row["title"][:160], "body": content})
                require(item["body"] == content, "Issue 与审阅发现不一致。")
                answer = {"phase": "confirmed", "url": item["html_url"]}
                write(phase, answer)
            except WorkflowError as exc:
                answer = {"phase": "check_github", "title": row["title"], "error": str(exc)}
            issues.append(answer)
        return issues

    @staticmethod
    def previous_review_uncertainty(run_dir):
        uncertain = []
        for path in sorted(run_dir.parent.glob("*/attempt.json")):
            if path.parent == run_dir:
                continue
            attempt = read(path)
            if attempt.get("request_sent") is False:
                continue
            response = path.parent / "response.json"
            if response.is_file():
                returned = read(response)
                if isinstance(returned.get("response", {}).get("usage"), dict) and (
                    attempt.get("provider") != "lmuai" or "billing" in returned
                ):
                    continue
            resolution_path = path.parent / "billing-reconciliation.json"
            resolution = read(resolution_path) if resolution_path.is_file() else {}
            if (resolution.get("client_request_id") != attempt["client_request_id"]
                or resolution.get("outcome") not in ("no_usage", "usage_confirmed")
                or not resolution.get("evidence")):
                uncertain.append({"request": attempt["client_request_id"], "started_at": attempt["started_at"]})
        return uncertain

    def review(self, number, approval=None, provider="openai"):
        import desktop_review_request as reviewer

        def run_worker(run_dir, key, *, settle=False):
            from review_policy import check_unsettled, key_root
            # Keep every unrelated credential out of the review process.
            inherited = ("PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG", *reviewer.PROXY_ENV)
            child_env = {k: os.environ[k] for k in inherited if k in os.environ}
            child_env["ARCFOLD_REVIEW_API_KEY"] = key
            argv = [sys.executable, "-B", str(HERE / "desktop_review_request.py"), str(run_dir)]
            if settle:
                argv.append("--settle-billing")
            if provider == "lmuai":
                key_id = digest(key.encode())
                with locked(key_root(self, key_id), "dispatch"):
                    reservation = key_root(self, key_id) / "reservation.json"
                    require(not reservation.is_file() or not read(reservation).get("job"),
                            "同一密钥的后台任务尚未结算，不能改用手动入口发送或核对。")
                    check_unsettled(self, key_id, run_dir)
                    attempt = read(run_dir / "attempt.json")
                    attempt["key_id"] = key_id
                    write(run_dir / "attempt.json", attempt)
                    command(argv, timeout=1030, env=child_env)
            else:
                command(argv, timeout=1030, env=child_env)

        with locked(self.state / "prs", str(number)):
            run_dir, target, files, _ = self.preflight(number)
            packet = reviewer.packet_for(target, files, provider)
            path = run_dir / "request.json"
            attempt_path = run_dir / "attempt.json"
            output = run_dir / "response.json"
            if attempt_path.exists():
                attempt = read(attempt_path)
                require(attempt["packet"] == packet["id"], "已有尝试使用了不同的材料或检查。先核对原回执和用量。")
                require(output.exists(), "已有审阅尝试，响应未确认。先核对请求编号和服务用量。")
                if provider == "lmuai" and "billing" not in read(output):
                    run_worker(run_dir, reviewer.review_key(provider), settle=True)
            else:
                write(path, packet)
                preview = {"packet": packet["id"], "target": target, "material": str(path), **reviewer.estimate(packet)}
                uncertain = self.previous_review_uncertainty(run_dir)
                if uncertain:
                    preview["prior_usage_pending"] = uncertain
                write(run_dir / "estimate.json", preview)
                if not approval:
                    return preview
                from collab import review_approval
                from collab import load_ask
                require(not load_ask(self, approval)[1].get("execution"),
                        "后台执行授权请用 review --enqueue，不能改用手动密钥入口。")
                granted = review_approval(self, approval, number, packet["id"], preview)
                require(not uncertain, "此提案还有用量未核对的旧审阅尝试，先查 OpenAI 的用量或请求记录。")
                key = reviewer.review_key(provider)
                require(self.pair(number)[1:] == (target["head"], target["base"]), "候选或 main 在调用前已变化。")
                attempt = {**reviewer.make_attempt(packet), "approval": granted}
                write(attempt_path, attempt)
                run_worker(run_dir, key)
            return self.review_result(run_dir, packet, target, attempt, provider)

    def review_result(self, run_dir, packet, target, attempt, provider, *, publish=True):
        import desktop_review_request as reviewer
        output = run_dir / "response.json"
        number = target["pr"]
        validated = reviewer.validate(packet, read(output))
        require(self.pair(number)[1:] == (target["head"], target["base"]) and
                self.successful_ci(target["head"]) == target["ci"], "审阅期间候选或检查已变化，回执只供历史核对。")
        issues_result = validated["result"]
        blocking = sorted(set(reviewer.blockers(issues_result)))
        receipt = {"target": target, "packet": packet["id"], "attempt": attempt["client_request_id"],
                   "review": validated, "blocking_checks": blocking,
                   "verdict": "fail" if blocking else "pass"}
        receipt["sha256"] = digest(receipt)
        receipt_path = run_dir / "receipt.json"
        write(receipt_path, receipt)
        pending_publication = (run_dir / "comment.json").is_file() or any(run_dir.glob("advisory-*.json"))
        if not publish and not pending_publication:
            return {"verdict": receipt["verdict"], "receipt": str(receipt_path), "blocking": blocking,
                    "usage": validated["usage"], "publication": "local_only"}
        statuses = "\n\n".join(
            f"**{reviewer.CHECKS[name]} · {row['status']}**\n\n{row['summary']}\n\n{self.evidence_text(row)}"
            for name, row in issues_result["checks"].items())
        findings = "\n\n".join(
            f"**{row['title']} · {row['impact']}**\n\n{row['description']}\n\n{self.evidence_text(row)}"
            for row in issues_result["findings"])
        body = (f"## 独立审阅 · {receipt['verdict']}\n\n"
                f"- PR 提交 `{target['head']}`\n- main 基线 `{target['base']}`\n"
                f"- 审阅服务 `{provider}` · 模型 `{validated['model']}`\n"
                f"- [GitHub 检查]({target['ci']['url']})\n- 回执摘要 `{receipt['sha256']}`\n\n"
                f"{statuses}\n\n{findings}").strip()
        comment = self.ensure_comment(number, run_dir, receipt, body, publish=publish)
        issues = self.advisory_issues(number, run_dir, receipt, publish=publish)
        write(run_dir / "advisories.json", issues)
        return {"verdict": receipt["verdict"], "receipt": str(receipt_path), "comment": comment["url"],
                "blocking": blocking, "issues": issues, "usage": validated["usage"]}

    def verify_receipt(self, number, head, base):
        from desktop_review_request import blockers, validate

        run_dir = self.state / "prs" / str(number) / (head + "-" + base)
        required = [run_dir / (name + ".json") for name in ("receipt", "attempt", "request", "response", "comment")]
        require(all(path.is_file() for path in required), "当前 PR 和 main 缺少脚本发起并登记的独立审阅。")
        receipt, attempt, packet, response, comment = map(read, required)
        recorded = receipt["sha256"]
        require(digest({k: v for k, v in receipt.items() if k != "sha256"}) == recorded and
                digest({k: v for k, v in packet.items() if k != "id"}) == packet["id"] and
                receipt["packet"] == packet["id"] == attempt["packet"] and
                receipt["attempt"] == attempt["client_request_id"], "审阅回执与会话材料不一致。")
        target = receipt["target"]
        require(target == packet["target"] and (target["pr"], target["head"], target["base"], target["repo"]) ==
                (number, head, base, self.repo.name), "回执没有绑定到此仓库、PR 和当前提交。")
        require(receipt["review"] == validate(packet, response) and receipt["verdict"] == "pass"
                and not blockers(receipt["review"]["result"]), "审阅未通过，或有未处理的阻塞项。")
        require(target["ci"] == self.successful_ci(head), "CI 回执已变化，需要核对审阅。")
        require(comment.get("phase") == "confirmed", "PR 评论结果未确认。")
        remote = self.repo.api(f"/issues/comments/{comment['id']}")
        require(digest(remote["body"].encode()) == comment["body_sha256"] and
                remote["body"].startswith(f"<!-- arcfold-review:{recorded} -->"), "PR 评论内容已变化。")
        return receipt, comment

    def merge(self, number):
        with locked(self.state / "prs", str(number)), locked(self.state, "main"):
            pr = self.repo.pr(number)
            directory = self.state / "prs" / str(number)
            journal = directory / "merge-attempt.json"
            known = read(journal) if journal.exists() else {}
            if pr.get("merged"):
                require(known.get("phase") in ("merging", "confirmed"), "GitHub 已合入，缺少本入口的操作记录。")
                return self.confirm_merge(number, known, pr, journal)
            require(known.get("phase") not in ("merging", "confirmed"), "上次合入结果未知，先到 GitHub 核对。")
            pr, head, base = self.pair(number)
            receipt, comment = self.verify_receipt(number, head, base)
            from collab import open_decisions
            decision = receipt["target"]["decision"]
            pending = open_decisions(self, decision)
            require(not pending, f"任务 {decision} 还有未答的决定单 {'、'.join(pending)}，先请开发者答复。")
            if pr["draft"]:
                require(not known, "上次退出草稿结果未知，先到 GitHub 核对。")
                write(journal, {"phase": "marking-ready", "head": head, "base": base})
                self.repo.gh("pr", "ready", str(number), "--repo", self.repo.name)
            pr, checked_head, checked_base = self.pair(number)
            require(not pr["draft"] and (checked_head, checked_base) == (head, base) and
                    self.successful_ci(head) == receipt["target"]["ci"], "合入前的提交或检查已变化。")
            known = {"phase": "merging", "target": receipt["target"], "review_sha256": receipt["sha256"],
                     "review_comment": comment["url"], "started_at": timestamp()}
            write(journal, known)
            self.repo.gh("pr", "merge", str(number), "--repo", self.repo.name, "--squash", "--match-head-commit", head)
            return self.confirm_merge(number, known, self.repo.pr(number), journal)

    def confirm_merge(self, number, known, pr, journal):
        target = known["target"]
        commit_sha = pr["merge_commit_sha"]
        require(pr.get("merged") and pr["head"]["sha"] == target["head"] and re.fullmatch(SHA, commit_sha or ""),
                "GitHub 合入结果尚未确认。")
        commit = self.repo.commit(commit_sha)
        require(commit["tree"]["sha"] == target["tree"] and [row["sha"] for row in commit["parents"]] == [target["base"]],
                "合入后的文件或基线不符，停止发布。")
        current = self.repo.main()
        require(current == commit_sha or known.get("phase") == "confirmed",
                "合入后 main 已前进，先核对 GitHub 实际代码再确认。")
        result = {**known, "phase": "confirmed", "source": commit_sha, "confirmed_at": timestamp(), "pr": number}
        release = target["release"]
        if release:
            version = release["version"]
            path = self.state / "merges" / f"{version}.json"
            if path.exists():
                require(read(path)["source"] == commit_sha, "此版本已经关联另一提交。")
            else:
                write(path, result)
        write(journal, result)
        return result


def parse_args():
    parser = argparse.ArgumentParser(description="Arcfold DSH 开发、审阅和发布")
    parser.add_argument("--repo", default=os.getenv("ARCFOLD_REPOSITORY"))
    parser.add_argument("--state-dir", default=os.getenv("ARCFOLD_WORKFLOW_STATE", "~/.local/state/arcfold-dsh-workflow"))
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("status")
    progress = sub.add_parser("next", help="只读推算每个任务的环节、下一步和等谁")
    progress.add_argument("--remote", action="store_true", help="另外核对 GitHub 上的 main、提案和检查")
    progress.add_argument("--write", metavar="FILE", help="把结果写入文件中的 arcfold-next 标记段")
    export = sub.add_parser("export")
    export.add_argument("--output", required=True)
    new = sub.add_parser("new")
    new.add_argument("--input", required=True)
    new.add_argument("--from-feedback", metavar="F编号", help="从一条已登记的反馈预填来源和发生版本")
    for name in ("check", "start", "rebase", "submit", "close-loop"):
        cmd = sub.add_parser(name)
        cmd.add_argument("id")
        if name == "submit":
            cmd.add_argument("--body-file")
        if name == "close-loop":
            cmd.add_argument("--version", required=True)
            cmd.add_argument("--outcome", required=True, choices=OUTCOMES)
            observed = cmd.add_mutually_exclusive_group(required=True)
            observed.add_argument("--observation-file")
            observed.add_argument("--feedback", metavar="F编号")
    ask = sub.add_parser("ask", help="登记需要开发者处理的授权单、决定单或操作单")
    ask.add_argument("--input", required=True)
    asks = sub.add_parser("asks", help="列出未答的请求单")
    asks.add_argument("--all", action="store_true", help="包括已答的请求单")
    reply = sub.add_parser("answer", help="按原话登记开发者对请求单的回复")
    reply.add_argument("id")
    reply.add_argument("--verdict", required=True, choices=("yes", "no", "other"))
    reply.add_argument("--step", type=int)
    revoke = sub.add_parser("revoke-approval", help="按开发者原话撤回后续执行授权")
    revoke.add_argument("id")
    align = sub.add_parser("align", help="登记开发者对当前决策的对齐确认")
    align.add_argument("id")
    feedback = sub.add_parser("feedback", help="登记开发者的体验反馈")
    feedback.add_argument("--attach", action="append", default=[], metavar="PATH")
    for cmd in (reply, align, feedback, revoke):
        words = cmd.add_mutually_exclusive_group(required=True)
        words.add_argument("--text")
        words.add_argument("--text-file")
    route = sub.add_parser("route", help="记录一条反馈的去向")
    route.add_argument("id")
    route.add_argument("--to", required=True, help="close-loop:任务、new:任务、issue:编号 或 note")
    route.add_argument("--note")
    retire = sub.add_parser("retire", help="标记被取代或放弃的任务")
    retire.add_argument("id")
    retire.add_argument("--reason", required=True)
    retire.add_argument("--replaced-by")
    review = sub.add_parser("review")
    review.add_argument("--pr", type=int, required=True)
    review.add_argument("--provider", choices=("openai", "lmuai"), default="openai")
    review.add_argument("--approval", metavar="A编号", help="开发者已同意的审阅费用授权单")
    review.add_argument("--enqueue", action="store_true", help="把已批准的固定材料交给本机后台执行")
    review.add_argument("--profile", default="default")
    queue = sub.add_parser("review-queue", help="查看和控制已批准的后台审阅")
    queue.add_argument("operation", choices=("status", "run", "resume", "cancel", "pause", "unpause", "reconcile"))
    queue.add_argument("--job")
    queue.add_argument("--profile", default="default")
    service = sub.add_parser("review-service", help="准备或按授权安装本机审阅程序")
    service.add_argument("operation", choices=("prepare", "install", "prepare-remove", "remove"))
    service.add_argument("--profile", default="default")
    service.add_argument("--output")
    service.add_argument("--plan")
    service.add_argument("--approval")
    merge = sub.add_parser("merge")
    merge.add_argument("--pr", type=int, required=True)
    release = sub.add_parser("release")
    release.add_argument("--version", required=True)
    mode = release.add_mutually_exclusive_group()
    mode.add_argument("--prepare", action="store_true", help="只构建、核对依赖和 npm dry-run")
    mode.add_argument("--finalize", action="store_true", help="从隔离验收回执确认后发布 GitHub Release")
    release.add_argument("--isolated-receipt")
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        flow = Workflow(Repository(args.repo), args.state_dir)
        if hasattr(args, "pr"):
            require(args.pr > 0, "PR 编号必须大于零。")
        if hasattr(args, "version"):
            require(re.fullmatch(VERSION, args.version), "发行版本使用三段数字。")
        action = args.action
        import collab
        words = None
        if getattr(args, "text_file", None):
            words = Path(args.text_file).read_text()
        elif getattr(args, "text", None) is not None:
            words = args.text
        if action == "new":
            request = read(args.input)
            result = collab.new_from_feedback(flow, request, args.from_feedback) if args.from_feedback else flow.new(request)
        elif action == "status":
            result = flow.status()
        elif action == "next":
            result = collab.progress(flow, args.remote)
            if args.write:
                collab.write_section(args.write, collab.render(result))
                result["written"] = args.write
        elif action == "ask":
            result = collab.create_ask(flow, read(args.input))
        elif action == "asks":
            result = [row for row in collab.all_asks(flow) if args.all or row["status"] == "open"]
        elif action == "answer":
            result = collab.answer(flow, args.id, args.verdict, words, args.step)
        elif action == "revoke-approval":
            from review_policy import revoke
            result = revoke(flow, args.id, words)
        elif action == "align":
            result = collab.align(flow, args.id, words)
        elif action == "feedback":
            result = collab.record_feedback(flow, words, args.attach)
        elif action == "route":
            result = collab.route(flow, args.id, args.to, args.note)
        elif action == "retire":
            result = collab.retire(flow, args.id, args.reason, args.replaced_by)
        elif action == "export":
            from public_export import export
            result = export(flow, args.output)
        elif action == "submit":
            result = flow.submit(args.id, args.body_file)
        elif action == "review":
            if args.enqueue:
                from review_queue import enqueue
                require(args.provider == "lmuai" and args.approval, "排队需指定灵眸服务和已批准的执行授权单。")
                result = enqueue(flow, args.pr, args.approval, args.profile)
            else:
                result = flow.review(args.pr, args.approval, args.provider)
        elif action == "review-queue":
            import review_queue as queue
            if args.operation == "status":
                result = queue.status(flow)
            elif args.operation == "run":
                result = queue.run_once(flow, args.profile)
            elif args.operation in ("pause", "unpause"):
                result = queue.pause(flow, args.profile, args.operation == "pause")
            elif args.operation == "reconcile":
                result = queue.reconcile(flow, args.job)
            else:
                result = queue.control(flow, args.job, args.operation)
        elif action == "review-service":
            import review_service as service
            if args.operation in ("prepare", "prepare-remove"):
                require(args.output, "准备计划需要 --output。")
                result = (service.prepare(flow, args.output, args.profile) if args.operation == "prepare"
                          else service.removal_plan(flow, args.profile, args.output))
            else:
                require(args.plan and args.approval, "本机变更需要 --plan 和 --approval。")
                result = (service.install(flow, args.plan, args.approval) if args.operation == "install"
                          else service.remove(flow, args.plan, args.approval))
        elif action == "merge":
            result = flow.merge(args.pr)
        elif action == "release":
            from release import release
            result = release(flow, args.version, args.prepare, args.finalize, args.isolated_receipt)
        elif action == "close-loop":
            observation = Path(args.observation_file).read_text() if args.observation_file else None
            result = flow.close_loop(args.id, args.version, observation, args.outcome, args.feedback)
        else:
            result = getattr(flow, action)(args.id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (WorkflowError, OSError, ValueError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
