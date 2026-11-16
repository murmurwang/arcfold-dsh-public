"""Track reviewed source deliveries separately from release version assembly.

Candidate/package history remains owned by release_candidates (when installed).
This module only records which managed source merges an assembly must include.
"""
from pathlib import Path
import json
import re

from common import digest, git_line, locked, read, require, timestamp, write

VERSION_FILES = {"package.json", "packages/method-ui/package.json", "package-lock.json", "CHANGELOG.md"}


def reserve_target(flow, task, note):
    if note.get("release_mode") != "assembly":
        return
    version = note["fixed_in"]
    require(re.fullmatch(r"\d+\.\d+\.\d+", version), "发行组装须先确定目标版本。")
    root = flow.state / "release-targets"
    with locked(root, "records"):
        path = root / (version + ".json")
        if path.exists():
            previous = read(path)
            if previous["task"] != task["id"]:
                owner, _ = flow.task(previous["task"])
                require((owner / "retired.json").exists(), "已有发行组装占用此版本：" + previous["task"])
                write(root / "history" / (digest(previous) + ".json"), previous)
        write(path, {"task": task["id"], "version": version, "decision_sha256": note["sha256"], "at": timestamp()})


def headers(header):
    fields = {}
    for name in ("release_mode", "release_note", "release_base", "release_includes"):
        values = re.findall(rf"(?m)^{name}: ([^\n]+)$", header)
        require(len(values) <= 1, "发行字段重复：" + name)
        if values:
            fields[name] = values[0].strip()
    mode = fields.get("release_mode")
    require(mode in (None, "source", "assembly"), "release_mode 使用 source 或 assembly。")
    if mode == "source":
        require(fields.get("release_note"), "待发行源码须写自己的改动说明 release_note。")
    if mode == "assembly":
        require(re.fullmatch(r"[a-f0-9]{40}", fields.get("release_base", "")), "发行组装须明确已登记发行的源码起点。")
        includes = fields.get("release_includes", "").split(",")
        require(includes and all(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9-]{1,79}", v) for v in includes)
                and len(set(includes)) == len(includes), "release_includes 须逐项列出待发行任务，不得重复。")
        fields["release_includes"] = sorted(includes)
    return fields


def ancestor(checkout, source, head):
    return git_line(checkout, "merge-base", source, head) == source


def managed_merges(flow):
    result = {}
    for path in (flow.state / "prs").glob("*/merge-attempt.json"):
        row = read(path)
        if row.get("phase") == "confirmed":
            result[row["source"]] = row
    return result


def pending(flow, checkout, head):
    assemblies = [read(p) for p in (flow.state / "release-assemblies").glob("*.json")]
    included = {key for row in assemblies if ancestor(checkout, row["source"], head)
                for key in row["target"]["release"]["includes"]}
    return [read(p) for p in sorted((flow.state / "source-deliveries").glob("*.json"))
            if (row := read(p))["target"]["decision"] not in included and ancestor(checkout, row["source"], head)]


def validate_merge(flow, checkout, row):
    target = row["target"]
    require(row["phase"] == "confirmed" and row.get("review_sha256") and row.get("review_comment"),
            "源码合入缺少已确认的独立审阅来源。")
    require(git_line(checkout, "rev-parse", row["source"] + "^{tree}") == target["tree"] and
            git_line(checkout, "show", "-s", "--format=%P", row["source"]).split() == [target["base"]],
            "源码合入的实际文件或父提交与回执不一致。")
    directory = flow.state / "prs" / str(target["pr"]) / (target["head"] + "-" + target["base"])
    paths = [directory / (name + ".json") for name in ("receipt", "request", "attempt", "response", "comment")]
    require(all(path.is_file() for path in paths), "源码来源缺少可回查的完整独立审阅证据。")
    receipt, packet, attempt, response, comment = map(read, paths)
    require(receipt["sha256"] == row["review_sha256"] == digest({k: v for k, v in receipt.items() if k != "sha256"}) and
            receipt["target"] == packet["target"] == target and
            packet["id"] == digest({k: v for k, v in packet.items() if k != "id"}) == receipt["packet"] == attempt["packet"] and
            receipt["attempt"] == attempt["client_request_id"] and receipt["verdict"] == "pass" and
            comment.get("phase") == "confirmed" and comment.get("url") == row["review_comment"],
            "源码独立审阅与已合入的固定材料不一致。")
    # Bind the original saved conclusion; do not reinterpret an old model's
    # receipt using today's provider/model/pricing configuration.
    raw, review = response["response"], receipt["review"]
    messages = [item for item in raw["output"] if item["type"] == "message"]
    require(len(messages) == 1 and len(messages[0]["content"]) == 1 and
            messages[0]["content"][0]["type"] == "output_text" and
            json.loads(messages[0]["content"][0]["text"]) == review["result"] and
            raw["status"] == "completed" and raw["model"] == review["model"] and raw["usage"] == review["usage"] and
            review["result"]["packet"] == packet["id"] and review["response_id"] == raw["id"] and
            review["provider_request_id"] == response["provider_request_id"] and not receipt["blocking_checks"],
            "源码独立审阅结论缺少原始响应或仍有阻塞项。")


def plan(flow, checkout, head, baseline):
    merges = managed_merges(flow)
    require(baseline in merges and (merges[baseline]["target"].get("release") or {}).get("version"),
            "发行起点必须是已有受管发行合入，不能任选历史提交。")
    validate_merge(flow, checkout, merges[baseline])
    require(ancestor(checkout, baseline, head), "当前源码不包含指定发行起点。")
    commits = git_line(checkout, "rev-list", "--reverse", baseline + ".." + head).splitlines()
    sources, history = [], []
    for sha in commits:
        require(sha in merges, "源码包含未核对的合入，不能从发行清单隐去：" + sha[:7])
        row = merges[sha]
        validate_merge(flow, checkout, row)
        release = row["target"].get("release") or {}
        require(not release.get("version"), "区间已有另一次发行组装，应从该受管发行起点重新核对。")
        history.append({"source": sha, "task": row["target"]["decision"], "review_sha256": row["review_sha256"]})
        if release.get("kind") == "source":
            sources.append({"task": row["target"]["decision"], "source": sha, "note": release["note"],
                            "review_sha256": row["review_sha256"]})
    require(sources, "指定区间没有待发行的插件源码。")
    return {"base": baseline, "head": head, "includes": sorted(s["task"] for s in sources),
            "sources": sources, "history": history}


def check_release(flow, checkout, task, base, paths, note, release):
    if not release or release.get("kind") == "source":
        return release
    if note.get("release_mode") != "assembly":
        require(not pending(flow, checkout, base), "当前包含待发行源码，须使用 assembly 完整登记来源。")
        return release  # Legacy single-task version changes remain valid without pending source.
    allowed = VERSION_FILES | {"docs/notes/" + task["id"] + ".md"}
    require(set(paths) <= allowed, "发行组装只改版本信息与本项决策，功能源码须先分别受管合入。")
    manifest = plan(flow, checkout, base, note["release_base"])
    from task_access import resolve
    included = sorted(resolve(flow, key, current=False)[1]["id"] for key in note["release_includes"])
    require(manifest["includes"] == included, "发行清单没有完整对应实际源码中的待发行任务。")
    return {**release, "kind": "assembly", **manifest}


def register_merge(flow, merge):
    release = merge["target"].get("release") or {}
    if release.get("kind") == "source":
        path = flow.state / "source-deliveries" / (merge["target"]["decision"] + ".json")
    elif release.get("kind") == "assembly":
        path = flow.state / "release-assemblies" / (merge["source"] + ".json")
    else:
        return
    if path.is_file():
        saved = read(path)
        require(all(saved.get(k) == merge.get(k) for k in ("source", "target", "review_sha256", "review_comment")),
                "既有源码交付或发行归属不可覆盖。")
    else:
        write(path, merge)


def publication_for(flow, task):
    """Read-only relationship; actual publication/acceptance remain separate."""
    rows = [read(p) for p in (flow.state / "release-assemblies").glob("*.json")]
    return [row for row in rows if task in row["target"]["release"]["includes"]]
