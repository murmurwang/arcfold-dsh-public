"""Local records and GitHub access for the DSH development entry."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile


class WorkflowError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise WorkflowError(message)


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read(path):
    return json.loads(Path(path).read_bytes())


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical(value)).hexdigest()


def write(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = content if isinstance(content, bytes) else (json.dumps(content, ensure_ascii=False, indent=2) + "\n").encode()
    fd, temp = tempfile.mkstemp(prefix=".writing-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


@contextmanager
def locked(root, name):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / (name + ".lock")).open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise WorkflowError("该记录正由另一流程处理。先核对其结果。") from exc
        yield


def command(args, cwd=None, *, payload=None, timeout=45, env=None):
    try:
        result = subprocess.run(args, cwd=cwd, input=payload, stdin=subprocess.DEVNULL if payload is None else None,
                                capture_output=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired as exc:
        raise WorkflowError(f"{Path(args[0]).name} 超时。涉及外部写入时先核对结果。") from exc
    if result.returncode:
        # Commands in this workflow never put credentials in their arguments.
        error = result.stderr.decode(errors="replace").strip()
        raise WorkflowError(f"{Path(args[0]).name} 退出码 {result.returncode}。{error[-1800:]}")
    return result.stdout


def git_environment():
    return {**{k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "LD_", "DYLD_"))
               and k not in ("ARCFOLD_REVIEW_API_KEY", "OPENAI_API_KEY")},
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0", "GH_HOST": "github.com", "GH_PROMPT_DISABLED": "1"}


def git(path, *args, remote=False, timeout=45):
    options = ["git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]
    if remote:
        gh = shutil.which("gh")
        require(gh, "需要已登录的 GitHub 命令行。")
        options.extend(["-c", "credential.helper=", "-c", "credential.helper=!" + shlex.quote(gh) + " auth git-credential"])
    return command([*options, *args], path, timeout=timeout, env=git_environment())


def git_line(path, *args):
    return git(path, *args).decode().strip()


class Repository:
    def __init__(self, name):
        require(name and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9-]*/[a-zA-Z0-9_.-]+", name) and
                name.split("/")[1] not in (".", ".."), "用 --repo 指定 GitHub 的 owner/repository。")
        self.name = name
        self.owner = name.split("/")[0]
        self.url = f"https://github.com/{name}.git"

    def gh(self, *args, payload=None, timeout=45):
        return command(["gh", *args], payload=payload, timeout=timeout, env=git_environment())

    def api(self, endpoint, value=None, *, paginate=False):
        args = ["api", "--hostname", "github.com", "repos/" + self.name + endpoint]
        if value is not None:
            return json.loads(self.gh(*args, "--method", "POST", "--input", "-", payload=canonical(value)))
        if paginate:
            pages = json.loads(self.gh(*args, "--paginate", "--slurp"))
            return [row for page in pages for row in page]
        return json.loads(self.gh(*args))

    def main(self):
        return self.api("/branches/main")["commit"]["sha"]

    def pr(self, number):
        return self.api(f"/pulls/{number}")

    def commit(self, sha):
        return self.api(f"/git/commits/{sha}")

    def fetch(self, path, *, number=None):
        if not path.exists():
            path.mkdir(parents=True, mode=0o700)
            git(path, "init", "--quiet")
        refs = ["refs/heads/main:refs/arcfold/main"]
        if number is not None:
            refs.append(f"refs/pull/{number}/head:refs/arcfold/pr")
        git(path, "fetch", "--no-tags", "--force", self.url, *refs, remote=True, timeout=120)
