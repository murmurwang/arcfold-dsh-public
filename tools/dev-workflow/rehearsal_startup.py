"""Approved startup in the existing ordinary macOS test account."""
from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess

from common import digest, locked, read, require, timestamp, write

HERE = Path(__file__).resolve().parent
ACCOUNT = "arcfold-test"
ACTIONS = ("launch", "restored", "finish", "git", "git-section")
CONTROLS = ("fixture.mjs", "registry.mjs", "model.mjs", "desktop.mjs", "run.mjs", "Run-DSH.command")


def local(flow):
    return flow.state / "test-startup"


def valid_until(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        parsed = None
    require(parsed is not None and parsed.tzinfo is not None, "测试计划的有效期须包含时区。")
    require(parsed > datetime.now(timezone.utc), "测试计划已经过期。")


def identity(name=ACCOUNT):
    require(name == ACCOUNT, "只允许已登记的普通测试账户。")
    row = pwd.getpwnam(name)
    require(row.pw_uid > 501 and row.pw_uid != os.getuid(), "测试账户身份不符。")
    groups = subprocess.run(["/usr/bin/id", "-Gn", name], capture_output=True, check=True).stdout.decode().split()
    require("admin" not in groups, "测试账户必须是普通账户。")
    return {"account": name, "uid": row.pw_uid, "home": str(Path(row.pw_dir).resolve())}


def inventory(kit):
    kit = Path(kit).resolve()
    bundle = read(kit / "bundle.json")
    require(re.fullmatch(r"[a-f0-9]{12}", bundle.get("id", "")) and
            re.fullmatch(r"[a-f0-9]{40}", bundle.get("candidate", "")), "测试包编号或源码不符。")
    require(bundle["id"] == digest({k: v for k, v in bundle.items() if k != "id"})[:12], "测试包清单摘要不符。")
    require(all(re.fullmatch(r"\d+\.\d+\.\d+", bundle.get(key, "")) for key in ("older", "newer")) and
            tuple(map(int, bundle["older"].split("."))) < tuple(map(int, bundle["newer"].split("."))), "测试版本顺序不符。")
    required = {(name, version) for name in ("@arcfold/dsh", "@arcfold/dsh-method-ui")
                for version in (bundle["older"], bundle["newer"])}
    product = [row for row in bundle["packages"] if row["name"].startswith("@arcfold/")]
    require(len(product) == 4 and {(row["name"], row["version"]) for row in product} == required and
            all(row["source"] == bundle["candidate"] for row in product if row["version"] == bundle["newer"]),
            "测试材料必须包含同一候选的核心和界面包，以及两份旧包。")
    files = {"bundle.json": digest((kit / "bundle.json").read_bytes())}
    for name in CONTROLS:
        require((kit / name).is_file() and not (kit / name).is_symlink() and
                (kit / name).read_bytes() == (HERE / "rehearsal" / name).read_bytes(),
                "测试脚本与版本化入口不符；请重新制备测试包，不运行临时替换脚本。")
        files[name] = digest((kit / name).read_bytes())
    for row in bundle["packages"]:
        name = row["file"]
        path = Path(name)
        require(name not in files and not path.is_absolute() and ".." not in path.parts and
                (kit / path).is_file() and not (kit / path).is_symlink(), "测试包路径无效。")
        require(digest((kit / path).read_bytes()) == row["sha256"], "归档与测试包清单不符。")
        files[name] = row["sha256"]
    return bundle, files


def verify(directory, files):
    for name, sha in files.items():
        file = Path(directory) / name
        require(not Path(name).is_absolute() and ".." not in Path(name).parts and
                file.is_file() and not file.is_symlink() and digest(file.read_bytes()) == sha, "材料文件已变化。")


def approve(flow, path, ask):
    from collab import granted, load_ask
    path = Path(path).resolve()
    _, record = load_ask(flow, ask)
    bound = {str(Path(name).resolve()): sha for name, sha in record.get("binds", {}).get("files", {}).items()}
    require(granted(record) and not record.get("revoked") and bound.get(str(path)) == digest(path.read_bytes()),
            "操作需要绑定当前计划文件的有效授权。")
    return read(path)


def prepare_service(flow, output):
    account = identity()
    output = Path(output).resolve()
    require(not output.exists(), "准备目录已存在，请使用新目录。")
    output.mkdir(parents=True, mode=0o700)
    stage = output / "runtime"
    stage.mkdir()
    for name in ("rehearsal_agent.py", "rehearsal_probe.mjs"):
        shutil.copyfile(HERE / name, stage / name)
    key = digest({"repo": flow.repo.name, "state_root": str(flow.state.parents[1]), "uid": account["uid"]})[:20]
    shared = Path("/Users/Shared") / ("Arcfold-Test-Queue-" + key)
    outbox = Path("/Users/Shared") / ("Arcfold-Test-Results-" + key)
    runtime = {"schema": 1, "repo": flow.repo.name, **account, "issuer_uid": os.getuid(),
               "shared": str(shared), "outbox": str(outbox), "label": "org.arcfold.test-startup." + key,
               "python": "/usr/bin/python3", "node": "/usr/local/bin/node",
               "harness": {name: digest((HERE / "rehearsal" / name).read_bytes()) for name in CONTROLS},
               "files": {path.name: digest(path.read_bytes()) for path in stage.iterdir()}}
    require(Path(runtime["node"]).is_file(), "缺少测试入口使用的系统 Node。")
    runtime["node_sha256"] = digest(Path(runtime["node"]).read_bytes())
    runtime["python_sha256"] = digest(Path(runtime["python"]).read_bytes())
    write(stage / "service.json", runtime)
    launcher = '#!/bin/sh\nset -eu\nroot=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd -P)\nexec /usr/bin/python3 -I -B "$root/rehearsal_agent.py" install\n'
    (stage / "Configure-Test.command").write_text(launcher)
    (stage / "Configure-Test.command").chmod(0o755)
    plan = {"action": "enable-test-startup", "repo": flow.repo.name, **account,
            "state_root": str(flow.state.parents[1]), "stage": str(stage), "shared": str(shared),
            "outbox": str(outbox), "service_sha256": digest((stage / "service.json").read_bytes()),
            "files": {path.name: digest(path.read_bytes()) for path in stage.iterdir()},
            "effects": ["复制固定测试后台程序到指定共享目录", "首次由测试账户运行配置入口",
                        "安装该测试账户的登录后台程序", "仅启动逐次批准的测试材料；不改变账户登录方式"]}
    write(output / "enable-plan.json", plan)
    return {"plan": str(output / "enable-plan.json"), "sha256": digest((output / "enable-plan.json").read_bytes()),
            "effects": plan["effects"], "note": "仅准备；未修改测试账户或共享测试包。"}


def enable(flow, path, ask):
    plan = approve(flow, path, ask)
    require(plan["action"] == "enable-test-startup" and plan["repo"] == flow.repo.name and
            plan["state_root"] == str(flow.state.parents[1]), "后台计划对象不符。")
    verify(plan["stage"], plan["files"])
    shared = Path(plan["shared"])
    with locked(local(flow), "service"):
        if shared.exists():
            verify(shared, plan["files"])
        else:
            shutil.copytree(plan["stage"], shared)
        for name in plan["files"]:
            item = shared / name
            item.chmod(0o755 if item.suffix == ".command" else 0o644)
        shared.chmod(0o755)
        (shared / "inbox").mkdir(exist_ok=True, mode=0o755)
        (shared / "inbox").chmod(0o755)
        write(shared / "activation.json", {"plan_sha256": digest(Path(path).read_bytes()), "approval": ask,
              "service_sha256": plan["service_sha256"], "issuer_uid": os.getuid(), "at": timestamp()})
        (shared / "activation.json").chmod(0o644)
        write(local(flow) / "service.json", {"shared": plan["shared"], "outbox": plan["outbox"],
              "service_sha256": plan["service_sha256"], "uid": plan["uid"], "account": plan["account"]})
    return {"configuration": str(shared / "Configure-Test.command"),
            "next": "首次在普通测试账户登录后运行此配置入口；此后由后台领取已批准任务。"}


def service(flow):
    path = local(flow) / "service.json"
    require(path.is_file(), "测试账户后台程序尚未登记。")
    row = read(path)
    require(digest((Path(row["shared"]) / "service.json").read_bytes()) == row["service_sha256"], "后台配置发生变化。")
    runtime = read(Path(row["shared"]) / "service.json")
    require(all(digest((HERE / "rehearsal" / name).read_bytes()) == sha for name, sha in runtime["harness"].items()),
            "当前测试入口与已安装后台版本不同，请核对新的安装计划。")
    return row


def prepare_run(flow, kit, output, expires_at):
    valid_until(expires_at)
    configured = service(flow)
    bundle, files = inventory(kit)
    path = Path(output).resolve()
    require(not path.exists(), "测试计划文件已存在，请使用新文件。")
    plan = {"action": "test-session", "repo": flow.repo.name, "kit": str(Path(kit).resolve()),
            "service_sha256": configured["service_sha256"], "uid": configured["uid"], "account": ACCOUNT,
            "source": bundle["candidate"], "bundle": bundle["id"], "older": bundle["older"], "newer": bundle["newer"],
            "files": files, "expires_at": expires_at, "allowed_actions": list(ACTIONS),
            "max_launches": 4, "max_actions": 16, "real_model_requests": 0}
    write(path, plan)
    return {"plan": str(path), "sha256": digest(path.read_bytes()), "source": plan["source"],
            "versions": [plan["older"], plan["newer"]], "actions": plan["allowed_actions"],
            "note": "启动就绪不是验收通过；真实界面与逐项检查另记证据。"}


def job_record(flow, identifier):
    require(isinstance(identifier, str) and re.fullmatch(r"[a-f0-9]{64}", identifier), "测试任务编号无效。")
    path = local(flow) / "jobs" / (identifier + ".json")
    require(path.is_file(), "没有这项测试任务。")
    return path, read(path)


def enqueue(flow, path, ask):
    plan_path = Path(path).resolve()
    plan = approve(flow, plan_path, ask)
    configured = service(flow)
    require(plan["action"] == "test-session" and plan["repo"] == flow.repo.name and
            plan["service_sha256"] == configured["service_sha256"] and plan["uid"] == configured["uid"] and
            plan["account"] == ACCOUNT and plan["allowed_actions"] == list(ACTIONS) and
            plan["max_launches"] == 4 and plan["max_actions"] == 16 and plan["real_model_requests"] == 0,
            "测试计划超出登记范围。")
    valid_until(plan["expires_at"])
    bundle, files = inventory(plan["kit"])
    require(files == plan["files"] and all(plan[key] == bundle[value] for key, value in
            (("source", "candidate"), ("bundle", "id"), ("older", "older"), ("newer", "newer"))),
            "测试计划与实际包清单不符。")
    identifier = digest({"plan": digest(plan_path.read_bytes()), "approval": ask})
    with locked(local(flow), "queue"):
        destination = local(flow) / "jobs" / (identifier + ".json")
        if destination.exists():
            return status(flow, identifier)
        for existing in (local(flow) / "jobs").glob("*.json"):
            old = read(existing)
            require(read(old["plan"])["bundle"] != plan["bundle"],
                    "同一测试包已经登记，请核对原任务 " + old["id"] + "；重启使用原任务的固定动作。")
        folder = Path(configured["shared"]) / "inbox" / identifier
        if folder.exists():
            previous = read(folder / "request.json")
            require(previous["id"] == identifier and previous["plan_sha256"] == digest(plan_path.read_bytes()) and
                    previous["approval"] == ask, "既有交接目录不符，先核对，不能重发。")
            verify(folder / "kit", plan["files"])
            write(destination, {"id": identifier, "folder": str(folder), "plan": str(plan_path), "approval": ask,
                               "source": plan["source"], "created_at": previous["created_at"]})
            return status(flow, identifier)
        folder.mkdir(mode=0o755)
        folder.chmod(0o755)
        kit = folder / "kit"
        kit.mkdir(mode=0o755)
        kit.chmod(0o755)
        for name in plan["files"]:
            target = kit / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            for parent in target.parents:
                if parent == kit:
                    break
                parent.chmod(0o755)
            shutil.copyfile(Path(plan["kit"]) / name, target)
            target.chmod(0o755 if name.endswith(".command") else 0o644)
        command_dir = folder / "commands"
        command_dir.mkdir(mode=0o755)
        command_dir.chmod(0o755)
        request = {"id": identifier, "plan": plan, "plan_sha256": digest(plan_path.read_bytes()),
                   "approval": ask, "issuer_uid": os.getuid(), "created_at": timestamp()}
        write(command_dir / "000001.json", {"seq": 1, "action": "launch", "job": identifier})
        (command_dir / "000001.json").chmod(0o644)
        # Publish the request last, after every immutable input is present.
        write(folder / "request.json", request)
        (folder / "request.json").chmod(0o644)
        write(destination, {"id": identifier, "folder": str(folder), "plan": str(plan_path), "approval": ask,
                           "source": plan["source"], "created_at": timestamp()})
    return status(flow, identifier)


def step(flow, identifier, action):
    require(action in ACTIONS, "测试动作不在白名单中。")
    _, job = job_record(flow, identifier)
    plan = approve(flow, job["plan"], job["approval"])
    valid_until(plan["expires_at"])
    folder = Path(job["folder"])
    require(not (folder / "cancel.json").exists(), "测试任务已取消。")
    with locked(local(flow), "queue"):
        commands = sorted((folder / "commands").glob("*.json"))
        require(len(commands) < plan["max_actions"], "测试动作次数已经达到批准范围。")
        result = status(flow, identifier)
        require(result.get("last_seq", 0) == len(commands), "前一动作尚未核对，不能重复提交。")
        require(result["state"] not in ("failed", "unknown", "cancelled"), "测试状态需要先核对。")
        if action in ("launch", "git"):
            require(sum(read(item)["action"] in ("launch", "git") for item in commands) < plan["max_launches"],
                    "测试窗口启动次数达到上限。")
        seq = len(commands) + 1
        path = folder / "commands" / (f"{seq:06d}.json")
        write(path, {"seq": seq, "action": action, "job": identifier})
        path.chmod(0o644)
    return {"job": identifier, "seq": seq, "action": action, "queued": True}


def status(flow, identifier=None):
    configured_path = local(flow) / "service.json"
    if not configured_path.is_file():
        return {"state": "not_configured", "next": "尚未配置测试账户后台程序。", "jobs": []}
    configured = read(configured_path)
    result = []
    for file in sorted((local(flow) / "jobs").glob("*.json")):
        job = read(file)
        if identifier is not None and job["id"] != identifier:
            continue
        receipt = Path(configured["outbox"]) / (job["id"] + ".json")
        rejected = Path(configured["outbox"]) / (job["id"] + "-error.json")
        if rejected.is_file():
            info = rejected.stat()
            require(not rejected.is_symlink() and info.st_uid == configured["uid"] and not info.st_mode & 0o022,
                    "拒绝记录所有者或权限不符。")
            error = read(rejected)
            require(error["job"] == job["id"] and error["uid"] == configured["uid"] and
                    error["service_sha256"] == configured["service_sha256"], "拒绝记录与后台不符。")
            result.append({"id": job["id"], **error, "next": "后台拒绝本任务，核对原计划、有效期和材料；不会自动重试。"})
            continue
        if receipt.is_file():
            info = receipt.stat()
            require(not receipt.is_symlink() and info.st_uid == configured["uid"] and not info.st_mode & 0o022,
                    "测试回执所有者或权限不符。")
            row = read(receipt)
            require(row["job"] == job["id"] and row["source"] == job["source"] and row["uid"] == configured["uid"],
                    "测试回执与本次任务不符。")
            heartbeat = Path(configured["outbox"]) / "heartbeat.json"
            fresh = False
            if heartbeat.is_file():
                owner = heartbeat.stat()
                require(not heartbeat.is_symlink() and owner.st_uid == configured["uid"] and not owner.st_mode & 0o022,
                        "后台心跳所有者或权限不符。")
                beat = read(heartbeat)
                checked = datetime.fromisoformat(beat["at"])
                fresh = (checked.tzinfo is not None and beat["uid"] == configured["uid"] and
                         beat["service_sha256"] == configured["service_sha256"] and
                         0 <= (datetime.now(timezone.utc) - checked).total_seconds() <= 90)
            if not fresh and row["state"] in ("ready", "starting", "checking", "waiting_window_exit"):
                row.update(last_observed_state=row["state"], state="waiting_session",
                           next="后台回报已过期；等待测试账户会话恢复，不假定窗口仍然就绪。")
            result.append({"id": job["id"], **row})
        else:
            result.append({"id": job["id"], "state": "waiting_session", "last_seq": 0,
                           "next": "等待测试账户登录并启动已配置的后台程序；尚未确认窗口就绪。"})
    if identifier is not None:
        require(len(result) == 1, "测试任务不存在。")
        return result[0]
    return {"jobs": result}


def cancel(flow, identifier):
    _, job = job_record(flow, identifier)
    folder = Path(job["folder"])
    write(folder / "cancel.json", {"job": identifier, "at": timestamp()})
    (folder / "cancel.json").chmod(0o644)
    return {"job": identifier, "next": "已阻止后续动作；已打开的测试窗口保留，由实际测试流程退出。"}


def pause(flow, paused):
    configured = service(flow)
    path = Path(configured["shared"]) / "pause.json"
    write(path, {"service_sha256": configured["service_sha256"], "paused": paused, "at": timestamp()})
    path.chmod(0o644)
    return {"paused": paused, "note": "控制后续动作；不强制关闭现有测试窗口。"}


def removal_plan(flow, output):
    configured = service(flow)
    path = Path(output).resolve()
    require(not path.exists(), "移除计划已存在。")
    write(path, {"action": "remove-test-startup", "repo": flow.repo.name, **configured,
                 "effects": ["停止领取新测试任务", "由测试账户卸载其后台启动项", "保留测试资料和回执"]})
    return {"plan": str(path), "sha256": digest(path.read_bytes())}


def disable(flow, path, ask):
    plan = approve(flow, path, ask)
    configured = service(flow)
    require(plan["action"] == "remove-test-startup" and plan["repo"] == flow.repo.name and
            all(plan[key] == value for key, value in configured.items()), "移除计划与当前对象不符。")
    target = Path(configured["shared"]) / "disable.json"
    write(target, {"service_sha256": configured["service_sha256"], "approval": ask, "at": timestamp()})
    target.chmod(0o644)
    return {"next": "已请求测试账户后台程序停止并移除自己的启动项；保留测试记录。"}

