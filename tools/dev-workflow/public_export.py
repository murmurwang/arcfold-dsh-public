"""Export an exact tracked tree without Git objects or history."""
from __future__ import annotations

from pathlib import Path
import re
import tarfile
import tempfile
import getpass
import zipfile
import io

from common import WorkflowError, digest, git, git_line, require, write
from workflow import scan

WHEEL = "src/tree/tokenizer-resources/deepseek_recipe-0.2.0-cp310-abi3-macosx_11_0_arm64.whl"
WHEEL_SHA = "624bb4d0fb3ed541b9e34d2ef96ff66057026ded7d6708b0b9088cc6d6723999"
PERSONAL_EMAIL = re.compile(
    rb"\b[A-Za-z0-9._%+-]+@(?:gmail|outlook)\.com\b(?!\.[A-Za-z0-9])", re.IGNORECASE,
)


def inspect_export(path, sha, output, owner=None):
    output.mkdir(parents=True, mode=0o700)
    identities = [re.compile(rb"\b" + re.escape(name.encode()) + rb"\b", re.I) for name in (getpass.getuser(), owner) if name]
    tree = git_line(path, "rev-parse", f"{sha}^{{tree}}")
    archive = output / "source.tar.gz"
    git(path, "archive", "--format=tar.gz", f"--output={archive}", sha)
    tracked = {}
    for row in git(path, "ls-tree", "-r", "-z", sha).decode().split("\0"):
        if not row:
            continue
        meta, _, name = row.partition("\t")
        mode, kind, _ = meta.split()
        require(kind == "blob" and mode in ("100644", "100755"), f"公开导出含特殊输入 {name}。")
        tracked[name] = mode
    inventory = []
    with tarfile.open(archive, "r:gz") as bundle:
        for item in bundle:
            if item.isdir():
                continue
            name = item.name
            require(item.isfile() and name in tracked, "归档含未登记的非文件对象。")
            data = bundle.extractfile(item).read()
            sha256 = digest(data)
            require(sha256 == digest(git(path, "show", f"{sha}:{name}")), f"归档与源码不符 {name}。")
            flags = []
            if name == WHEEL:
                require(sha256 == WHEEL_SHA, "二进制分词库与已登记上游归档不符。")
                with zipfile.ZipFile(io.BytesIO(data)) as wheel:
                    licenses = sorted(name for name in wheel.namelist() if "LICENSE" in name)
                    require(licenses, "分词库归档缺许可文件。")
                inventory.append({"path": name, "sha256": sha256, "bytes": len(data),
                                  "scan": "licensed upstream wheel", "license_paths": licenses})
                continue
            if re.search(r"(?:^|/)(?:\.git(?:/|$)|\.(?:env|npmrc)[^/]*|(?:sessions|conversations|artifacts|private|credentials)/)"
                         r"|\.(?:sqlite(?:-wal|-shm)?|db|pem|key|p12|pfx|jsonl)$", name, re.I) and name != ".gitignore":
                flags.append("路径需人工核对")
            try:
                data.decode()
                scan(name, data)
            except WorkflowError as exc:
                flags.append(str(exc))
            except UnicodeError:
                flags.append("未登记的二进制内容")
            if PERSONAL_EMAIL.search(data) or any(pattern.search(data) for pattern in identities):
                flags.append("个人标识待核对")
            inventory.append({"path": name, "sha256": sha256, "bytes": len(data),
                              "scan": "needs review" if flags else "scanned", "findings": flags})
    require(tracked.keys() == {row["path"] for row in inventory}, "导出遗漏 tracked 文件。")
    result = {"source": sha, "tree": tree, "archive": archive.name, "archive_sha256": digest(archive.read_bytes()),
              "files": inventory, "flagged": [row["path"] for row in inventory if row["scan"] == "needs review"]}
    write(output / "inventory.json", result)
    return {"source": sha, "tree": tree, "files": len(inventory), "flagged": result["flagged"],
            "inventory": str(output / "inventory.json"), "archive": str(archive)}


def export(flow, output):
    root = Path(output).expanduser().resolve()
    sha = flow.repo.main()
    with tempfile.TemporaryDirectory(prefix="arcfold-source-") as work:
        path = Path(work) / "source"
        flow.repo.fetch(path)
        require(git_line(path, "rev-parse", "refs/arcfold/main") == sha == flow.repo.main(), "导出期间 main 已变化。")
        return inspect_export(path, sha, root, flow.repo.owner)
