"""Fair local ordering of explicitly requested merges, never automatic approval."""
import time

from common import digest, locked, read, require, timestamp, write


def folder(flow):
    return flow.state / "merge-queue"


def enqueue(flow, target):
    number = target["pr"]
    with locked(folder(flow), "records"):
        path = folder(flow) / (str(number) + ".json")
        old = read(path) if path.exists() else {}
        if old.get("target") == target and not old.get("cancelled"):
            return old
        if old:
            write(folder(flow) / "history" / (digest(old) + ".json"), old)
        row = {"pr": number, "target": target, "requested_ns": old.get("requested_ns", time.time_ns()),
               "updated_at": timestamp()}
        write(path, row)
        return row


def view(flow, base=None):
    from collab import open_decisions
    rows = []
    for path in folder(flow).glob("*.json"):
        row = read(path)
        result = {"pr": row["pr"], "target": row["target"], "requested_ns": row["requested_ns"],
                  "state": "needs-recheck", "waiting": []}
        journal = flow.state / "prs" / str(row["pr"]) / "merge-attempt.json"
        known = read(journal) if journal.exists() else {}
        if known.get("phase") == "merging":
            result.update(state="unknown", reason="先核对原 GitHub 合入，不自动重发")
        elif row.get("cancelled"):
            result.update(state="cancelled", reason=row["cancelled"])
        elif known.get("phase") == "confirmed":
            result["state"] = "confirmed"
        else:
            decision = row["target"]["decision"]
            directory, task = flow.task(decision)
            if (directory / "retired.json").exists() or task["phase"] != "open":
                result["waiting"].append("任务未开放或已退场")
            if open_decisions(flow, decision):
                result["waiting"].append("本任务仍有未答决定单")
            if base is not None and row["target"]["base"] != base:
                result["waiting"].append("需要与当前主线重新组合、检查和审阅")
            if result["waiting"]:
                result["state"] = "waiting"
            elif base is not None:
                result["state"] = "ready"
        rows.append(result)
    return sorted(rows, key=lambda row: row["requested_ns"])


def require_turn(flow, target):
    # File-lock release is not evidence that a previous remote write failed.
    for path in (flow.state / "prs").glob("*/merge-attempt.json"):
        row = read(path)
        require(row.get("phase") != "merging" or path.parent.name == str(target["pr"]),
                "另一主线写入结果未知，先核对 PR #" + path.parent.name)
    ready = [row for row in view(flow, target["base"]) if row["state"] == "ready"]
    require(ready and ready[0]["pr"] == target["pr"],
            "先处理已就绪且等待更久的合入：" + ("PR #" + str(ready[0]["pr"]) if ready else "无可合入候选"))


def cancel(flow, number, reason):
    require(isinstance(reason, str) and reason.strip(), "退出排队须记录实际原因。")
    with locked(folder(flow), "records"):
        path = folder(flow) / (str(number) + ".json")
        row = read(path)
        row.update(cancelled=reason, cancelled_at=timestamp())
        write(path, row)
    return row
