"""Prepare a shareable, read-only test kit with two exact sets of archives."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tarfile
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import digest, read, require, write


def package_rows(directory):
    candidates = [directory / "release.json", directory / "manifest.json"]
    receipt = read(next(path for path in candidates if path.is_file()))
    source = receipt["source"]
    if isinstance(source, dict):
        source = source["commit"]
    return receipt["version"], source, receipt["packages"]


def prepare(older, newer, output, cache):
    old_version, _, _ = package_rows(older)
    new_version, source, _ = package_rows(newer)
    require(tuple(map(int, old_version.split("."))) < tuple(map(int, new_version.split("."))), "演练的两个版本须由旧到新。")
    output.mkdir(mode=0o755)
    packages = []
    frozen = {}
    for directory in (older, newer):
        version, commit, rows = package_rows(directory)
        require({item["name"] for item in rows} == {"@arcfold/dsh", "@arcfold/dsh-method-ui"},
                "演练需要核心和界面两种安装包。")
        for pkg in rows:
            file = pkg["file"]
            require(Path(file).name == file and file.endswith(".tgz"), "安装包文件名无效。")
            data = (directory / file).read_bytes()
            require(digest(data) == pkg["sha256"], "演练包与发行记录不符。")
            with tarfile.open(directory / file, "r:gz") as tar:
                manifest = json.load(tar.extractfile("package/package.json"))
                inventory = {member.name.removeprefix("package/"): digest(tar.extractfile(member).read())
                             for member in tar if member.isfile() and member.name.startswith("package/")}
            require(manifest["name"] == pkg["name"] and manifest["version"] == version, "包清单版本不一致。")
            write(output / file, data)
            packages.append({"name": pkg["name"], "version": version, "file": file, "integrity": pkg["integrity"],
                             "sha256": pkg["sha256"], "manifest": manifest, "files": inventory, "source": commit})
        lock = read(directory / "dependency-lock.json")
        for name, row in lock["packages"].items():
            if row.get("dev") or not row.get("integrity") or not row.get("resolved"):
                continue
            url = urlparse(row["resolved"])
            require(url.scheme == "https" and url.hostname in ("registry.npmjs.org", "registry.npmmirror.com"),
                    "演练只镜像已锁定的公开依赖。")
            group = name.split("node_modules/")[-1]
            frozen[(group, row["version"])] = row

    missing = []
    for (name, version), row in sorted(frozen.items()):
        alg, value = row["integrity"].split("-", 1)
        hex_value = base64.b64decode(value).hex()
        cacache = Path("content-v2") / alg / hex_value[:2] / hex_value[2:4] / hex_value[4:]
        artifact = cache / "_cacache" / cacache
        if not artifact.is_file():
            artifact = cache / f"{name.replace('/', '-')}-{version}.tgz"
        if not artifact.is_file():
            relevant = not row.get("optional") or (
                row.get("os", ["darwin"]) == ["darwin"] and row.get("cpu", ["arm64"]) == ["arm64"])
            if relevant:
                missing.append(f"{name}@{version}")
            continue
        data = artifact.read_bytes()
        require(hashlib.new(alg, data).hexdigest() == hex_value, f"锁定依赖摘要不符 {name}@{version}。")
        with tarfile.open(artifact, "r:gz") as tar:
            member = next(entry for entry in tar if len(entry.name.split("/")) == 2 and entry.name.endswith("/package.json"))
            manifest = json.load(tar.extractfile(member))
        require(manifest["name"] == name and manifest["version"] == version, "镜像依赖与锁文件不符。")
        filename = "deps/" + hex_value + ".tgz"
        write(output / filename, data)
        packages.append({"name": name, "version": version, "file": filename, "manifest": manifest,
                         "integrity": row["integrity"], "sha256": digest(data)})
    require(not missing, "演练镜像缺少锁定依赖 " + ", ".join(missing))
    kit = {"older": old_version, "newer": new_version, "candidate": source, "packages": packages}
    kit["id"] = digest(kit)[:12]
    write(output / "bundle.json", kit)
    for name in ("fixture.mjs", "registry.mjs", "model.mjs", "desktop.mjs", "run.mjs", "Run-DSH.command", "README.md"):
        shutil.copyfile(Path(__file__).with_name(name), output / name)
    for path in output.rglob("*"):
        path.chmod(0o755 if path.is_dir() or path.suffix == ".command" else 0o644)
    return {"kit": str(output), "id": kit["id"], "older": old_version, "newer": new_version, "source": source}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for label in ("older", "newer", "output", "npm-cache"):
        parser.add_argument("--" + label, type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.older, args.newer, args.output, args.npm_cache), ensure_ascii=False))
