"""Build twice from one accepted commit without reserving the moving main.

Candidate selection remains owned by release_candidates. Legacy records are
read in place; no second candidate index is introduced here.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile

from common import digest, git, git_line, locked, read, require, timestamp, write
import execution


def require_in_main(flow, source):
    head = flow.repo.main()
    if head != source:
        result = flow.repo.api(f"/compare/{source}...{head}")
        require(result.get("status") == "ahead" and result.get("merge_base_commit", {}).get("sha") == source,
                "固定的发行源码已不在主线历史中，停止本候选并核对。")
    return head


def selected(flow, version, merge, candidate):
    if candidate is not None:
        import release_candidates
        _, row = release_candidates.current(flow, version, candidate)
        require(row["merge"]["source"] == merge["source"] and row["merge"]["target"] == merge["target"],
                "当前候选不再对应这次构建的受管源码。")
        recipe = row["identity"]["recipe"]
        require(recipe == release_candidates.build_recipe() and all(
            recipe.get(name) == digest(Path(__file__).with_name(name).read_bytes())
            for name in ("parallel_build.py", "execution.py")),
            "候选构建配方尚未绑定并行构建实现，或输入已变化；先完成接入并另存候选。")
        return row
    else:
        root = flow.state / "releases" / version
        require(not (root / "candidates.json").exists(), "此版本已启用候选索引，请显式使用对应候选。")
        record = read(flow.state / "merges" / (version + ".json"))
        require(record["phase"] == "confirmed" and record["source"] == merge["source"] and
                record["target"] == merge["target"] and record["review_sha256"] == merge["review_sha256"],
                "已登记的受管发行来源已变化。")


def once(path, data):
    data = data if isinstance(data, bytes) else Path(data).read_bytes()
    if path.exists():
        require(path.read_bytes() == data, "不能覆盖已有构建证据或安装包：" + path.name)
    else:
        write(path, data)


def prepare(flow, directory, version, merge, candidate=None):
    import release
    target = merge["target"]
    require(merge["phase"] == "confirmed", "构建须有已确认的受管合入。")
    require_in_main(flow, merge["source"])
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    version_root = flow.state / "releases" / version
    with locked(version_root, "candidate"):
        selected_row = selected(flow, version, merge, candidate)
        existing = directory / "release.json"
        if existing.is_file():
            receipt = read(existing)
            release.verify_release(directory, receipt)
            require(receipt["source"] == merge["source"] and receipt["target"] == target,
                    "已有构建结果不是本次固定输入。")
            return receipt
        run = execution.reserve_work(flow, "build/" + (candidate or version),
                                     {"source": merge["source"], "tree": target["tree"], "version": version,
                                      "candidate": candidate, "recipe": digest(Path(__file__).read_bytes())})
        write(directory / "build-attempts" / (run["id"] + ".json"), run)
    result_file = directory / "build-attempts" / (run["id"] + "-result.json")
    try:
        with tempfile.TemporaryDirectory(prefix="build-", dir=directory) as local_name:
            local = Path(local_name).resolve()
            frozen = local / "frozen"
            flow.repo.fetch(frozen)
            require(git_line(frozen, "merge-base", merge["source"], "refs/arcfold/main") == merge["source"],
                    "取回的主线不包含本次固定源码。")
            git(frozen, "switch", "--detach", merge["source"])
            require(git_line(frozen, "rev-parse", "HEAD^{tree}") == target["tree"], "固定源码文件与审阅回执不符。")
            common_env = release.npm_environment(local / "download")
            archive = release.python_archive(frozen, local, common_env)
            archive_sha = digest(archive.read_bytes())

            def perform(name):
                checkout = local / (name + "-source")
                git(local, "clone", "--quiet", "--no-hardlinks", str(frozen), str(checkout), timeout=120)
                git(checkout, "switch", "--detach", merge["source"])
                env = release.npm_environment(local / (name + "-npm"))
                release.install_dependencies(checkout, env)
                require(digest(archive.read_bytes()) == archive_sha, "两次构建共用的只读下载内容已变化。")
                output = local / name
                started = timestamp()
                manifest = release.build(checkout, output, "accepted", version, archive, env)
                require({p["name"] for p in manifest["packages"]} == {"@arcfold/dsh", "@arcfold/dsh-method-ui"},
                        "每次构建都必须产出完整的两份包。")
                require(manifest["source"]["commit"] == merge["source"] and manifest["source"]["tree"] == target["tree"],
                        "构建回执缺少固定的受管源码身份。")
                info = {"license": (checkout / "LICENSE").read_bytes(),
                        "third_party": (checkout / "THIRD_PARTY_NOTICES.md").read_bytes()}
                dry_runs = [release.verify_package(output / p["file"], p, version, info, env) for p in manifest["packages"]]
                return {"manifest": manifest, "output": output, "dry_runs": dry_runs,
                        "started_at": started, "finished_at": timestamp()}

            with ThreadPoolExecutor(max_workers=run["weight"]) as pool:
                first, second = list(pool.map(perform, ("first", "second")))
            require(first["manifest"]["packages"] == second["manifest"]["packages"], "两次独立构建的安装包不一致。")
            packages = []
            for package in first["manifest"]["packages"]:
                first_archive = first["output"] / package["file"]
                require(first_archive.read_bytes() == (second["output"] / package["file"]).read_bytes(),
                        "两次构建安装包逐字节比较失败。")
                packages.append({key: package[key] for key in ("name", "version", "file", "sha256", "integrity", "bytes")})
            # Main may advance; selection and exact source, not the moving tip, govern reuse.
            require_in_main(flow, merge["source"])
            with locked(version_root, "candidate"):
                selected(flow, version, merge, candidate)
                for package in packages:
                    once(directory / package["file"], first["output"] / package["file"])
                write(directory / "build-manifest.json", first["manifest"])
                write(directory / "rebuild-manifest.json", second["manifest"])
                write(directory / "npm-dry-run.json", first["dry_runs"])
                once(directory / "dependency-lock.json", first["output"] / "dependency-lock.json")
                receipt = {"schema": "arcfold-release-v1", "version": version, "source": merge["source"], "target": target,
                           "ci": target["ci"], "review_sha256": merge["review_sha256"], "review_comment": merge["review_comment"],
                           "engines_dsh": target["release"]["engines_dsh"], "release_notes": target["release"]["notes"],
                           "reproduced": True, "packages": packages, "built_at": timestamp(),
                           "build_manifest_sha256": digest((directory / "build-manifest.json").read_bytes()),
                           "rebuild_manifest_sha256": digest((directory / "rebuild-manifest.json").read_bytes()),
                           "npm_dry_run_sha256": digest((directory / "npm-dry-run.json").read_bytes()),
                           "dependency_lock_sha256": digest((directory / "dependency-lock.json").read_bytes()),
                           "build_execution": run["id"], "parallel_builds": run["weight"]}
                if candidate is not None:
                    receipt["candidate"] = candidate
                    receipt["builder_recipe"] = selected_row["identity"]["recipe"]
                write(directory / "release.json", receipt)
            write(result_file, {"outcome": "pass", "source": merge["source"], "candidate": candidate,
                                "packages": packages, "parallel_builds": run["weight"]})
        execution.finish(flow, run["id"], "pass", [str(result_file)])
        return receipt
    except BaseException as exc:
        write(result_file, {"outcome": "fail", "source": merge["source"], "error": str(exc), "at": timestamp()})
        execution.finish(flow, run["id"], "fail", [str(result_file)])
        raise
