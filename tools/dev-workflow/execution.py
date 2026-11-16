"""Step readiness and durable, object-scoped execution claims.

This is execution evidence, not an approval or a substitute for CI/review.
One atomic journal coordinates processes sharing this workflow state directory.
No read path creates files, expires claims, or silently retries side effects.
"""
from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid

from common import WorkflowError, command, digest, git, git_line, read, require, timestamp, write
from task_access import resolve as resolve_task

NAME = re.compile(r"[a-z0-9][a-z0-9-]{1,63}")
RECIPES = {"workflow-checks", "desktop-checks"}
ACTIVE = {"running", "unknown"}


def root(flow):
    return flow.state / "execution"


def state(flow):
    path = root(flow) / "state.json"
    return read(path) if path.is_file() else {"schema": "execution-v1", "limit": 2, "plans": {}, "history": [], "runs": {}}


@contextmanager
def transaction(flow):
    root(flow).mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root(flow) / "state.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        record = state(flow)
        yield record
        write(root(flow) / "state.json", record)


def checked_task(flow, key):
    from collab import open_decisions, require_alignment
    directory, task = resolve_task(flow, key)
    require(task["phase"] == "open" and not (directory / "retired.json").exists(), "步骤须属于已启动且未退场的任务。")
    note = flow.check(task["id"])
    require(note["sha256"] == task["decision_sha256"], "步骤的决策内容已变化，先核对新决策。")
    require_alignment(flow, task["id"], note["sha256"])
    require(not open_decisions(flow, task["id"]), "本任务仍有未答的决定单。")
    return task


def identity(task, step):
    return task + "/" + step


def definitions(record):
    return {identity(key, step["id"]): step for key, plan in record["plans"].items() for step in plan["steps"]}


def check_cycles(steps):
    done, pending = set(), []

    def visit(key):
        require(key not in pending, "步骤依赖形成循环：" + " → ".join([*pending, key]))
        if key in done or key not in steps:
            return
        pending.append(key)
        for dependency in steps[key]["needs"]:
            visit(dependency["step"])
        pending.pop()
        done.add(key)

    for key in steps:
        visit(key)


def register(flow, key, document):
    task = checked_task(flow, key)
    key = task["id"]
    rows = document.get("steps")
    require(isinstance(rows, list) and rows, "至少登记一个有输入和产出的步骤。")
    steps = []
    for item in rows:
        require(isinstance(item, dict) and NAME.fullmatch(item.get("id", "")), "步骤名称使用小写字母、数字和连字符。")
        require(isinstance(item.get("title"), str) and item["title"].strip() and
                isinstance(item.get("output"), str) and item["output"].strip(), "步骤须写明工作和预期产出。")
        inputs = item.get("inputs", {})
        require(isinstance(inputs, dict), "步骤输入须为可保存的对象。")
        needs = item.get("needs", [])
        require(isinstance(needs, list), "步骤依赖须为列表。")
        for need in needs:
            require(isinstance(need, dict) and isinstance(need.get("step"), str) and
                    len(need["step"].split("/")) == 2 and NAME.fullmatch(need["step"].split("/")[1]) and
                    isinstance(need.get("reason"), str) and need["reason"].strip(), "每项依赖须写任务/步骤和实际原因。")
            owner, part = need["step"].split("/")
            need["step"] = identity(resolve_task(flow, owner)[1]["id"], part)
        resources = item.get("resources", [])
        require(isinstance(resources, list) and all(isinstance(v, str) and 0 < len(v) <= 200 for v in resources),
                "共享对象须为非空名称。")
        recipe = item.get("recipe")
        require(recipe is None or recipe in RECIPES, "自动执行仅接受已登记的离线检查配方；不接受任意命令。")
        require(type(item.get("external", False)) is bool, "external 须明确为布尔值。")
        require(not recipe or not item.get("external", False), "外部写入不能由离线检查执行器代办。")
        steps.append({"id": item["id"], "title": item["title"], "output": item["output"], "inputs": inputs,
                      "needs": needs, "resources": sorted(set(resources)), "recipe": recipe,
                      "external": item.get("external", False), "weight": 1 if recipe else 0})
    require(len({s["id"] for s in steps}) == len(steps), "同一任务的步骤不能重名。")
    plan = {"task": key, "decision": task["decision_sha256"], "steps": steps}
    plan["sha256"] = digest(plan)
    with transaction(flow) as record:
        previous = record["plans"].get(key)
        if previous and previous["sha256"] == plan["sha256"]:
            return previous
        plan["registered_ns"] = previous.get("registered_ns", time.time_ns()) if previous else time.time_ns()
        record["plans"][key] = plan
        check_cycles(definitions(record))
        record["history"].append({"at": timestamp(), "plan": plan})
    return plan


def directory_identity(directory):
    """Content identity, including links; a matching lock alone is insufficient."""
    directory = Path(directory)
    require(directory.is_dir(), "冻结依赖目录不存在。")
    entries = []
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            require(path.resolve().is_relative_to(directory.resolve()), "依赖链接须指向同一冻结目录内的内容。")
            value = ["link", os.readlink(path)]
        elif path.is_file():
            value = ["file", path.stat().st_mode & 0o777, digest(path.read_bytes())]
        elif path.is_dir():
            continue
        else:
            raise WorkflowError("冻结依赖包含不支持的文件类型。")
        entries.append([str(path.relative_to(directory)), *value])
    return digest(entries)


def source_inputs(flow, task, step):
    """Resolve actual command inputs; mutable working files are never test inputs."""
    inputs = dict(step["inputs"])
    if step["recipe"]:
        _, row = resolve_task(flow, task)
        checkout = Path(row["checkout"])
        require(not git_line(checkout, "status", "--porcelain"), "自动检查先提交源码，不能把正在编辑的目录当作固定输入。")
        inputs.update(source=git_line(checkout, "rev-parse", "HEAD"),
                      tree=git_line(checkout, "rev-parse", "HEAD^{tree}"),
                      executor=digest(Path(__file__).read_bytes()), python=sys.version,
                      platform=platform.platform(), machine=platform.machine())
        if step["recipe"] == "desktop-checks":
            dependencies = Path(inputs.get("dependencies", "")).expanduser().resolve()
            lock = (dependencies / "package-lock.json").read_bytes()
            require(lock == (checkout / "package-lock.json").read_bytes(), "依赖资源与候选锁文件不一致。")
            archive = Path(inputs.get("python_archive", "")).expanduser().resolve(strict=True)
            require(archive.is_file(), "Desktop 检查须提供已校验的随包 Python 归档。")
            inputs.update(dependencies=str(dependencies), dependency_lock=digest(lock),
                          dependency_tree=directory_identity(dependencies / "node_modules"),
                          node=command(["node", "--version"]).decode().strip(),
                          python_archive=str(archive), python_archive_sha256=digest(archive.read_bytes()))
    return inputs


def intact(run):
    try:
        return bool(run.get("evidence")) and all(digest(Path(p).read_bytes()) == sha for p, sha in run["evidence"].items())
    except OSError:
        return False


def owns_resources(run):
    return run["status"] in ACTIVE or run["status"] == "pass" and not intact(run)


def view(flow, record=None):
    record = record if record is not None else state(flow)
    steps = definitions(record)
    cache = {}
    active = [r for r in record["runs"].values() if owns_resources(r)]

    def resolve(key):
        if key in cache:
            return cache[key]
        if key not in steps:
            return {"state": "waiting", "reason": "前置步骤尚未登记", "step": key}
        task, _ = key.split("/")
        step = steps[key]
        row = {"step": key, "title": step["title"], "output": step["output"], "state": "ready", "waiting": []}
        row["registered_ns"] = record["plans"][task].get("registered_ns", 0)
        cache[key] = row
        dependencies = {}
        for need in step["needs"]:
            prior = resolve(need["step"])
            if prior["state"] != "pass":
                row["waiting"].append({**need, "state": prior["state"], "condition": "对应输入的实际完成证据"})
            else:
                dependencies[need["step"]] = prior["run"]
        try:
            current = checked_task(flow, task)
            require(current["decision_sha256"] == record["plans"][task]["decision"], "步骤计划的决策已失效。")
            inputs = source_inputs(flow, task, step)
        except (WorkflowError, OSError, KeyError) as exc:
            row["waiting"].append({"reason": str(exc)})
            inputs = step["inputs"]
        fingerprint = digest({"step": step, "decision": record["plans"][task]["decision"],
                              "inputs": inputs, "dependencies": dependencies})
        row.update(fingerprint=fingerprint, inputs=inputs)
        runs = [r for r in record["runs"].values() if r["step"] == key and r["fingerprint"] == fingerprint
                and r["status"] != "retried"]
        if runs:
            run = runs[-1]
            row.update(run=run["id"], state=run["status"])
            if run["status"] == "pass" and not intact(run):
                row.update(state="unknown", reason="完成证据缺失或内容变化，先核对原执行")
            if row["waiting"] and run["status"] not in ACTIVE:
                row["state"] = "waiting"
            return row
        for run in active:
            overlap = sorted(set(step["resources"]) & set(run["resources"]))
            if overlap or run["step"] == key:
                row["waiting"].append({"run": run["id"], "objects": overlap, "reason": "已有执行尚未核清"})
        if step["weight"] and sum(r["weight"] for r in active) + step["weight"] > record["limit"]:
            row["waiting"].append({"reason": "本机重计算名额已占满", "limit": record["limit"]})
        if row["waiting"]:
            row["state"] = "waiting"
        return row

    rows = [resolve(k) for k in steps]
    return {"limit": record["limit"], "steps": rows,
            "active": [{k: r[k] for k in ("id", "step", "status", "resources", "started_at", "owner")} for r in active]}


def claim(flow, key, step_id):
    task = checked_task(flow, key)
    step_key = identity(task["id"], step_id)
    # File/content checks happen outside the short record transaction. If any
    # claim, plan or result changed meanwhile, retry against the new journal.
    snapshot = state(flow)
    rows = {r["step"]: r for r in view(flow, snapshot)["steps"]}
    with transaction(flow) as record:
        if digest(record) != digest(snapshot) and step_key in rows:
            duplicate = [r for r in record["runs"].values() if r["step"] == step_key and
                         r["fingerprint"] == rows[step_key]["fingerprint"] and r["status"] != "retried"]
            if duplicate:
                return {"acquired": False, "run": duplicate[-1]}
        require(digest(record) == digest(snapshot), "执行记录刚有变化，重新领取即可；没有启动工作。")
        require(step_key in rows, "步骤尚未登记。")
        row = rows[step_key]
        if row.get("run"):
            return {"acquired": False, "run": record["runs"][row["run"]]}
        require(row["state"] == "ready", "此步骤仍在等待：" + json.dumps(row["waiting"], ensure_ascii=False))
        step = definitions(record)[step_key]
        token = uuid.uuid4().hex
        run = {"id": token, "step": step_key, "fingerprint": row["fingerprint"], "inputs": row["inputs"],
               "recipe": step["recipe"], "external": step["external"], "resources": step["resources"],
               "weight": step["weight"], "status": "running", "started_at": timestamp(), "started_ns": time.time_ns(),
               "registered_ns": row["registered_ns"],
               "owner": {"pid": os.getpid(), "agent": os.getenv("CODEX_THREAD_ID") or os.getenv("ARCFOLD_AGENT_ID", "local")}}
        record["runs"][token] = run
    return {"acquired": True, "run": run}


def finish(flow, token, outcome, evidence, *, details=None):
    require(outcome in ("pass", "fail", "unknown"), "步骤结果须为 pass、fail 或 unknown。")
    require(isinstance(evidence, list) and evidence, "记录步骤结果须有实际证据文件。")
    saved = {}
    for index, name in enumerate(evidence):
        data = Path(name).read_bytes()
        require(len(data) <= 8_000_000, "步骤证据过大；登记小型检查回执并引用原产物。")
        target = root(flow) / "evidence" / token / (str(index) + "-" + digest(data))
        require(re.fullmatch(r"[a-f0-9]{32}", token), "执行编号无效。")
        if not target.exists():
            write(target, data)
        saved[str(target)] = digest(data)
    with transaction(flow) as record:
        require(token in record["runs"], "找不到原执行。")
        run = record["runs"][token]
        if run["status"] not in ACTIVE:
            require(run["status"] == outcome and run.get("evidence") == saved, "原执行已经记录不同结果。")
            return run
        if run.get("evidence"):
            run.setdefault("resolutions", []).append({k: run[k] for k in
                ("status", "evidence", "details", "finished_at", "elapsed_seconds") if k in run})
        run.update(status=outcome, evidence=saved, details=details or {}, finished_at=timestamp(),
                   elapsed_seconds=(time.time_ns() - run["started_ns"]) / 1e9)
    return run


def retry(flow, token, evidence):
    """Explicit retry only for a confirmed, local failure; unknown effects stay owned."""
    proof = Path(evidence).read_bytes()
    require(proof.strip(), "重试须说明已核对的原失败和修复依据。")
    with transaction(flow) as record:
        run = record["runs"].get(token)
        require(run and run["status"] == "fail" and not run["external"], "只允许重试已确认失败的本地步骤；未知结果先核对。")
        run.update(status="retried", retry_evidence=digest(proof), retry_note=proof.decode(), retried_at=timestamp())
    return run


def set_limit(flow, limit):
    require(type(limit) is int and 1 <= limit <= 16, "本机重计算上限使用 1 至 16。")
    with transaction(flow) as record:
        record["limit"] = limit
    return {"limit": limit}


def reserve_work(flow, label, inputs, maximum=2):
    """Share the same process budget with managed build operations."""
    with transaction(flow) as record:
        active = [r for r in record["runs"].values() if owns_resources(r)]
        require(not any(label in r["resources"] for r in active), "该构建已有未核清的执行。")
        available = record["limit"] - sum(r["weight"] for r in active)
        require(available > 0, "本机重计算名额已占满；其他步骤完成后继续。")
        token = uuid.uuid4().hex
        run = {"id": token, "step": label, "fingerprint": digest(inputs), "inputs": inputs,
               "recipe": "managed-build", "external": False, "resources": [label],
               "weight": min(maximum, available), "status": "running", "started_at": timestamp(),
               "started_ns": time.time_ns(), "owner": {"pid": os.getpid(), "agent": "managed-build"}}
        record["runs"][token] = run
    return run


def execute_check(flow, run):
    key = run["step"].split("/")[0]
    _, task = flow.task(key)
    folder = root(flow) / "work" / run["id"]
    folder.mkdir(parents=True, exist_ok=False)
    checkout = folder / "source"
    logfile = folder / "check.log"
    try:
        git(folder, "clone", "--quiet", "--no-hardlinks", task["checkout"], str(checkout), timeout=120)
        git(checkout, "switch", "--detach", run["inputs"]["source"])
        require(git_line(checkout, "rev-parse", "HEAD^{tree}") == run["inputs"]["tree"], "固定源码内容不符。")
        env = {k: os.environ[k] for k in ("PATH", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR") if k in os.environ}
        temp = folder / "tmp"
        temp.mkdir()
        env.update(TMPDIR=str(temp), DSH_TELEMETRY_DISABLED="1", ARCFOLD_TEST_CONCURRENCY="1", PYTHONDONTWRITEBYTECODE="1")
        if run["recipe"] == "workflow-checks":
            argv = [sys.executable, "-B", "-m", "unittest", "discover", "-s", "tools/dev-workflow", "-v"]
        else:
            require(run["recipe"] == "desktop-checks", "未知检查配方。")
            dependencies = folder / "dependencies"
            dependencies.mkdir()
            original = Path(run["inputs"]["dependencies"])
            shutil.copy2(original / "package-lock.json", dependencies / "package-lock.json")
            if sys.platform == "darwin":
                command(["/bin/cp", "-cR", str(original / "node_modules"), str(dependencies / "node_modules")], timeout=120)
            else:
                shutil.copytree(original / "node_modules", dependencies / "node_modules", symlinks=True)
            require(digest((dependencies / "package-lock.json").read_bytes()) == run["inputs"]["dependency_lock"] and
                    directory_identity(dependencies / "node_modules") == run["inputs"]["dependency_tree"],
                    "依赖副本与领取时的内容不同，不能沿用原执行输入。")
            package = folder / "python-package"
            archive = package / "runtime/desktop-python.tar.gz"
            write(archive, Path(run["inputs"]["python_archive"]).read_bytes())
            require(digest(archive.read_bytes()) == run["inputs"]["python_archive_sha256"] and
                    command(["node", "--version"]).decode().strip() == run["inputs"]["node"], "检查工具输入已变化。")
            python = command(["node", "--input-type=module", "-e",
                "import { prepareBundledDesktopPython } from './src/desktop/python-runtime.mjs'; "
                "console.log(prepareBundledDesktopPython(process.argv[1], process.argv[2]));",
                str(package), str(temp)], checkout, env=env).decode().strip()
            env.update(ARCFOLD_PATCH_TEST_INSTALLATION=str(dependencies), ARCFOLD_DESKTOP_PACKAGE_SOURCE=str(checkout),
                       ARCFOLD_DESKTOP_PACKAGE_DEPENDENCIES=str(dependencies), ARCFOLD_TREE_ENCODING_PYTHON=python,
                       ARCFOLD_DESKTOP_PYTHON_ARCHIVE=str(archive))
            argv = ["node", "scripts/test-isolated.mjs"]
        with logfile.open("wb") as output:
            process = subprocess.Popen(argv, cwd=checkout, env=env, stdin=subprocess.DEVNULL,
                                       stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = process.wait(timeout=900)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                code = -1
        return finish(flow, run["id"], "pass" if code == 0 else "fail", [str(logfile)], details={"exit_code": code})
    except (OSError, WorkflowError) as exc:
        failure = folder / "failure.txt"
        write(failure, str(exc).encode())
        return finish(flow, run["id"], "fail", [str(failure)])


def run_ready(flow, key=None):
    if key is not None:
        key = checked_task(flow, key)["id"]
    completed = []
    with ThreadPoolExecutor(max_workers=state(flow)["limit"]) as pool:
        futures = {}
        while True:
            overview = view(flow)
            observe(flow, overview)
            # Old registrations get first opportunity. Within one registration,
            # producers with more consumers release more downstream work.
            specs = definitions(state(flow))
            consumers = {row["step"]: sum(any(n["step"] == row["step"] for n in s["needs"])
                                           for s in specs.values()) for row in overview["steps"]}
            for row in sorted(overview["steps"], key=lambda r: (r["registered_ns"], -consumers[r["step"]])):
                task, step = row["step"].split("/")
                if row["state"] != "ready" or key and task != key:
                    continue
                spec = specs[row["step"]]
                if not spec["recipe"]:
                    continue
                try:
                    result = claim(flow, task, step)
                except WorkflowError:
                    continue  # Another process may have just claimed the shared capacity.
                if result["acquired"]:
                    future = pool.submit(execute_check, flow, result["run"])
                    futures[future] = result["run"]["id"]
            if not futures:
                break
            done, _ = wait(futures, return_when=FIRST_COMPLETED)
            for future in done:
                completed.append(future.result())
                del futures[future]
    return {"completed": completed, "next": view(flow)}


def observe(flow, overview):
    """Execution writes observations; next/status/metrics remain read-only."""
    states = [{k: row[k] for k in ("step", "state", "waiting", "fingerprint") if k in row}
              for row in overview["steps"]]
    with transaction(flow) as record:
        observations = record.setdefault("observations", [])
        if not observations or observations[-1]["states"] != states:
            observations.append({"at_ns": time.time_ns(), "states": states})


def metrics(flow):
    """Report observed execution intervals; no fabricated model cost or speedup."""
    record = state(flow)
    intervals, events = [], []
    for run in record["runs"].values():
        if "elapsed_seconds" not in run or run["status"] in ACTIVE:
            continue
        start, end = run["started_ns"] / 1e9, run["started_ns"] / 1e9 + run["elapsed_seconds"]
        intervals.append({"run": run["id"], "step": run["step"], "status": run["status"], "start": start,
                          "end": end, "seconds": end - start, "workers": run["weight"],
                          "since_registration_seconds": max(0, (run["started_ns"] - run.get("registered_ns", run["started_ns"])) / 1e9)})
        events.extend([(start, run["weight"]), (end, -run["weight"])])
    active, maximum = 0, 0
    for _, delta in sorted(events):
        active += delta
        maximum = max(maximum, active)
    signatures = [(r["step"], r["fingerprint"]) for r in record["runs"].values()]
    waiting = []
    observations = record.get("observations", [])
    for before, after in zip(observations, observations[1:]):
        for row in before["states"]:
            if row["state"] == "waiting":
                waiting.append({"step": row["step"], "reasons": row.get("waiting", []),
                                "observed_seconds": (after["at_ns"] - before["at_ns"]) / 1e9})
    return {"runs": intervals, "max_heavy_workers": maximum, "observed_waits": waiting,
            "wall_seconds": max((r["end"] for r in intervals), default=0) - min((r["start"] for r in intervals), default=0),
            "repeat_executions": len(signatures) - len(set(signatures)),
            "current_waits": [r for r in view(flow)["steps"] if r["state"] == "waiting"],
            "model_cost": "由已有审阅执行及对账记录核对，本执行器不发送模型请求"}
