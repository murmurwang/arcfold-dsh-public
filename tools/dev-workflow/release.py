"""Build two identical Desktop package sets and bind them to the merged code."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
from urllib.parse import quote
from urllib.request import urlopen

from common import command, digest, git, git_line, locked, read, require, timestamp, write
from workflow import COMPATIBLE_DSH


CHECKOUT_ARGS = "--source", "--dependencies", "--output", "--source-kind", "--target", "--version", "--desktop-python-archive"
REHEARSAL_CHECKS = ("fresh_install", "synthetic_dialogue", "failed_download_restored", "confirmed_update", "restart_readback")


def npm_environment(state):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    userconfig = state / "npmrc"
    globalconfig = state / "npmrc-global"
    if not userconfig.exists():
        write(userconfig, b"")
        write(globalconfig, b"")
    return {**{k: os.environ[k] for k in ("PATH", "TMPDIR", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR") if k in os.environ},
            "HOME": str(state), "npm_config_userconfig": str(userconfig), "npm_config_globalconfig": str(globalconfig),
            "npm_config_cache": str(state / "cache"), "npm_config_registry": "https://registry.npmjs.org/",
            "DSH_TELEMETRY_DISABLED": "1"}


def install_dependencies(source, env):
    require(command(["node", "--version"], source, env=env).strip() == b"v24.15.0",
            "按 CI 的 Node 24.15.0 构建。")
    cache_path = os.getenv("ARCFOLD_WORKFLOW_NPM_CACHE")
    if cache_path:
        target = Path(env["npm_config_cache"]) / "_cacache"
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(Path(cache_path) / "_cacache", target)
    command(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", *(
        ["--offline"] if cache_path else [])], source, timeout=420, env=env)


def python_archive(source, workspace, env):
    cached = os.getenv("ARCFOLD_DESKTOP_PYTHON_ARCHIVE")
    if cached:
        return Path(cached).resolve(strict=True)
    link = command(["node", "--input-type=module", "-e",
                    "import { desktopPython } from './src/desktop/python-runtime.mjs'; console.log(desktopPython.url)"],
                   source, env=env).decode().strip()
    dest = workspace / "desktop-python.tar.gz"
    command(["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
             "--proto-redir", "=https", "--max-time", "180", "--output", str(dest), link], source, timeout=190, env=env)
    return dest


def build(source, folder, kind, version, archive, env):
    values = (source, source, folder, kind, "desktop", version, archive)
    args = [part for pair in zip(CHECKOUT_ARGS, values) for part in map(str, pair)]
    command(["node", "scripts/package-release.mjs", *args], source, timeout=300, env=env)
    return read(folder / "manifest.json")


def verify_package(path, row, version, notes, env):
    actual = path.read_bytes()
    require(digest(actual) == row["sha256"], "安装包摘要与构建回执不符。")
    with tarfile.open(path, "r:gz") as tar:
        package = json.load(tar.extractfile("package/package.json"))
        require(package["name"] == row["name"] and package["version"] == version and package["license"] == "MIT",
                "发行包名称、版本或许可证不符。")
        require(tar.extractfile("package/LICENSE").read() == notes["license"] and
                tar.extractfile("package/THIRD_PARTY_NOTICES.md").read() == notes["third_party"],
                "安装包缺少对应源码的许可和组件声明。")
        if row["name"] == "@arcfold/dsh":
            require(package["engines"]["dsh"] == COMPATIBLE_DSH and package["dependencies"]["@arcfold/dsh-method-ui"] == version,
                    "核心包的 DSH 或界面包版本不符。")
        actual_files = {name.removeprefix("package/") for name in tar.getnames()}
    result = json.loads(command(["npm", "publish", str(path), "--dry-run", "--ignore-scripts", "--access", "public",
                                 "--json", "--offline"], path.parent, timeout=90, env=env))
    require(result["name"] == row["name"] and result["version"] == version and result["integrity"] == row["integrity"] and
            {item["path"] for item in result["files"]} == actual_files, "npm dry-run 的包或文件清单不符。")
    return result


def prepare(flow, directory, version, merge):
    target = merge["target"]
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="build-", dir=directory) as local:
        local = Path(local).resolve()
        checkout = local / "source"
        flow.repo.fetch(checkout)
        require(git_line(checkout, "rev-parse", "refs/arcfold/main") == merge["source"],
                "构建前 main 已变化。")
        git(checkout, "switch", "--detach", merge["source"])
        require(git_line(checkout, "rev-parse", "HEAD^{tree}") == target["tree"], "已合入文件树与审阅不符。")
        env = npm_environment(local / "npm")
        install_dependencies(checkout, env)
        archive = python_archive(checkout, local, env)
        first = build(checkout, local / "first", "accepted", version, archive, env)
        second = build(checkout, local / "second", "accepted", version, archive, env)
        require(first["packages"] == second["packages"], "两次构建的安装包不一致。")
        require(all(row["source"]["commit"] == merge["source"] and row["source"]["tree"] == target["tree"]
                    for row in (first, second)), "构建回执缺少已审阅源码身份。")
        info = {"license": (checkout / "LICENSE").read_bytes(), "third_party": (checkout / "THIRD_PARTY_NOTICES.md").read_bytes()}
        packages = []
        dry_runs = []
        for row in first["packages"]:
            first_archive = local / "first" / row["file"]
            require(first_archive.read_bytes() == (local / "second" / row["file"]).read_bytes(),
                    "复建产物逐字节核对失败。")
            dry_runs.append(verify_package(first_archive, row, version, info, env))
            packages.append({key: row[key] for key in ("name", "version", "file", "sha256", "integrity", "bytes")})
        require(flow.repo.main() == merge["source"], "构建期间 main 已变化。")
        for row in packages:
            shutil.copyfile(local / "first" / row["file"], directory / row["file"])
        write(directory / "build-manifest.json", first)
        write(directory / "npm-dry-run.json", dry_runs)
        shutil.copyfile(local / "first" / "dependency-lock.json", directory / "dependency-lock.json")
    receipt = {"schema": "arcfold-release-v1", "version": version, "source": merge["source"], "target": target,
               "ci": target["ci"], "review_sha256": merge["review_sha256"], "review_comment": merge["review_comment"],
               "engines_dsh": target["release"]["engines_dsh"], "release_notes": target["release"]["notes"],
               "reproduced": True, "packages": packages, "built_at": timestamp(),
               "build_manifest_sha256": digest((directory / "build-manifest.json").read_bytes()),
               "npm_dry_run_sha256": digest((directory / "npm-dry-run.json").read_bytes()),
               "dependency_lock_sha256": digest((directory / "dependency-lock.json").read_bytes())}
    if target.get("delivery"):
        receipt["release_notes"] += f"\n\n[交付 {target['delivery']}] · PR #{target['pr']}"
    write(directory / "release.json", receipt)
    return receipt


def verify_release(directory, receipt):
    require(receipt["reproduced"] and receipt["engines_dsh"] == COMPATIBLE_DSH and
            {row["name"] for row in receipt["packages"]} == {"@arcfold/dsh", "@arcfold/dsh-method-ui"},
            "发行回执不完整。")
    for row in receipt["packages"]:
        require(digest((directory / row["file"]).read_bytes()) == row["sha256"], "安装包与发行回执不一致。")
    for file, key in (("build-manifest.json", "build_manifest_sha256"), ("npm-dry-run.json", "npm_dry_run_sha256"),
                      ("dependency-lock.json", "dependency_lock_sha256")):
        require(digest((directory / file).read_bytes()) == receipt[key], f"{file} 与发行回执不一致。")


def release_assets(directory, receipt):
    return {row["file"]: row["sha256"] for row in receipt["packages"]} | {
        "release.json": digest((directory / "release.json").read_bytes())}


def ensure_github_release(flow, directory, receipt):
    tag = "v" + receipt["version"]
    source = receipt["source"]
    phase = directory / "github.json"
    pending = read(phase) if phase.exists() else {}
    require(not pending or pending["source"] == source, "旧 GitHub 发行步骤使用了不同源码。")
    tags = flow.repo.api(f"/git/matching-refs/tags/{tag}")
    ref = next((row for row in tags if row["ref"] == f"refs/tags/{tag}"), None)
    if not ref:
        require(not pending, "上次 Git 标签写入未确认。先到 GitHub 核对。")
        write(phase, {"phase": "tagging", "source": source})
        ref = flow.repo.api("/git/refs", {"ref": f"refs/tags/{tag}", "sha": source})
    require(ref["object"]["type"] == "commit" and ref["object"]["sha"] == source, "Git 标签指向不同提交。")
    releases = flow.repo.api("/releases?per_page=100", paginate=True)
    matches = [row for row in releases if row["tag_name"] == tag]
    require(len(matches) <= 1, "GitHub 上有多份同版本发行。")
    if matches:
        remote = matches[0]
        require(pending.get("phase") in ("creating", "uploading", "confirmed", "finalizing", "published"),
                "同版本的 GitHub Release 已存在，先核对。")
    else:
        require(pending.get("phase") not in ("creating", "uploading", "confirmed", "finalizing", "published"),
                "上次 GitHub Release 创建结果未知，先核对。")
        write(phase, {"phase": "creating", "source": source})
        remote = flow.repo.api("/releases", {"tag_name": tag, "name": "Arcfold " + receipt["version"], "draft": True,
                                             "body": receipt["release_notes"], "target_commitish": source})
    expected = release_assets(directory, receipt)
    uploaded = {row["name"]: row for row in remote.get("assets", [])}
    require(set(uploaded) <= set(expected), "GitHub 发行包含未登记的附件。")
    for name, sha in expected.items():
        if name not in uploaded:
            require(pending.get("asset") != name, "上次附件上传结果未知。先到 GitHub 核对。")
            write(phase, {"phase": "uploading", "source": source, "asset": name})
            flow.repo.gh("release", "upload", tag, str(directory / name), "--repo", flow.repo.name, timeout=180)
        else:
            require(uploaded[name].get("digest") == "sha256:" + sha, "GitHub 附件摘要与本地记录不一致。")
    info = flow.repo.api(f"/releases/{remote['id']}")
    require({row["name"]: row.get("digest") for row in info["assets"]} ==
            {name: "sha256:" + sha for name, sha in expected.items()}, "尚未核实所有 GitHub 安装包附件。")
    result = {"phase": "confirmed" if info["draft"] else "published", "source": source, "tag": tag,
              "id": info["id"], "url": info["html_url"]}
    write(phase, result)
    return result


def verify_isolated(path, receipt):
    proof = read(path)
    require(proof["account"] == "arcfold-test" and proof["host"] == COMPATIBLE_DSH and
            proof["newer"] == receipt["version"] and proof["source"] == receipt["source"],
            "隔离验收与本次发行不一致。")
    require(proof["packages"] == {row["name"]: row["sha256"] for row in receipt["packages"]},
            "隔离环境实测的包与本次发行不一致。")
    for check in REHEARSAL_CHECKS:
        row = proof["checks"][check]
        require(row["status"] == "pass" and row["evidence"], f"缺少隔离验收 {check} 的实际结果。")
    return proof


def release(flow, version, local_only, finalize, isolated):
    import delivery
    with locked(flow.state, "main"):
        merged = flow.state / "merges" / f"{version}.json"
        require(merged.is_file(), "此版本尚无已确认的受管 main 合入。")
        merge = read(merged)
        if merge["target"].get("delivery"):
            delivery.ensure_current(flow, flow.task(merge["target"]["decision"])[1])
        require(merge["phase"] == "confirmed" and flow.repo.main() == merge["source"],
                "发行使用经过受管合入的当前 main。")
        directory = flow.state / "releases" / version
        path = directory / "release.json"
        receipt = read(path) if path.exists() else prepare(flow, directory, version, merge)
        require(receipt["source"] == merge["source"] and receipt["review_sha256"] == merge["review_sha256"],
                "既有发行回执与当前合入不一致。")
        verify_release(directory, receipt)
        result = {"record": str(path), **receipt}
        delivery.event(flow, merge["target"].get("delivery"), "release-prepared", evidence=str(path), version=version)
        if local_only:
            return result
        require(flow.repo.main() == merge["source"], "GitHub 发行前 main 已变化。")
        journal = directory / "finalize.json"
        if finalize:
            require(isolated, "发布 GitHub Release 前要有隔离账户的实际验收。")
            verify_isolated(isolated, receipt)
        result["github"] = ensure_github_release(flow, directory, receipt)
        if finalize and result["github"]["phase"] != "published":
            require(not journal.exists(), "上次发布 GitHub Release 结果未知，先核对。")
            write(directory / "isolated.json", read(isolated))
            write(journal, {"phase": "finalizing", "at": timestamp(), "source": receipt["source"]})
            flow.repo.gh("release", "edit", result["github"]["tag"], "--repo", flow.repo.name, "--draft=false")
            result["github"] = ensure_github_release(flow, directory, receipt)
            require(result["github"]["phase"] == "published", "GitHub Release 公开状态尚未确认。")
            write(journal, result["github"])
        delivery.event(flow, merge["target"].get("delivery"), "release-checked", evidence=str(directory / "github.json"),
                       version=version, published=result["github"]["phase"] == "published")
        return result


def published(receipt):
    for row in receipt["packages"]:
        name = quote(row["name"], safe="")
        with urlopen(f"https://registry.npmjs.org/{name}/{receipt['version']}", timeout=15) as response:
            metadata = json.load(response)
        require(metadata["version"] == receipt["version"] and metadata["dist"]["integrity"] == row["integrity"],
                "npm 实际发布的安装包与本机回执不一致。")
