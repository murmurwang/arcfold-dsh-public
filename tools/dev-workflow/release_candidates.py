"""Append-only release candidates; the version index never replaces old evidence.

All mutations are serialized by the existing main lock and the version lock.
Read-only views neither import records nor contact external services.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import urlopen

from common import WorkflowError, digest, locked, read, require, timestamp, write

PACKAGES = ("@arcfold/dsh", "@arcfold/dsh-method-ui")
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
DIGEST = r"[a-f0-9]{64}"
JOURNALS = ("publication.json", "github.json", "finalize.json", "npm-publish.json")


def folder(flow, version):
    require(isinstance(version, str) and re.fullmatch(VERSION, version), "发行版本使用三段数字。")
    return flow.state / "releases" / version


def optional(path):
    return read(path) if path.is_file() else {}


def once(path, value):
    if path.is_file():
        require(read(path) == value, f"既有证据不可覆盖：{path.name}。")
    else:
        write(path, value)


def index(flow, version):
    return optional(folder(flow, version) / "candidates.json")


def load(flow, version, identity):
    require(isinstance(identity, str) and re.fullmatch(DIGEST, identity), "候选使用完整的 64 位标识。")
    directory = folder(flow, version) / "candidates" / identity
    require((directory / "candidate.json").is_file(), "找不到这次候选。先核对版本与候选标识。")
    row = read(directory / "candidate.json")
    require(row["id"] == identity and row["version"] == version and digest(row["identity"]) == identity,
            "候选身份与记录不一致。")
    return directory, row


def artifacts(flow, row):
    directory = folder(flow, row["version"])
    return directory if row.get("legacy") else directory / "candidates" / row["id"]


def publication_directory(flow, row):
    directory = folder(flow, row["version"]) / "candidates" / row["id"]
    return directory if (directory / "publication.json").exists() else artifacts(flow, row)


def publication_record(flow, row, name):
    directory = folder(flow, row["version"]) / "candidates" / row["id"]
    for path in (directory / name, artifacts(flow, row) / name):
        if path.is_file():
            relative = str(path.relative_to(folder(flow, row["version"])))
            if (relative, digest(path.read_bytes())) in reconciled_journals(flow, row["version"]):
                return {}
            return read(path)
    return {}


def built_receipt(flow, row):
    from release import verify_release
    directory = artifacts(flow, row)
    receipt = read(directory / "release.json")
    require(receipt["source"] == row["source"] and receipt["version"] == row["version"] and
            receipt["review_sha256"] == row["merge"]["review_sha256"], "构建回执与候选源码及审阅不一致。")
    require(row["legacy"] or (receipt.get("candidate") == row["id"] and
            receipt.get("builder_recipe") == row["identity"]["recipe"]), "构建回执属于另一候选或构建输入。")
    verify_release(directory, receipt)
    return directory, receipt


def current(flow, version, expected=None):
    listing = index(flow, version)
    require(listing.get("active"), "此版本尚无候选索引，先运行 candidate --import-legacy 或受管合入。")
    require(expected is None or listing["active"] == expected, "原候选已被取代，请核对当前候选，不能沿用旧对象。")
    return load(flow, version, listing["active"])


def build_recipe():
    root = Path(__file__).resolve().parent
    return {name: digest((root / name).read_bytes()) for name in ("release.py", "release_candidates.py")}


def _register(flow, merge, *, legacy=False, replaces=None, reason=None):
    from workflow import actor
    version = merge["target"]["release"]["version"]
    root = folder(flow, version)
    listing = index(flow, version) or {"schema": "release-candidates-v1", "version": version,
                                       "candidates": [], "active": None}
    identity = {"repo": flow.repo.name, "version": version, "source": merge["source"],
                "target": merge["target"], "review_sha256": merge["review_sha256"],
                "recipe": {} if legacy else build_recipe()}
    key = digest(identity)
    if key in listing["candidates"]:
        require(key == listing["active"], "相同输入的旧候选已经被取代，不能重新启用。")
        return load(flow, version, key)[1]
    require(listing["active"] == replaces, "候选来源已变化，停止登记。")
    previous = load(flow, version, replaces)[1] if replaces else None
    requirements = list(previous["requirements"]) if previous else []
    for source, rows in (("decision", merge["target"]["release"].get("requirements", [])),
                         ("review", merge.get("release_requirements", []))):
        for item in rows:
            item = {"source": source, "pr": merge["target"]["pr"], "detail": item}
            requirements.append({"id": digest(item), **item})
    if not merge.get("release_requirements_confirmed"):
        item = {"source": "legacy-review", "pr": merge["target"]["pr"],
                "detail": "旧审阅未结构化列出发布前待办；须核对原决策、审阅和 Issue 并保存处理证据。"}
        requirements.append({"id": digest(item), **item})
    requirements = list({item["id"]: item for item in requirements}.values())
    row = {"schema": "release-candidate-v1", "id": key, "identity": identity, "version": version,
           "source": merge["source"], "number": len(listing["candidates"]) + 1, "merge": merge,
           "legacy": legacy, "replaces": replaces, "reason": reason, "requirements": requirements,
           "created_at": timestamp(), "recorded_by": actor()}
    row["decisions"] = list(dict.fromkeys([*(previous.get("decisions", []) if previous else []),
                                         merge["target"]["decision"]]))
    path = root / "candidates" / key / "candidate.json"
    # A crash between the immutable record and the index resumes the same record.
    if path.is_file():
        row = read(path)
        require(row["identity"] == identity and row["replaces"] == replaces, "未完成的候选登记与当前输入不符。")
    else:
        write(path, row)
    listing["candidates"].append(key)
    listing["active"] = key
    write(root / "candidates.json", listing)
    return row


def import_legacy(flow, version):
    """Index original files in place. Missing records never imply not published."""
    with locked(folder(flow, version), "candidate"):
        if index(flow, version):
            return current(flow, version)[1]
        path = flow.state / "merges" / (version + ".json")
        require(path.is_file(), "缺少原版本合入记录，待核对，不能推断为未发布。")
        merge = read(path)
        require(merge.get("phase") == "confirmed" and merge["target"]["release"]["version"] == version,
                "旧合入记录不完整。")
        receipt = optional(folder(flow, version) / "release.json")
        if receipt:
            require(receipt["source"] == merge["source"] and receipt["review_sha256"] == merge["review_sha256"],
                    "旧构建记录与合入不一致。")
        return _register(flow, merge, legacy=True)


def npm_state(name, version):
    try:
        with urlopen("https://registry.npmjs.org/" + quote(name, safe=""), timeout=15) as response:
            metadata = json.load(response)
    except HTTPError as exc:
        if exc.code == 404:
            return {"exists": False, "ever_published": False}
        raise WorkflowError(f"npm 查询失败（HTTP {exc.code}），版本状态待核对。") from exc
    except (URLError, OSError, ValueError) as exc:
        raise WorkflowError("npm 状态未查清，不能当作未发布。") from exc
    require(isinstance(metadata.get("versions"), dict), "npm 版本记录不完整，待核对。")
    entry = metadata["versions"].get(version)
    return {"exists": entry is not None, "ever_published": entry is not None or version in metadata.get("time", {}),
            "integrity": (entry or {}).get("dist", {}).get("integrity")}


def probe(flow, version):
    tag = "v" + version
    result = {"version": version, "repo": flow.repo.name, "checked_at": timestamp(),
              "refs": [], "releases": [], "npm": {}, "complete": False}
    def save_observation():
        result["external"] = bool(result["refs"] or result["releases"] or
                                  any(r["ever_published"] for r in result["npm"].values()))
        if result["external"] or result["complete"]:
            once(folder(flow, version) / "remote-checks" / (digest(result) + ".json"), result)
    refs = flow.repo.api("/git/matching-refs/tags/" + tag)
    require(isinstance(refs, list), "GitHub 标签状态未查清。")
    result["refs"] = [r for r in refs if r["ref"] == "refs/tags/" + tag]
    save_observation()
    releases = flow.repo.api("/releases?per_page=100", paginate=True)
    require(isinstance(releases, list), "GitHub 发行状态未查清。")
    result["releases"] = [r for r in releases if r["tag_name"] == tag]
    save_observation()
    for name in PACKAGES:
        result["npm"][name] = npm_state(name, version)
        save_observation()
    result["complete"] = True
    save_observation()
    return result


def journal_records(flow, version):
    root = folder(flow, version)
    records = []
    for directory in [root, *sorted((root / "candidates").glob("*"))]:
        for name in JOURNALS:
            path = directory / name
            if path.is_file():
                records.append({"file": str(path.relative_to(root)), "sha256": digest(path.read_bytes()), "record": read(path)})
    return records


def reconciled_journals(flow, version):
    return {(r["file"], r["sha256"]) for p in (folder(flow, version) / "reconciliations").glob("*.json")
            for r in read(p)["journals"]}


def settled_journals(state):
    """Read-only exceptions for next; archived bytes remain available as evidence."""
    result = set()
    for root in (state / "releases").glob("*"):
        for path in (root / "reconciliations").glob("*.json"):
            result.update((root / row["file"], row["sha256"]) for row in read(path)["journals"])
        for path in (root / "candidates").glob("*/legacy-publication.json"):
            if optional(path.parent / "publication.json").get("phase") == "github_published":
                result.update((root / row["file"], row["sha256"]) for row in read(path)["journals"])
    return result


def frozen_reasons(flow, version):
    root = folder(flow, version)
    reasons = []
    if any(read(p).get("external") for p in (root / "remote-checks").glob("*.json")):
        reasons.append("已观察到对外版本记录，删除远端记录也不会恢复修补")
    reconciled = reconciled_journals(flow, version)
    for row in journal_records(flow, version):
        if (row["file"], row["sha256"]) not in reconciled:
            reasons.append("已开始或记录过对外写入：" + row["file"])
    return reasons


def require_unpublished(flow, version):
    remote = probe(flow, version)
    reasons = frozen_reasons(flow, version)
    require(not remote["external"] and not reasons, "此版本不能同版修补：" + "；".join(reasons or ["已有对外记录"]))
    return remote


def check_repair(flow, release, base):
    version = release["version"]
    if not index(flow, version):
        import_legacy(flow, version)
    _, previous = current(flow, version, release.get("repair_of"))
    require(release.get("repair_of") == previous["id"] and isinstance(release.get("repair_reason"), str)
            and release["repair_reason"].strip(), "同版本修补须引用原候选并写明原因。")
    if previous["source"] != base:
        comparison = flow.repo.api(f"/compare/{previous['source']}...{base}")
        require(comparison.get("status") == "ahead" and
                comparison.get("merge_base_commit", {}).get("sha") == previous["source"],
                "当前主分支不包含原候选源码，不能沿用同版本修补。")
    require_unpublished(flow, version)
    return previous


def register_merge(flow, merge):
    version = merge["target"]["release"]["version"]
    if not index(flow, version) and (flow.state / "merges" / (version + ".json")).is_file():
        import_legacy(flow, version)
    with locked(folder(flow, version), "candidate"):
        listing = index(flow, version)
        for key in listing.get("candidates", []):
            _, existing = load(flow, version, key)
            if existing["source"] == merge["source"]:
                require(existing["merge"]["target"] == merge["target"] and
                        existing["merge"]["review_sha256"] == merge["review_sha256"], "重试的合入证据不一致。")
                legacy = flow.state / "merges" / (version + ".json")
                if not legacy.exists():
                    once(legacy, existing["merge"])
                once(flow.state / "merges" / version / (merge["source"] + ".json"), existing["merge"])
                return existing
        release = merge["target"]["release"]
        previous = listing.get("active")
        require(not previous or release.get("repair_of") == previous, "合入的同版本修补缺少当前原候选。")
        row = _register(flow, merge, replaces=previous, reason=release.get("repair_reason"))
        # The original version file remains untouched for old tools/readers.
        legacy = flow.state / "merges" / (version + ".json")
        if not legacy.exists():
            once(legacy, merge)
        once(flow.state / "merges" / version / (merge["source"] + ".json"), merge)
        return row


def begin_repair(flow, release, task, head):
    if not release or not release.get("repair_of"):
        return
    with locked(folder(flow, release["version"]), "candidate"):
        directory, row = current(flow, release["version"], release["repair_of"])
        # Publication may have started after submit's earlier material check.
        require_unpublished(flow, release["version"])
        record = {"candidate": row["id"], "task": task, "head": head, "reason": release["repair_reason"]}
        once(directory / "repairs" / (digest(record) + ".json"), record)


def publication_approval(flow, ask, row, receipt):
    from collab import granted, load_ask, open_decisions
    pending = [ask for task in row["decisions"] for ask in open_decisions(flow, task)]
    require(not pending, "候选相关决策尚待答复：" + "、".join(pending))
    _, record = load_ask(flow, ask)
    binds = record.get("binds", {})
    require(granted(record), "发布授权单尚未获得同意。")
    require(binds.get("repo") == flow.repo.name and binds.get("version") == row["version"] and
            binds.get("candidate") == row["id"] and
            binds.get("packages") == {p["name"]: p["sha256"] for p in receipt["packages"]},
            "发布授权须绑定当前仓库、版本、候选及整组安装包，不能沿用旧包授权。")
    return record


def publication_evidence(directory, row, receipt):
    from release import verify_isolated
    pending = readiness(directory, row)
    require(not pending, "发布前仍有待办：" + "；".join(pending))
    document = evidence(directory)
    require(document["packages"] == {p["name"]: p["sha256"] for p in receipt["packages"]},
            "发布证据与当前安装包不一致。")
    return verify_isolated(document["isolated_result"], {**receipt, "candidate": row["id"]})


def legacy_handoff(flow, directory, row, remote):
    """Continue the original legacy bytes; retain every original journal in place."""
    if not row["legacy"]:
        return False
    root = artifacts(flow, row)
    old = optional(root / "github.json")
    if not old or not remote["external"]:
        return False
    require(old.get("source") == row["source"] and remote["refs"], "旧发行来源或远端标签待核对。")
    require(old.get("phase") in ("tagging", "creating", "uploading", "confirmed", "published"),
            "旧发行步骤不完整，待核对。")
    require(bool(remote["releases"]) == (old["phase"] != "tagging"), "旧发行写入结果仍未查清，不能重试。")
    records = [r for r in journal_records(flow, row["version"]) if "/" not in r["file"]]
    once(directory / "legacy-publication.json", {"candidate": row["id"], "journals": records})
    for name in ("github.json", "finalize.json"):
        if (root / name).is_file() and not (directory / name).exists():
            write(directory / name, read(root / name))
    return True


def rebuild(flow, version, key, reason):
    require(key is not None, "重新构建须显式指定候选。")
    require(isinstance(reason, str) and reason.strip(), "重新准备候选须写明构建输入变化原因。")
    with locked(folder(flow, version), "candidate"):
        _, row = current(flow, version, key)
        require(flow.repo.main() == row["source"], "主分支已变化，先核对，不能重建旧源码。")
        require_unpublished(flow, version)
        require(row["identity"]["recipe"] != build_recipe(), "构建输入没有变化，继续原候选即可。")
        return _register(flow, row["merge"], replaces=key, reason=reason)


def check_remote_packages(remote, receipt):
    for ref in remote["refs"]:
        require(ref["object"]["type"] == "commit" and ref["object"]["sha"] == receipt["source"],
                "远端版本标签指向另一份源码。")
    require(len(remote["releases"]) <= 1, "远端存在多份同版本发行，先核对。")
    expected = {p["name"]: p["integrity"] for p in receipt["packages"]}
    for name, state in remote["npm"].items():
        require(not state["ever_published"] or state["exists"], "npm 版本曾经发布后被删除，不能重新占用。")
        require(not state["exists"] or state.get("integrity") == expected[name], "npm 上的包与本候选不同。")


def npm_publication(flow, version, key, approval=None, begin=False):
    require(key is not None, "npm 核对及发布准备须显式指定候选。")
    with locked(folder(flow, version), "candidate"):
        directory, row = current(flow, version, key)
        _, receipt = built_receipt(flow, row)
        require(publication_record(flow, row, "github.json").get("phase") == "published",
                "先完成本候选的 GitHub 发行。")
        remote = probe(flow, version)
        check_remote_packages(remote, receipt)
        states = {name: status["exists"] for name, status in remote["npm"].items()}
        path = directory / "npm-publish.json"
        if begin:
            require(flow.repo.main() == row["source"], "npm 发布前 main 已变化，先核对。")
            publication_evidence(directory, row, receipt)
            publication_approval(flow, approval, row, receipt)
            previous = optional(path)
            require(previous.get("phase") != "publishing", "npm 发布结果未知，先使用 --check-npm 核对。")
            require(not all(states.values()), "本候选两份包已在 npm，无需再次发布。")
            result = {"phase": "publishing", "candidate": key, "packages": receipt["packages"],
                      "approval": approval, "remote": remote, "at": timestamp()}
        else:
            result = {"phase": "published" if all(states.values()) else "partial" if any(states.values()) else "absent",
                      "candidate": key, "packages": receipt["packages"], "remote": remote, "at": timestamp()}
        once(directory / "npm-history" / (digest(result) + ".json"), result)
        write(path, result)
        return result


def record_evidence(flow, version, key, document):
    from release import verify_isolated
    from workflow import actor
    require(key is not None, "登记验证证据须显式指定候选。")
    with locked(folder(flow, version), "candidate"):
        directory, row = current(flow, version, key)
        _, receipt = built_receipt(flow, row)
        require(document.get("candidate") == key and document.get("source") == row["source"] and
                document.get("packages") == {p["name"]: p["sha256"] for p in receipt["packages"]},
                "处理证据不属于当前候选和安装包。")
        checks = document.get("requirements")
        require(isinstance(checks, dict) and set(checks) == {r["id"] for r in row["requirements"]},
                "发布前待办的逐项处理记录不完整。")
        for value in checks.values():
            require(value.get("status") in ("pass", "fail", "unconfirmed") and value.get("evidence"),
                    "待办须记录实际结果及证据。")
        if document.get("isolated"):
            proof = read(document["isolated"])
            verify_isolated(document["isolated"], {**receipt, "candidate": key}, require_pass=False)
            document = {**document, "isolated_result": proof}
        result = {**document, "at": timestamp(), "recorded_by": actor()}
        name = directory / "evidence" / (digest(result) + ".json")
        once(name, result)
        write(directory / "evidence.json", {"file": str(name.relative_to(directory)), "sha256": digest(name.read_bytes())})
        return {"record": str(name), **result}


def evidence(directory):
    pointer = optional(directory / "evidence.json")
    if not pointer:
        return {}
    path = directory / pointer["file"]
    require(directory.resolve() in path.resolve().parents and digest(path.read_bytes()) == pointer["sha256"],
            "候选证据指针或内容已变化。")
    return read(path)


def readiness(directory, row):
    if any((directory / "repairs").glob("*.json")):
        return ["此候选已登记修补，保留旧证据并等待替代候选"]
    document = evidence(directory)
    if not document:
        return ["登记本候选的发布前待办和隔离验收证据"]
    require(document.get("candidate") == row["id"] and document.get("source") == row["source"] and
            set(document.get("requirements", {})) == {r["id"] for r in row["requirements"]},
            "候选的发布前处理证据不匹配。")
    pending = [r["detail"] if isinstance(r["detail"], str) else r["detail"].get("title", "发布前事项")
               for r in row["requirements"] if document["requirements"][r["id"]]["status"] != "pass"]
    proof = document.get("isolated_result")
    if not proof or any(value.get("status") != "pass" for name, value in proof["checks"].items()
                        if name != "github_source_version_section"):
        pending.append("本候选尚未通过隔离验收")
    return pending


def reconcile(flow, version, document):
    from workflow import actor
    with locked(folder(flow, version), "candidate"):
        require(document.get("outcome") == "no_write" and document.get("evidence"), "需明确未写入的核对结论与依据。")
        journals = journal_records(flow, version)
        require(journals and document.get("journals") == {r["file"]: r["sha256"] for r in journals},
                "核对材料须绑定全部原始写入记录及内容。")
        require(not any(r["record"].get("phase") in ("confirmed", "published", "github_published", "partial") for r in journals),
                "已确认发生过的写入不能登记为未写入。")
        remote = probe(flow, version)
        require(not remote["external"] and not any(read(p).get("external") for p in
                (folder(flow, version) / "remote-checks").glob("*.json")), "已观察到对外记录，不能解除版本锁定。")
        result = {"version": version, "journals": journals, "evidence": document["evidence"],
                  "remote": remote, "outcome": "no_write", "at": timestamp(), "recorded_by": actor()}
        once(folder(flow, version) / "reconciliations" / (digest(result) + ".json"), result)
        return result


def view(flow, version):
    listing = index(flow, version)
    rows = []
    for key in listing.get("candidates", []):
        directory, row = load(flow, version, key)
        source = artifacts(flow, row)
        rows.append({**row, "current": listing["active"] == key, "artifacts": str(source),
                     "built": (source / "release.json").is_file(), "pending": readiness(directory, row),
                     "publication": publication_record(flow, row, "publication.json"),
                     "github": publication_record(flow, row, "github.json"),
                     "npm": publication_record(flow, row, "npm-publish.json")})
    return {"version": version, "active": listing.get("active"), "candidates": rows,
            "frozen_reasons": frozen_reasons(flow, version)}
