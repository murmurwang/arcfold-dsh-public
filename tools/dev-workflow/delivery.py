"""Stable human references over the existing execution receipts.

The counter journal is committed before the material. A failed write consumes a
number, never recycles it. Legacy records remain in place; migration adds a
checked index, not rewritten authorizations or invented historical authors.
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from common import WorkflowError, digest, git_line, locked, read, require, timestamp, write

NUMBER = r"(?:[0-9]{3}|[1-9][0-9]{3,})"
MATERIAL = re.compile(rf"({NUMBER})-([FDAR])([1-9][0-9]*)")
FEEDBACK = re.compile(rf"(?:{NUMBER}-|dev-)?F[1-9][0-9]*")
ASK = re.compile(rf"(?:{NUMBER}-)?A[1-9][0-9]*")
RELATIONS = {"context", "source", "acceptance", "reference"}


def provenance(source, author=None):
    from workflow import actor
    return {"source": source, "author": author or actor(), "recorded_by": actor(), "at": timestamp()}


def number(value):
    return isinstance(value, str) and bool(re.fullmatch(NUMBER, value)) and int(value) > 0


def json_or(path, fallback=None):
    return read(path) if path.is_file() else ({} if fallback is None else fallback)


def observation_order(row):
    return row.get("at", ""), row.get("sequence", 0)


def root(flow, key):
    require(number(key), "交付总号形如 001，至少三位且不能为零。")
    return flow.state / "deliveries" / key


def load(flow, key):
    path = root(flow, key) / "delivery.json"
    require(path.is_file(), f"没有交付 {key}。")
    return path, read(path)


def mappings(flow):
    return json_or(flow.state / "numbering-migration.json").get("mappings", {})


def resolve_task(flow, key):
    if number(key):
        return load(flow, key)[1]["task"]
    match = MATERIAL.fullmatch(key or "")
    if match and match[2] == "D":
        return decision(flow, key)[1]["task"]
    return key


def task_metadata(flow, record):
    if record.get("delivery"):
        return record
    entry = mappings(flow).get("tasks", {}).get(record["id"])
    return {**record, **({"delivery": entry["delivery"], "decision_id": entry["decision"]} if entry else {})}


def owner(flow, key):
    return flow.task(key)[1].get("delivery")


def ensure_current(flow, task):
    if task.get("delivery"):
        _, current = load(flow, task["delivery"])
        require(current["task"] == task["id"], "此执行已被后续决策或重开执行取代，请使用当前交付总号。")
        state = delivery_state(flow, task["delivery"])
        require(state["status"] == "active", "此交付已暂停或取消，先按实际决定登记恢复。")


def highwater(flow, prefix):
    names = [p.name for p in (flow.state / "deliveries").glob("*")] if not prefix else []
    if prefix:
        names += [p.stem for p in (flow.state / "asks").glob("*.json")]
        names += [p.name for p in (flow.state / "feedback").glob("*")]
        names += [p.stem for folder in ("decisions", "reviews")
                  for p in (flow.state / "deliveries").glob(f"*/{folder}/*.json")]
    pattern = re.compile(re.escape(prefix) + (r"([1-9][0-9]*)" if prefix else rf"({NUMBER})"))
    return max((int(m[1]) for name in names if (m := pattern.fullmatch(name))), default=0)


def allocate(flow, prefix="", reservation_source=None):
    require(not prefix or prefix in ("F", "dev-F") or re.fullmatch(rf"{NUMBER}-[FDAR]", prefix), "无效编号序列。")
    path = flow.state / "numbering.json"
    with locked(flow.state, "numbering"):
        journal = json_or(path, {"sequences": {}, "reservations": {}})
        count = max(journal["sequences"].get(prefix, 0), highwater(flow, prefix)) + 1
        item = prefix + str(count) if prefix else str(count).zfill(3)
        journal["sequences"][prefix] = count
        journal["reservations"][item] = {"status": "reserved", **provenance("entry allocation")}
        if reservation_source:
            journal["reservations"][item]["reservation_source"] = reservation_source
        write(path, journal)
    return item


def complete(flow, item, path):
    with locked(flow.state, "numbering"):
        journal = read(flow.state / "numbering.json")
        journal["reservations"][item].update(status="recorded", path=str(Path(path).relative_to(flow.state)))
        write(flow.state / "numbering.json", journal)


def reservations(flow):
    return [{"id": key, **row} for key, row in json_or(flow.state / "numbering.json").get("reservations", {}).items()
            if row["status"] != "recorded"]


def event(flow, key, action, *, evidence=None, **details):
    if not key:
        return
    directory = root(flow, key) / "history"
    with locked(directory, "append"):
        sequence = max((read(p).get("sequence", 0) for p in directory.glob("*.json")), default=0) + 1
        row = {"action": action, "evidence": evidence, "sequence": sequence, **provenance(action), **details}
        path = directory / (f"{sequence:08d}-" + uuid.uuid4().hex + ".json")
        write(path, row)
    return row


def history(flow, key):
    return sorted((read(p) for p in (root(flow, key) / "history").glob("*.json")), key=lambda x: x.get("sequence", 0))


def delivery_state(flow, key):
    changes = [row for row in history(flow, key) if row["action"] == "state"]
    return changes[-1] if changes else {"status": "active"}


def set_state(flow, key, status, reason, text):
    from workflow import text_field
    load(flow, key)
    require(status in ("active", "paused", "cancelled"), "状态为 active、paused 或 cancelled。")
    text_field(reason, "状态变更原因")
    text_field(text, "开发者指示或已确认规则的原文")
    with locked(root(flow, key), "delivery"):
        return event(flow, key, "state", status=status, reason=reason, text=text, author="开发者")


def register(flow, request):
    from workflow import HERE, actor, inside_scope, registered_scope, task_id, text_field
    title = text_field(request.get("title"), "问题标题")
    source = text_field(request.get("authorization_ref"), "问题来源")
    observed = text_field(request.get("observed_in_version"), "问题发生时的版本")
    require("\n" not in title and "\n" not in observed, "问题标题和发生版本分别使用一行。")
    scope = registered_scope(request["scope"])
    with locked(flow.state, "registration"):
        require(json_or(flow.state / "migration-attempt.json").get("phase") != "applying",
                "上次编号迁移未完成，先用同一对照恢复，不能开始新的登记。")
        key = task_id(request["id"]) if request.get("id") else None
        if key:
            require(not number(key), "交付总号由入口分配，内部任务别名不能使用纯数字总号。")
            require(not (flow.state / "tasks" / key).exists(), "同编号已登记。")
        total = allocate(flow)
        key = key or "delivery-" + total
        require(not (flow.state / "tasks" / key).exists(), "任务目录已存在；交付号已保留，不能复用。")
        note_path = f"docs/notes/{key}.md"
        if not inside_scope(note_path, scope):
            scope = [*scope, note_path]
        item = allocate(flow, total + "-D")
        folder = flow.state / "tasks" / key
        body = (HERE / "decision-template.md").read_text().format(
            title=f"[{item}] {title}", observed=observed, source=source)
        write(folder / "decision.md", body.encode())
        task = {"id": key, "title": title, "scope": scope, "repository": flow.repo.name, "delivery": total,
                "decision_id": item, "contributors": [actor()], "phase": "draft", "created_at": timestamp()}
        write(folder / "task.json", task)
        doc = {"id": item, "delivery": total, "task": key, "title": f"[{item}] {title}",
               "body": body, "sha256": digest(body.encode()), "previous": None, "status": "draft", **provenance(source)}
        docpath = root(flow, total) / "decisions" / (item + ".json")
        write(docpath, doc)
        master = {"id": total, "title": title, "task": key, "decision": item, "tasks": [key], "relations": [],
                  **provenance(source)}
        path = root(flow, total) / "delivery.json"
        write(path, master)
        complete(flow, item, docpath)
        complete(flow, total, path)
        event(flow, total, "registered", evidence=str(folder / "task.json"), decision=item)
        return {"id": total, "task": key, "decision_id": item, "decision": str(folder / "decision.md")}


def decision(flow, item):
    match = MATERIAL.fullmatch(item or "")
    require(match and match[2] == "D", "决策编号须带交付总号，例如 001-D1。")
    path = root(flow, match[1]) / "decisions" / (item + ".json")
    require(path.is_file(), f"没有决策 {item}。")
    return path, read(path)


def freeze(flow, task, raw, confirmation):
    item = task.get("decision_id")
    if not item:
        return
    path, doc = decision(flow, item)
    if doc.get("confirmation"):
        require(doc["sha256"] == digest(raw), "已确认正文改变须用 revise 新建下一份 D，不能覆盖确认。")
    doc.update(body=raw.decode(), sha256=digest(raw), status="confirmed", confirmation=confirmation)
    write(path, doc)
    event(flow, task["delivery"], "aligned", decision=item, evidence=str(path))


def check_frozen(flow, task, raw):
    if task.get("decision_id"):
        doc = decision(flow, task["decision_id"])[1]
        if doc.get("confirmation"):
            require(doc["sha256"] == digest(raw), "已确认正文改变须用 revise 新建下一份 D，并重新确认。")


def revise(flow, key, raw, scope=None, restart_reason=None):
    """New confirmed content => a new D; another execution can reuse the same D."""
    from workflow import actor, decision_note, inside_scope, registered_scope, text_field
    directory, old = flow.task(key)
    total = old.get("delivery")
    require(total, "旧任务先核对迁移对照，再使用交付内的决策修订。")
    with locked(root(flow, total), "delivery"), locked(directory, "task"):
        ensure_current(flow, old)
        masterpath, master = load(flow, total)
        docpath, doc = decision(flow, old["decision_id"])
        fields = decision_note(raw)
        chosen_scope = registered_scope(scope) if scope else old["scope"]
        if not doc.get("confirmation"):
            require(not restart_reason, "未确认的决策先编辑和确认。")
            raw = label_decision(raw, doc["id"])
            write(directory / "decision.md", raw)
            doc.update(body=raw.decode(), sha256=digest(raw), title=f"[{doc['id']}] {fields['title']}")
            write(docpath, doc)
            old.update(title=fields["title"], scope=chosen_scope)
            write(directory / "task.json", old)
            master.update(title=fields["title"])
            write(masterpath, master)
            event(flow, total, "draft-edited", decision=doc["id"], evidence=str(docpath))
            return {"id": total, "decision_id": doc["id"], "decision": str(directory / "decision.md")}
        if restart_reason:
            text_field(restart_reason, "重新执行原因")
            require(digest(raw) == doc["sha256"] and chosen_scope == old["scope"], "同 D 重新执行不能改变正文或范围。")
            item = doc["id"]
        else:
            require(digest(raw) != doc["sha256"] or chosen_scope != old["scope"], "正文与范围没有改变，无需新建决策。")
            item = allocate(flow, total + "-D")
            raw = label_decision(raw, item)
        newkey = f"delivery-{total}-d{item.split('-D')[1]}-e{len(master['tasks']) + 1}"
        note_path = f"docs/notes/{newkey}.md"
        if not inside_scope(note_path, chosen_scope):
            chosen_scope = [*chosen_scope, note_path]
        folder = flow.state / "tasks" / newkey
        require(not folder.exists(), "执行目录已存在，先核对上次结果。")
        task = {"id": newkey, "title": fields["title"], "scope": chosen_scope, "repository": flow.repo.name,
                "delivery": total, "decision_id": item, "phase": "draft", "contributors": [actor()],
                "created_at": timestamp(), "previous_task": old["id"]}
        write(folder / "decision.md", raw)
        write(folder / "task.json", task)
        if restart_reason:
            write(folder / "alignment.json", doc["confirmation"])
        else:
            newdoc = {"id": item, "delivery": total, "task": newkey, "title": f"[{item}] {fields['title']}",
                      "body": raw.decode(), "sha256": digest(raw), "previous": doc["id"], "status": "draft",
                      **provenance(doc["id"])}
            newpath = root(flow, total) / "decisions" / (item + ".json")
            write(newpath, newdoc)
            complete(flow, item, newpath)
        master.update(task=newkey, title=fields["title"], decision=item, tasks=[*master["tasks"], newkey])
        write(masterpath, master)
        event(flow, total, "execution-reopened" if restart_reason else "decision-revised", decision=item,
              previous_task=old["id"], task=newkey, reason=restart_reason, evidence=str(folder / "task.json"))
        return {"id": total, "task": newkey, "decision_id": item, "decision": str(folder / "decision.md")}


def label_decision(raw, item):
    text = raw.decode()
    line, sep, rest = text.partition("\n")
    for prefix in ("# 决策：", "# Agent Note: "):
        if line.startswith(prefix):
            title = re.sub(rf"^\[{NUMBER}-D[1-9][0-9]*\] ", "", line[len(prefix):])
            return (prefix + f"[{item}] " + title + sep + rest).encode()
    raise WorkflowError("决策标题不符合模板。")


def reference(flow, total, item, relation, note):
    from workflow import text_field
    text_field(note, "关联原因")
    require(relation in RELATIONS, "关联为 context、source、acceptance 或 reference。")
    require(MATERIAL.fullmatch(item or "") or FEEDBACK.fullmatch(item or "") or ASK.fullmatch(item or ""),
            "关联已有 F、D、A、R 的完整编号。")
    show(flow, item)
    if FEEDBACK.fullmatch(item):
        import delivery_feedback
        return delivery_feedback.link(flow, item, total, relation, note)
    with locked(root(flow, total), "delivery"):
        path, master = load(flow, total)
        row = {"id": item, "relation": relation, "note": note, **provenance(item)}
        master["relations"].append(row)
        write(path, master)
        event(flow, total, "material-linked", material=item, relation=relation, note=note)
        return row


def migration_preview(flow):
    """Read only. Proposed numbers are not reservations; apply rechecks all inputs."""
    current = mappings(flow)
    tasks = [read(p) for p in sorted((flow.state / "tasks").glob("*/task.json"))]
    old = sorted((t for t in tasks if not t.get("delivery") and t["id"] not in current.get("tasks", {})),
                 key=lambda t: (t.get("created_at", ""), t["id"]))
    counter = json_or(flow.state / "numbering.json").get("sequences", {}).get("", 0)
    start = max(counter, highwater(flow, ""))
    snapshot, plans = {}, []
    for offset, task in enumerate(old, 1):
        total = str(start + offset).zfill(3)
        path = flow.state / "tasks" / task["id"]
        for p in path.glob("*.json"):
            snapshot[str(p.relative_to(flow.state))] = digest(p.read_bytes())
        for p in path.glob("*.md"):
            snapshot[str(p.relative_to(flow.state))] = digest(p.read_bytes())
        asks = [p for p in (flow.state / "asks").glob("A*.json") if read(p).get("task") == task["id"]]
        asks.sort(key=lambda p: int(p.stem[1:]))
        askmap = {}
        for index, p in enumerate(asks, 1):
            snapshot[str(p.relative_to(flow.state))] = digest(p.read_bytes())
            askmap[p.stem] = f"{total}-A{index}"
        reviewmap = []
        for request in (flow.state / "prs").glob("*/*/request.json"):
            packet = read(request)
            if packet.get("target", {}).get("decision") != task["id"]:
                continue
            for p in request.parent.glob("*.json"):
                snapshot[str(p.relative_to(flow.state))] = digest(p.read_bytes())
            reviewmap.append({"run": str(request.parent.relative_to(flow.state)), "packet": packet["id"],
                              "at": json_or(request.parent / "attempt.json").get("started_at", "unknown")})
        reviewmap.sort(key=lambda r: (r["at"], r["run"]))
        for index, report in enumerate(reviewmap, 1):
            report["id"] = f"{total}-R{index}"
        plans.append({"task": task["id"], "delivery": total, "title": task["title"],
                      "decision": total + "-D1", "asks": askmap, "reviews": reviewmap})
    orphaned = [p.stem for p in (flow.state / "asks").glob("A*.json") if not read(p).get("task")]
    plan = {"schema": "delivery-migration-v1", "repo": flow.repo.name, "start": start, "tasks": plans,
            "unassigned_asks": sorted(orphaned), "snapshot": snapshot}
    return {**plan, "sha256": digest(plan)}


def migrate(flow, plan, confirmation):
    from workflow import text_field
    text_field(confirmation, "核对对照后的确认原话")
    with locked(flow.state, "registration"), locked(flow.state / "asks", "answers"), locked(flow.state / "asks", "numbering"):
        journal = flow.state / "migration-attempt.json"
        attempt = json_or(journal)
        if attempt.get("plan") == plan:
            if attempt["phase"] == "confirmed":
                return {"migrated": len(plan["tasks"]), "mappings": mappings(flow), "already_applied": True}
        else:
            require(attempt.get("phase") != "applying", "另一次迁移结果未确认，先恢复原对照。")
            require(plan == migration_preview(flow), "迁移对照或原记录已改变，重新预览并核对。")
            write(journal, {"phase": "applying", "plan": plan, "text": confirmation, **provenance("migration")})
        require(all((flow.state / name).is_file() and digest((flow.state / name).read_bytes()) == sha
                    for name, sha in plan["snapshot"].items()), "迁移原记录已改变，停止并核对。")

        def reserve(prefix, expected):
            prior = json_or(flow.state / "numbering.json").get("reservations", {}).get(expected)
            if prior:
                require(prior.get("reservation_source") == plan["sha256"], "拟迁移编号已经被其他内容使用。")
                return expected
            assigned = allocate(flow, prefix, plan["sha256"])
            require(assigned == expected, "编号已变化，停止迁移并保留已分配号码。")
            return assigned

        mappingpath = flow.state / "numbering-migration.json"
        previous = json_or(mappingpath, {"mappings": {"tasks": {}, "materials": {}}, "history": []})
        for row in plan["tasks"]:
            total = reserve("", row["delivery"])
            task = row["task"]
            folder = flow.state / "tasks" / task
            decisionpath = folder / "decision.md"
            body = decisionpath.read_bytes()
            confirmation_record = json_or(folder / "alignment.json")
            item = reserve(total + "-D", row["decision"])
            docpath = root(flow, total) / "decisions" / (item + ".json")
            doc = {"id": item, "delivery": total, "task": task, "title": f"[{item}] {row['title']}",
                   "body": body.decode(), "sha256": digest(body), "previous": None, "legacy_path": str(decisionpath),
                   "status": "confirmed" if confirmation_record else "draft",
                   **provenance(str(decisionpath), "unknown (legacy record)")}
            if confirmation_record:
                doc["confirmation"] = confirmation_record
            write(docpath, doc)
            complete(flow, item, docpath)
            masterpath = root(flow, total) / "delivery.json"
            write(masterpath, {"id": total, "title": row["title"], "task": task, "decision": item,
                               "tasks": [task], "relations": [], **provenance("checked migration", "unknown (legacy record)")})
            previous["mappings"]["tasks"][task] = {"delivery": total, "decision": item}
            for legacy, expected in row["asks"].items():
                new = reserve(total + "-A", expected)
                require(new == expected, "请求单映射编号不一致。")
                oldpath = flow.state / "asks" / (legacy + ".json")
                previous["mappings"]["materials"][new] = {"legacy": legacy, "delivery": total,
                                                          "path": str(oldpath.relative_to(flow.state))}
                complete(flow, new, oldpath)
            for report in row.get("reviews", []):
                item = reserve(total + "-R", report["id"])
                packet = read(flow.state / report["run"] / "request.json")
                path = root(flow, total) / "reviews" / (item + ".json")
                write(path, {"id": item, "delivery": total, "decision": row["decision"],
                             "fingerprint": packet["id"], "target": packet["target"], "run": report["run"],
                             "provider": packet.get("provider", "openai"), "reviewer": None,
                             **provenance(report["run"], "unknown (legacy independent reviewer)")})
                complete(flow, item, path)
            complete(flow, total, masterpath)
            write(mappingpath, previous)
            event(flow, total, "migrated", evidence=str(mappingpath), plan_sha256=plan["sha256"], text=confirmation)
        previous["history"].append({"plan": plan, "text": confirmation, **provenance("migration confirmation", "开发者")})
        write(mappingpath, previous)
        write(journal, {"phase": "confirmed", "plan": plan, "text": confirmation, **provenance("migration")})
        return {"migrated": len(plan["tasks"]), "mappings": previous["mappings"], "unassigned_asks": plan["unassigned_asks"]}


def reviews(flow, total):
    return sorted((read(p) for p in (root(flow, total) / "reviews").glob("*.json")),
                  key=lambda row: int(row["id"].split("-R")[1]))


def review_uncertainty(flow, run_dir, total=None):
    """Changing a proposal must not detach this delivery's unknown requests."""
    directories = {run_dir.parent}
    if total:
        directories.update((flow.state / r["run"]).parent for r in reviews(flow, total))
        for key in load(flow, total)[1]["tasks"]:
            folder, _ = flow.task(key)
            pr = json_or(folder / "submit.json").get("pr")
            if pr:
                directories.add(flow.state / "prs" / str(pr))
    result = []
    for directory in sorted(directories):
        probe = run_dir if directory == run_dir.parent else directory / "not-a-run"
        result.extend(flow.previous_review_uncertainty(probe))
    return result


def prepare_review(flow, pair_dir, target, packet, *, new=False):
    total = target.get("delivery")
    if not total:
        require(not new, "旧任务先核对编号迁移，再使用新的独立审阅请求。")
        return pair_dir, target
    candidates = [r for r in reviews(flow, total) if r["fingerprint"] == packet["id"]]
    if candidates:
        latest = candidates[-1]
        path = flow.state / latest["run"]
        if not new or not (path / "attempt.json").exists():
            return path, {**target, "review_id": latest["id"]}
    # Check every PR in this delivery, including another R for the same head.
    # New labels do not erase unknown requests or unsettled relay billing.
    uncertain = review_uncertainty(flow, pair_dir.with_name("not-a-run"), total)
    require(not uncertain, "旧审阅请求结果或费用未知，先核对，不能用新 R 绕过。")
    item = allocate(flow, total + "-R")
    run = pair_dir.with_name(pair_dir.name + "-" + item)
    from desktop_review_request import MODEL, RELAY_MODEL
    record = {"id": item, "delivery": total, "decision": target.get("decision_id"),
              "fingerprint": packet["id"], "target": {**target, "review_id": item},
              "run": str(run.relative_to(flow.state)), "provider": packet.get("provider"),
              "reviewer": RELAY_MODEL if packet.get("provider") == "lmuai" else MODEL,
              **provenance("fixed review packet")}
    record["author"] = "independent reviewer (not yet returned)"
    path = root(flow, total) / "reviews" / (item + ".json")
    write(path, record)
    complete(flow, item, path)
    event(flow, total, "review-prepared", review=item, evidence=str(path))
    return run, record["target"]


def review_directory(flow, number, head, base):
    # A newer review for these commits takes precedence even if still waiting.
    candidates = [read(p) for p in (flow.state / "deliveries").glob("*/reviews/*.json")]
    candidates = [r for r in candidates if (r["target"]["pr"], r["target"]["head"], r["target"]["base"]) ==
                  (number, head, base)]
    if candidates:
        selected = max(candidates, key=lambda r: (r["at"], int(r["id"].split("-R")[1])))
        return flow.state / selected["run"]
    return flow.state / "prs" / str(number) / (head + "-" + base)


def review_view(flow, row):
    directory = flow.state / row["run"]
    records = {name: json_or(directory / (name + ".json")) for name in
               ("request", "estimate", "attempt", "response", "receipt", "comment", "billing-reconciliation", "result-reconciliation", "advisories")}
    receipt, response, attempt = records["receipt"], records["response"], records["attempt"]
    status, conclusion = "prepared", None
    if receipt:
        # Re-validate archived source and output locally; a status label alone
        # cannot manufacture an independent conclusion.
        try:
            from desktop_review_request import validate
            packet = records["request"]
            require(digest({k: v for k, v in packet.items() if k != "id"}) == packet.get("id"), "送审材料摘要不符")
            require(digest({k: v for k, v in receipt.items() if k != "sha256"}) == receipt.get("sha256"), "回执摘要不符")
            require(receipt["target"] == row["target"] == packet["target"] and
                    receipt["packet"] == packet["id"] == attempt["packet"] and
                    receipt["attempt"] == attempt["client_request_id"], "审阅没有绑定此报告的实际代码与请求")
            require(receipt["review"] == validate(records["request"], response), "回执不是对应的独立报告")
            status, conclusion = "returned", receipt["verdict"]
        except (WorkflowError, KeyError, ValueError, TypeError):
            status = "unconfirmed"
    elif response:
        status = "failed" if flow.review_result_reconciled(attempt, records["result-reconciliation"]) else "returned-unvalidated"
    elif attempt:
        reconciled = flow.review_result_reconciled(attempt, records["result-reconciliation"])
        status = "failed" if attempt.get("request_sent") is False or reconciled else "unknown"
    reviewer = (receipt.get("review") or {}).get("model") or row.get("reviewer")
    return {**row, "status": status, "conclusion": conclusion, "reviewer": reviewer,
            "author": reviewer if response and reviewer else "independent reviewer (not yet confirmed)", "records": records}


def show(flow, item):
    from collab import all_asks, load_ask, task_progress
    import delivery_feedback as feedback
    reserved = json_or(flow.state / "numbering.json").get("reservations", {}).get(item)
    if reserved and reserved["status"] == "reserved":
        return {"id": item, **reserved, "note": "编号已预留但登记未完成，先核对原写入；号码不会回收。"}
    if item == "dev":
        return {"target": "dev", "feedback": feedback.all_feedback(flow, "dev")}
    if FEEDBACK.fullmatch(item or ""):
        return feedback.load(flow, item)[1]
    if ASK.fullmatch(item or ""):
        return load_ask(flow, item)[1]
    match = MATERIAL.fullmatch(item or "")
    if match and match[2] == "D":
        _, doc = decision(flow, item)
        if not doc.get("confirmation"):
            draft = flow.state / "tasks" / doc["task"] / "decision.md"
            doc.update(body=draft.read_text(), sha256=digest(draft.read_bytes()))
        _, master = load(flow, match[1])
        doc["status"] = "superseded" if master["decision"] != item else doc["status"]
        return doc
    if match and match[2] == "R":
        path = root(flow, match[1]) / "reviews" / (item + ".json")
        require(path.is_file(), f"没有审阅报告 {item}。")
        return review_view(flow, read(path))
    if not number(item):
        _, task = flow.task(item)
        if not task.get("delivery"):
            return {"task": task, "note": "旧记录尚未建立编号映射", "decision": (flow.task(item)[0] / "decision.md").read_text()}
        item = task["delivery"]
    _, master = load(flow, item)
    directory, task = flow.task(master["task"])
    asks = all_asks(flow)
    mine = [a for a in asks if a.get("delivery") == item or a.get("task") in master["tasks"]]
    feedbacks = [f for f in feedback.all_feedback(flow) if any(link["delivery"] == item for link in f["links"])]
    docs = [show(flow, p.stem) for p in (root(flow, item) / "decisions").glob("*.json")]
    reports = [review_view(flow, r) for r in reviews(flow, item)]
    # Read all execution generations, including rejected/replaced proposals.
    executions, versions = [], []
    for key in master["tasks"]:
        folder, record = flow.task(key)
        execution = {"task": record, "submit": json_or(folder / "submit.json"),
                     "alignment": json_or(folder / "alignment.json"), "retired": json_or(folder / "retired.json"),
                     "observations": [read(p) for p in (folder / "observations").glob("*.json")]}
        pr = execution["submit"].get("pr")
        if pr:
            execution["merge"] = json_or(flow.state / "prs" / str(pr) / "merge-attempt.json")
            execution["legacy_review_runs"] = [str(p.parent.relative_to(flow.state)) for p in
                                                 (flow.state / "prs" / str(pr)).glob("*/request.json")]
        executions.append(execution)
    for path in (flow.state / "releases").glob("*/release.json"):
        release = read(path)
        if release.get("target", {}).get("decision") in master["tasks"]:
            versions.append({"release": release, **{name: json_or(path.parent / (name + ".json"))
                             for name in ("github", "finalize", "npm-publish", "isolated")}})
    observations = sorted((o for e in executions for o in e["observations"]), key=observation_order)
    current_observations = executions[-1]["observations"] if executions else []
    latest = max(current_observations, key=observation_order, default={})
    state = task_progress(flow, directory, task, [a for a in asks if a["status"] == "open"])
    from collab import pending_writes
    uncertain = pending_writes(flow.state)
    paths = ["tasks/" + key + "/" for key in master["tasks"]]
    paths += ["prs/" + str(e["submit"]["pr"]) + "/" for e in executions if e["submit"].get("pr")]
    paths += ["releases/" + v["release"]["version"] + "/" for v in versions]
    pending = [r for r in uncertain if any(r["file"].startswith(p) for p in paths)]
    references = []
    for ref in master["relations"]:
        # References do not recursively expand other deliveries (or confer authority).
        references.append(ref)
    return {**master, "progress": state, "state": delivery_state(flow, item),
            "materials": {"D": docs, "A": mine, "F": feedbacks, "R": reports, "references": references},
            "executions": executions, "history": history(flow, item), "releases": versions, "observations": observations,
            "published": any(v["npm-publish"].get("phase") == "published" for v in versions),
            "accepted": latest.get("outcome") == "pass", "acceptance": latest.get("outcome", "unconfirmed"),
            "pending": {"asks": [a["id"] for a in mine if a["status"] == "open"],
                        "feedback": [f["id"] for f in feedbacks if f["status"] == "pending"],
                        "writes": pending, "review_findings": [r["records"].get("receipt", {}).get("review", {}).get("result", {}).get("findings", []) for r in reports]}}


def accept_dev(flow, key, feedback_id, outcome):
    import delivery_feedback as feedback
    require(outcome in ("pass", "fail", "unconfirmed"), "验收结论须为 pass、fail 或 unconfirmed。")
    directory, task = flow.task(key)
    ensure_current(flow, task)
    require(task.get("delivery"), "先核对旧任务编号迁移。")
    require(flow.check(key)["fixed_in"] == "pending", "安装包发行交付使用 close-loop 核对实际版本。")
    _, observation = feedback.load(flow, feedback_id)
    submit = json_or(directory / "submit.json")
    merge = json_or(flow.state / "prs" / str(submit.get("pr")) / "merge-attempt.json")
    require(merge.get("phase") == "confirmed" and merge.get("target", {}).get("decision") == task["id"],
            "此执行尚无已确认的合入记录。")
    source = merge["source"]
    if outcome == "pass":
        require(observation["target"] == "dev" and observation.get("version", {}).get("commit") == source
                and observation.get("version", {}).get("dirty") is False,
                "通过须有对应已合入入口版本的实际 dev 反馈；版本未知或有改动时保持未确认。")
    with locked(directory, "task"):
        result = {"decision": task["id"], "decision_id": task["decision_id"], "source": source,
                  "feedback": feedback_id, "outcome": outcome, "user_verified": observation["text"],
                  "sequence": len(list((directory / "observations").glob("*.json"))) + 1,
                  **provenance(feedback_id, observation["provider"])}
        # Source identifies the actual code; feedback source remains explicit.
        result["source"] = source
        path = directory / "observations" / (uuid.uuid4().hex + ".json")
        write(path, result)
        write(directory / "user-verification.json", result)
    feedback.link(flow, feedback_id, task["delivery"], "acceptance", "实际入口验收")
    feedback.resolved(flow, feedback_id, str(path), outcome)
    event(flow, task["delivery"], "accepted", evidence=str(path), outcome=outcome, feedback=feedback_id)
    return result
