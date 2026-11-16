"""Durable one-shot review queue. Requests in doubt retain the key reservation."""
from __future__ import annotations

from pathlib import Path
import re
import subprocess

from common import WorkflowError, digest, locked, read, require, timestamp, write
from review_policy import check_unsettled, dollars, execution_approval, key_root

HERE = Path(__file__).resolve().parent
ACTIVE = {"queued", "running", "billing_pending", "publication_pending"}
TERMINAL = {"complete", "cancelled", "stale", "settled_without_result", "invalid_result"}
LABELS = {
    "queued": "等待后台执行", "running": "执行中或等待恢复", "billing_pending": "结果已返回，等待费用核对",
    "publication_pending": "报告已生成，等待核对公开写入", "needs_unlock": "等待解锁钥匙串",
    "needs_reconciliation": "结果或费用待核对", "blocked": "条件不满足，等待处理",
    "complete": "审阅完成", "cancelled": "未发送任务已取消", "stale": "材料已变化，旧结果只供历史核对",
    "settled_without_result": "费用已核对，未取得有效审阅结论", "invalid_result": "回执校验失败",
}


def root(flow):
    return flow.state / "review-automation"


def profile(flow, name, *, require_current=True):
    require(isinstance(name, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,47}", name), "后台配置名称无效。")
    path = root(flow) / "profiles" / (name + ".json")
    require(path.is_file(), "后台审阅尚未安装，请先准备安装计划并取得授权。")
    row = read(path)
    from review_service import verify_installation
    runtime = verify_installation(row)
    require(not require_current or all((HERE / filename).is_file() and digest((HERE / filename).read_bytes()) == sha
                for filename, sha in runtime["files"].items()),
            "当前入口与后台安装版本不同，请重新核对安装计划。")
    metadata = Path(row["install_dir"]) / "credential.json"
    require(metadata.is_file(), "专用密钥尚未完成本机设置。")
    key = read(metadata)
    require(key.get("service") == row["service"] and key.get("account") == row["account"], "密钥登记对象不一致。")
    require(re.fullmatch(r"[a-f0-9]{64}", key.get("key_id", "")), "密钥标识无效。")
    return {**row, **key}


def job_path(flow, identifier):
    require(isinstance(identifier, str) and re.fullmatch(r"[a-f0-9]{64}", identifier), "队列任务编号无效。")
    return root(flow) / "jobs" / (identifier + ".json")


def save(flow, job, status, note=""):
    job["status"] = status
    job["updated_at"] = timestamp()
    job["note"] = note
    job.setdefault("events", []).append({"status": status, "at": job["updated_at"], "note": note})
    write(job_path(flow, job["id"]), job)
    return job


def summary(job):
    return {k: job[k] for k in ("id", "pr", "approval", "packet", "status", "note", "actual_cost_usd",
                                "remaining_usd", "receipt", "verdict", "attention_ask") if k in job} | {
        "next": LABELS[job["status"]]}


def status(flow):
    jobs = [read(path) for path in (root(flow) / "jobs").glob("*.json")]
    return [summary(job) for job in sorted(jobs, key=lambda job: job["created_at"])]


def enqueue(flow, number, ask, name):
    import desktop_review_request as reviewer
    installed = profile(flow, name)
    with locked(flow.state / "prs", str(number)):
        directory, target, files, _ = flow.preflight(number)
        packet = reviewer.packet_for(target, files, "lmuai")
        policy = execution_approval(flow, ask, packet["id"], installed["key_id"])
        identifier = digest({"repo": flow.repo.name, "approval": ask, "packet": packet["id"],
                             "key_id": installed["key_id"]})
        path = job_path(flow, identifier)
        if path.is_file():
            return summary(read(path))
        require(not (directory / "attempt.json").exists(), "该材料已有审阅尝试，请核对原结果，不能重复排队发送。")
        write(directory / "request.json", packet)
        write(directory / "estimate.json", {"packet": packet["id"], "target": target,
              "material": str(directory / "request.json"), **reviewer.estimate(packet),
              "approved_maximum_usd": policy["max_cost_usd"], "verified_bound_usd": policy["cost_bound_usd"]})
        job = {"id": identifier, "repo": flow.repo.name, "pr": number, "approval": ask, "packet": packet["id"],
               "target": target, "directory": str(directory), "profile": name, "key_id": installed["key_id"],
               "execution": policy, "installation": installed["manifest_sha256"],
               "created_at": timestamp(), "safe_attempts": 0}
        return summary(save(flow, job, "queued"))


def invoke(installed, directory, mode):
    require(mode in ("dispatch", "settle", "observe"), "执行模式无效。")
    # The native helper reads Keychain itself. Its output never contains the key.
    result = subprocess.run([str(Path(installed["install_dir"]) / "ReviewKeychain"),
                             mode, str(directory)], capture_output=True, timeout=1045,
                            env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"})
    if result.returncode == 77:
        raise WorkflowError("KEYCHAIN_LOCKED")
    require(result.returncode == 0, "审阅子进程未完成；原始状态已保留，请核对。")


def attention(flow, job, note):
    if not job.get("attention_ask"):
        from collab import create_ask
        attempt = read(Path(job["directory"]) / "attempt.json")
        item = create_ask(flow, {
            "kind": "act", "task": job["target"]["decision"], "title": "核对后台审阅的结果与实际扣费",
            "body": (f"PR #{job['pr']} 的后台审阅暂停。{note}\n"
                     f"请求编号：{attempt['client_request_id']}；材料：{job['packet']}。\n"
                     "请在服务用量页面核对该请求是否收到、是否扣费、实际金额和证据；回复本操作单并说明结果。"
                     "不需要提供密钥。核对完成前，这把密钥的后续审阅不会发送。"),
        })
        job["attention_ask"] = item["id"]


def reserve(flow, job):
    directory = key_root(flow, job["key_id"])
    path = directory / "reservation.json"
    with locked(directory, "control"):
        previous = read(path) if path.is_file() else {}
        require(not previous.get("paused"), "WAITING_KEY:这把密钥已经暂停。")
        require(previous.get("job") in (None, job["id"]), "WAITING_KEY:共用密钥的前一条审阅还未结算。")
        check_unsettled(flow, job["key_id"], Path(job["directory"]))
        write(path, {**previous, "job": job["id"], "repo": flow.repo.name,
                     "reserved_usd": job["execution"]["cost_bound_usd"], "at": timestamp()})
    return previous.get("last_usage")


def release(flow, job, usage=None):
    path = key_root(flow, job["key_id"]) / "reservation.json"
    with locked(path.parent, "control"):
        row = read(path) if path.is_file() else {}
        require(row.get("job") in (None, job["id"]), "密钥预算占用属于另一条任务。")
        write(path, {"job": None, "last_usage": usage or row.get("last_usage"), "at": timestamp(),
                     "paused": row.get("paused", False)})


def release_if_owned(flow, job):
    path = key_root(flow, job["key_id"]) / "reservation.json"
    if path.is_file() and read(path).get("job") == job["id"]:
        release(flow, job)


def finish_billing(flow, job, returned):
    bill = returned["billing"]
    amount = dollars(bill["actual_cost_usd"], zero=True)
    job["actual_cost_usd"] = str(amount)
    before, after = bill["before"], bill["after"]
    cap = dollars(before["key_limit_usd"])
    job["remaining_usd"] = str(cap - dollars(after["actual_cost_usd"], zero=True))
    require(amount <= dollars(job["execution"]["cost_bound_usd"]) <= dollars(job["execution"]["max_cost_usd"]),
            "实际扣费超过已核对的费用边界，暂停后续任务。")
    require(after["requests"] == before["requests"] + 1 and
            dollars(after["actual_cost_usd"], zero=True) - dollars(before["actual_cost_usd"], zero=True) == amount,
            "账单无法归属到这一次请求。")
    require(dollars(after["actual_cost_usd"], zero=True) <= cap, "专用密钥累计费用超出额度。")
    return {**after, "key_limit_usd": str(cap)}


def process(flow, identifier, *, launch=invoke):
    import desktop_review_request as reviewer
    job = read(job_path(flow, identifier))
    if job["status"] not in ACTIVE:
        return summary(job)
    directory = Path(job["directory"])
    with locked(flow.state / "prs", str(job["pr"])), locked(key_root(flow, job["key_id"]), "dispatch"):
        job = read(job_path(flow, identifier))
        if job["status"] not in ACTIVE:
            return summary(job)
        if (root(flow) / "cancellations" / (identifier + ".json")).is_file():
            release_if_owned(flow, job)
            return summary(save(flow, job, "cancelled", "发送前取消。"))
        try:
            installed = profile(flow, job["profile"])
            require(installed["key_id"] == job["key_id"] and installed["manifest_sha256"] == job["installation"],
                    "执行程序或密钥已变化，原任务不能继续。")
            previous = reserve(flow, job)
            packet = read(directory / "request.json")
            require(packet["id"] == job["packet"] and
                    digest({k: v for k, v in packet.items() if k != "id"}) == job["packet"], "固定审阅材料已经变化。")
            apath, output = directory / "attempt.json", directory / "response.json"
            attempt = read(apath) if apath.is_file() else None
            if attempt and attempt.get("request_sent") is not False and not output.is_file():
                try:
                    launch(installed, directory, "observe")
                except (WorkflowError, OSError, subprocess.TimeoutExpired):
                    pass
                attention(flow, job, "发送结果未知；只读查询不能证明请求未执行。")
                return summary(save(flow, job, "needs_reconciliation", "先核对服务请求记录，不重发；密钥预算继续占用。"))
            if not output.is_file():
                policy = execution_approval(flow, job["approval"], job["packet"], job["key_id"])
                require(policy == job["execution"], "排队后执行条件发生变化。")
                current_dir, target, files, _ = flow.preflight(job["pr"])
                require(current_dir == directory and reviewer.packet_for(target, files, "lmuai")["id"] == job["packet"],
                        "代码、基线或自动检查已变化，需重新准备材料和批准。")
                require(job["safe_attempts"] < 3, "明确未发送的恢复已达到三次，请人工核对连接或配置。")
                if attempt:
                    require(attempt.get("request_sent") is False, "未知请求不能再次发送。")
                    write(directory / "unsent" / (attempt["client_request_id"] + ".json"), attempt)
                attempt = {**reviewer.make_attempt(packet), "key_id": job["key_id"],
                           "approval": {"ask": job["approval"], "packet": job["packet"]},
                           "execution": policy, "automation": {
                               "state_root": str(flow.state.parents[1]), "approval": job["approval"],
                               "job": job["id"], "previous_usage": previous}}
                write(apath, attempt)
                job["safe_attempts"] += 1
                save(flow, job, "running")
                launch(installed, directory, "dispatch")
            returned = read(output)
            if "billing" not in returned:
                save(flow, job, "billing_pending")
                launch(installed, directory, "settle")
                returned = read(output)
            usage = finish_billing(flow, job, returned)
            # Validate old material even when main has advanced. Retain its raw evidence and cost.
            try:
                reviewer.validate(packet, returned)
            except (WorkflowError, ValueError, KeyError):
                release(flow, job, usage)
                return summary(save(flow, job, "invalid_result", "费用已核对；模型输出未通过结构与证据校验。"))
            release(flow, job, usage)
            publish = False
            try:
                consent = execution_approval(flow, job["approval"], job["packet"], job["key_id"], sending=False)
                publish = consent["publish"]
            except WorkflowError:
                pass
            if flow.pair(job["pr"])[1:] != (job["target"]["head"], job["target"]["base"]) or \
                    flow.successful_ci(job["target"]["head"]) != job["target"]["ci"]:
                return summary(save(flow, job, "stale", "审阅期间代码或检查变化，结果只供历史核对。"))
            save(flow, job, "publication_pending")
            result = flow.review_result(directory, packet, job["target"], read(apath), "lmuai", publish=publish)
            require(all(item.get("phase") == "confirmed" for item in result.get("issues", [])),
                    "后续 Issue 写入尚未核对；不会再次请求模型。")
            job.update(verdict=result["verdict"], receipt=result["receipt"])
            return summary(save(flow, job, "complete", "报告已写回提案。" if publish else "报告留在本地；未授权公开写回。"))
        except (WorkflowError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
            if isinstance(exc, WorkflowError) and str(exc).startswith("WAITING_KEY:"):
                return summary(job) | {"note": str(exc).split(":", 1)[1]}
            # Do not copy native stderr / arbitrary service content into status.
            apath = directory / "attempt.json"
            attempt = read(apath) if apath.is_file() else {}
            output = directory / "response.json"
            returned = read(output) if output.is_file() else {}
            if isinstance(exc, WorkflowError) and str(exc) == "KEYCHAIN_LOCKED":
                state, note = "needs_unlock", "请在本机解锁钥匙串后恢复任务。"
            elif attempt and attempt.get("request_sent") is not False and not output.is_file():
                state, note = "needs_reconciliation", "请求可能已送达，先核对服务用量与结果，不重发。"
                attention(flow, job, note)
            elif returned and not returned.get("billing"):
                state, note = "billing_pending", "已有回复；仅核对费用，最多自动核对三轮。"
                job["billing_checks"] = job.get("billing_checks", 0) + 1
                if job["billing_checks"] >= 3:
                    state = "needs_reconciliation"
                    attention(flow, job, note)
            elif returned.get("billing") and job["status"] == "publication_pending":
                state, note = "publication_pending", "已有回执；仅核对 GitHub 写入，不再次请求模型。"
                job["publish_checks"] = job.get("publish_checks", 0) + 1
                if job["publish_checks"] >= 3:
                    state = "blocked"
            else:
                state, note = "blocked", str(exc) if isinstance(exc, WorkflowError) else "本机执行失败，请核对原始记录。"
            if attempt.get("request_sent") is False or not attempt:
                release_if_owned(flow, job)
                if (root(flow) / "cancellations" / (identifier + ".json")).is_file():
                    state, note = "cancelled", "发送前取消。"
            return summary(save(flow, job, state, note))


def control(flow, identifier, action):
    job = read(job_path(flow, identifier))
    if action == "cancel":
        with locked(key_root(flow, job["key_id"]), "control"):
            attempt_path = Path(job["directory"]) / "attempt.json"
            attempt = read(attempt_path) if attempt_path.is_file() else {}
            require(not attempt or attempt.get("request_sent") is False, "请求已发送或不确定，不能当成未发送取消。")
            require(job["status"] not in TERMINAL, "任务已经结束。")
            write(root(flow) / "cancellations" / (identifier + ".json"), {"at": timestamp(), "job": identifier})
        # A running worker observes the marker before sending. Do not race its status writes.
        try:
            with locked(flow.state / "prs", str(job["pr"])), locked(key_root(flow, job["key_id"]), "dispatch"):
                release_if_owned(flow, job)
                return summary(save(flow, job, "cancelled", "尚未发送；保留原授权与历史。"))
        except WorkflowError:
            return summary(job) | {"note": "取消已登记；后台将在发送前停止。"}
    with locked(flow.state / "prs", str(job["pr"])), locked(key_root(flow, job["key_id"]), "dispatch"):
        job = read(job_path(flow, identifier))
        require(action == "resume" and job["status"] not in TERMINAL, "只能恢复尚未结束的任务。")
        return summary(save(flow, job, "queued", "已请求恢复；仍重新核对授权和原尝试。"))


def pause(flow, name, paused):
    installed = profile(flow, name, require_current=False)
    directory = key_root(flow, installed["key_id"])
    with locked(directory, "control"):
        path = directory / "reservation.json"
        row = read(path) if path.is_file() else {}
        row.update(paused=paused, at=timestamp())
        write(path, row)
    return {"profile": name, "paused": paused, "note": "已经发送的请求仍可能计费。"}


def reconcile(flow, identifier):
    """Use an operator-recorded reconciliation; never turn it into a second send."""
    job = read(job_path(flow, identifier))
    directory = Path(job["directory"])
    with locked(flow.state / "prs", str(job["pr"])), locked(key_root(flow, job["key_id"]), "dispatch"):
        job = read(job_path(flow, identifier))
        require(job["status"] not in TERMINAL, "任务已经结束。")
        require(not (directory / "response.json").is_file(), "已收到回复时用 resume 继续解析或核对账单。")
        attempt = read(directory / "attempt.json")
        settlement = read(directory / "billing-reconciliation.json")
        require(settlement.get("client_request_id") == attempt["client_request_id"] and
                isinstance(settlement.get("evidence"), str) and settlement["evidence"].strip(),
                "对账须绑定原请求并提供可核对证据。")
        outcome = settlement.get("outcome")
        require(outcome in ("no_usage", "usage_confirmed"), "对账结论无效。")
        actual = dollars(settlement.get("actual_cost_usd"), zero=True) if outcome == "usage_confirmed" else dollars("0", zero=True)
        require(actual <= dollars(job["execution"]["cost_bound_usd"]), "实际金额超过费用边界，需另行处理，队列保持暂停。")
        observation = read(directory / "reconciliation-observation.json")
        before = attempt.get("billing_before")
        require(before is not None and observation["requests"] == before["requests"] + (1 if outcome == "usage_confirmed" else 0) and
                dollars(observation["actual_cost_usd"], zero=True) - dollars(before["actual_cost_usd"], zero=True) == actual,
                "服务用量观察与人工对账不一致；先只读核对。")
        job["actual_cost_usd"] = str(actual)
        usage = {**observation, "key_limit_usd": before["key_limit_usd"]}
        release(flow, job, usage)
        return summary(save(flow, job, "settled_without_result", "核对记录已关联；该授权不会再次发送模型请求。"))


def run_once(flow, name):
    results = []
    for path in sorted((root(flow) / "jobs").glob("*.json")):
        job = read(path)
        if job["profile"] == name and job["status"] in ACTIVE:
            try:
                results.append(process(flow, job["id"]))
            except WorkflowError:
                # Another worker owns this PR/key. Leave the durable job for the next tick.
                continue
    return results

