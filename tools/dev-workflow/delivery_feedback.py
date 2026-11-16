"""Feedback keeps its original number and words; classification is append-only."""
from pathlib import Path
import re

import delivery
from common import WorkflowError, digest, git_line, locked, read, require, timestamp, write


def entry_version():
    here = Path(__file__).resolve().parent
    try:
        commit = git_line(here, "rev-parse", "HEAD")
        changed = git_line(here, "status", "--porcelain", "--", ".")
        files = {path.name: digest(path.read_bytes()) for path in here.glob("*") if path.is_file()}
        return {"commit": commit, "dirty": bool(changed), "files": files, "checked_at": timestamp()}
    except (WorkflowError, OSError) as exc:
        return {"commit": "unknown", "reason": str(exc), "checked_at": timestamp()}


def load(flow, item):
    require(isinstance(item, str) and delivery.FEEDBACK.fullmatch(item), "反馈编号形如 001-F1、F1 或 dev-F1。")
    path = flow.state / "feedback" / item / "feedback.json"
    require(path.is_file(), f"没有反馈 {item}。")
    record = read(path)
    record.setdefault("provider", "unknown (legacy record)")
    record.setdefault("author", record["provider"])
    record.setdefault("target", "unknown")
    record.setdefault("original_target", record["target"])
    record.setdefault("links", [])
    record.setdefault("routes", [])
    record.setdefault("status", "pending")
    record["corrections"] = [p.parent.name for p in (flow.state / "feedback").glob("*/feedback.json")
                             if read(p).get("corrects") == item]
    record["history"] = delivery.json_or(path.parent / "history.json", [])
    removed = set()
    for event in record["history"]:
        if event["action"] == "classify":
            record["target"] = event["target"]
            if event.get("version"):
                record["version"] = event["version"]
        elif event["action"] == "link":
            record["links"].append(event)
            removed.discard((event["delivery"], event["relation"]))
        elif event["action"] == "unlink":
            removed.add((event["delivery"], event["relation"]))
            record["links"] = [link for link in record["links"]
                               if (link["delivery"], link["relation"]) != (event["delivery"], event["relation"])]
        elif event["action"] == "route":
            record["routes"].append(event)
        elif event["action"] == "status":
            record["status"] = event["status"]
        elif event["action"] == "attach":
            record["attachments"] += event["attachments"]
    # Existing routes are sources of association, never proof that an issue was solved.
    for row in record["routes"]:
        if ":" in row["to"] and row["to"].split(":", 1)[0] in ("new", "close-loop"):
            key = row["to"].split(":", 1)[1]
            try:
                total = delivery.owner(flow, key)
            except WorkflowError:
                total = None
            relation = "source" if row["to"].startswith("new:") else "acceptance"
            if total and (total, relation) not in removed and not any(link["delivery"] == total and link["relation"] == relation for link in record["links"]):
                record["links"].append({"delivery": total, "relation": relation, "source": "legacy route", **row})
    return path, record


def all_feedback(flow, target=None):
    records = [load(flow, p.parent.name)[1] for p in (flow.state / "feedback").glob("*/feedback.json")
               if delivery.FEEDBACK.fullmatch(p.parent.name)]
    return sorted((r for r in records if target is None or r["target"] == target), key=lambda r: (r["at"], r["id"]))


def append(flow, item, action, **details):
    directory = flow.state / "feedback" / item
    with locked(directory, "history"):
        load(flow, item)
        path = directory / "history.json"
        rows = delivery.json_or(path, [])
        row = {"action": action, **delivery.provenance(item), **details}
        write(path, [*rows, row])
    return load(flow, item)[1]


def attachments(directory, values, prefix=""):
    files = []
    for index, value in enumerate(values, 1):
        source = Path(value).expanduser()
        require(source.is_file(), "附件文件不存在。")
        name = f"{prefix}{index:02d}-{source.name}"
        data = source.read_bytes()
        write(directory / "attachments" / name, data)
        files.append({"file": name, "sha256": digest(data), "bytes": len(data)})
    return files


def record(flow, text, files=(), *, total=None, target="unknown", provider="开发者", subject=None,
           context=None, source=None, corrects=None, related=None, version=None):
    from collab import daily_version
    from workflow import text_field
    text_field(text, "反馈原话")
    text_field(provider, "反馈提供者")
    require(target in ("product", "dev", "unknown"), "反馈对象为 product、dev 或 unknown。")
    if total:
        delivery.load(flow, total)
    if related:
        delivery.load(flow, related)
    prefix = total + "-F" if total else ("dev-F" if target == "dev" else "F")
    if corrects:
        _, old = load(flow, corrects)
        prefix = re.sub(r"[0-9]+$", "", corrects)
        oldtotal = corrects.split("-F")[0] if re.fullmatch(delivery.NUMBER + r"-F[1-9][0-9]*", corrects) else None
        require(not total or total == oldtotal, "实质更正沿用原反馈序列；其他交付另行建立关联。")
        total = oldtotal
    item = delivery.allocate(flow, prefix)
    directory = flow.state / "feedback" / item
    daily = daily_version()
    origin = source or ("correction of " + corrects if corrects else "developer feedback")
    record = {"id": item, "title": f"[{item}] {text.strip().splitlines()[0][:80]}", "text": text, "provider": provider, "target": target, "original_target": target,
              "daily": daily, "attachments": attachments(directory, files), "routes": [], "links": [],
              "status": "pending", "corrects": corrects, **delivery.provenance(origin, provider)}
    if target == "dev":
        record["version"] = version or entry_version()
        record["subject"] = subject or "未提供具体命令、界面或规则"
        record["context"] = context or "未提供执行现场；仅保留提供者原话"
    else:
        record["version"] = version or daily
    if total:
        record["links"].append({"delivery": total, "relation": "context", **delivery.provenance(origin, provider)})
    if related and related != total:
        record["links"].append({"delivery": related, "relation": "context", **delivery.provenance(origin, provider)})
    if corrects:
        for link in old["links"]:
            if not any((r["delivery"], r["relation"]) == (link["delivery"], link["relation"]) for r in record["links"]):
                record["links"].append({**link, "source": "correction of " + corrects})
    path = directory / "feedback.json"
    write(path, record)
    delivery.complete(flow, item, path)
    return record


def classify(flow, item, target, reason, version=None):
    from workflow import text_field
    require(target in ("product", "dev", "unknown"), "反馈对象为 product、dev 或 unknown。")
    text_field(reason, "分类依据")
    # The current checkout cannot be asserted to be the past execution version.
    if target == "dev" and version is None:
        version = {"commit": "unknown", "reason": "原记录未保存发生时的 dev 版本；不以当前版本或产品包版本代替"}
    return append(flow, item, "classify", target=target, reason=reason, version=version)


def link(flow, item, total, relation, note, remove=False):
    from workflow import text_field
    delivery.load(flow, total)
    require(relation in delivery.RELATIONS, "关联为 context、source、acceptance 或 reference。")
    text_field(note, "关联或纠正依据")
    return append(flow, item, "unlink" if remove else "link", delivery=total, relation=relation, note=note)


def route(flow, item, to, note=None):
    from workflow import ID
    match = re.fullmatch(rf"(close-loop|new):({ID})|issue:[1-9][0-9]*|note", to or "")
    require(match, "去向写成 close-loop:交付、new:交付、issue:编号 或 note。")
    if match[2]:
        flow.task(match[2])
    require(to != "note" or isinstance(note, str) and note.strip(), "只记录不处理时，写明原因。")
    with locked(flow.state / "feedback", "routes"):
        _, record = load(flow, item)
        require(all(row["to"] != to for row in record["routes"]), f"{item} 已经记过去向 {to}。")
        result = append(flow, item, "route", to=to, note=note)
        if to == "note":
            result = append(flow, item, "status", status="record-only", reason=note)
        return result


def resolved(flow, item, evidence, outcome):
    require(outcome in ("pass", "fail", "unconfirmed"), "反馈处理结果须有验收结论。")
    return append(flow, item, "status", status="resolved" if outcome == "pass" else "pending",
                  evidence=evidence, outcome=outcome)


def resolve_from_acceptance(flow, item, acceptance):
    path = Path(acceptance).resolve()
    require(path.is_relative_to(flow.state / "tasks") and path.parent.name == "observations" and path.is_file(),
            "使用本仓库入口保存的实际验收记录。")
    receipt = read(path)
    require(receipt.get("outcome") == "pass" and receipt.get("feedback"), "验收必须通过且引用实际反馈。")
    _, record = load(flow, item)
    _, accepted = load(flow, receipt["feedback"])
    total = delivery.owner(flow, receipt["decision"])
    require(total and any(link["delivery"] == total for link in record["links"])
            and any(link["delivery"] == total and link["relation"] == "acceptance" for link in accepted["links"]),
            "此验收与待解决反馈不属于同一交付。")
    return resolved(flow, item, str(path), "pass")


def add_attachments(flow, item, files, source):
    from workflow import text_field
    text_field(source, "附件补充来源")
    load(flow, item)
    import uuid
    added = attachments(flow.state / "feedback" / item, files, prefix=uuid.uuid4().hex + "-")
    require(added, "至少指定一个附件。")
    return append(flow, item, "attach", attachments=added, source=source)


def summaries(flow, *, pending=True, target=None):
    return [{"id": r["id"], "at": r["at"], "summary": r["text"].splitlines()[0][:120], "target": r["target"],
             "status": r["status"], "links": r["links"], "routes": r["routes"], "version": r.get("version"),
             "daily": r.get("daily", {}).get("packages", {})}
            for r in all_feedback(flow, target) if not pending or r["status"] == "pending"]
