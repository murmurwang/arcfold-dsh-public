"""Runs only in the ordinary test account. Shared files carry approved fixed actions."""
from __future__ import annotations

from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import pwd
import stat
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
ACTIONS = ("launch", "restored", "finish", "git", "git-section")


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(Path(path).read_bytes())


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def save(path, row, public=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755 if public else 0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".pending-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(row, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644 if public else 0o600)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def owned(path, owner, directory=False):
    info = Path(path).lstat()
    require(info.st_uid == owner and not info.st_mode & 0o022 and
            (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1),
            "交接材料的所有者、类型或写入权限不符。")


def config():
    value = read(HERE / "service.json")
    require(value["schema"] == 1 and value["shared"] == str(HERE) and value["account"] == "arcfold-test",
            "后台配置对象不符。")
    owned(HERE, value["issuer_uid"], directory=True)
    owned(HERE / "service.json", value["issuer_uid"])
    owned(HERE / "activation.json", value["issuer_uid"])
    activation = read(HERE / "activation.json")
    require(activation["issuer_uid"] == value["issuer_uid"] and
            activation["service_sha256"] == digest((HERE / "service.json").read_bytes()), "后台安装授权快照不符。")
    for name, sha in value["files"].items():
        require(Path(name).name == name, "执行文件名无效。")
        owned(HERE / name, value["issuer_uid"])
        require(digest((HERE / name).read_bytes()) == sha, "后台执行程序发生变化。")
    for runtime in ("node", "python"):
        require(digest(Path(value[runtime]).read_bytes()) == value[runtime + "_sha256"], "系统运行程序发生变化。")
    user = pwd.getpwuid(os.getuid())
    require(user.pw_name == "arcfold-test" and user.pw_uid == value["uid"] and user.pw_uid > 501 and
            str(Path(user.pw_dir).resolve()) == value["home"], "请在登记的普通测试账户运行。")
    groups = subprocess.run(["/usr/bin/id", "-Gn"], capture_output=True, check=True).stdout.decode().split()
    require("admin" not in groups, "后台程序不能在管理员账户运行。")
    return value


def local(configured):
    return Path(configured["home"]) / ".local" / "state" / "arcfold-test-startup"


def outbox(configured):
    path = Path(configured["outbox"])
    if not path.exists():
        path.mkdir(mode=0o755)
        path.chmod(0o755)
    owned(path, configured["uid"], directory=True)
    return path


def install():
    value = config()
    folder = local(value)
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    owned(folder, value["uid"], directory=True)
    results = outbox(value)
    # Never modify login settings or store a password.
    plist = Path(value["home"]) / "Library" / "LaunchAgents" / (value["label"] + ".plist")
    plist.parent.mkdir(parents=True, exist_ok=True)
    data = plistlib.dumps({"Label": value["label"],
        "ProgramArguments": [value["python"], "-I", "-B", str(HERE / "rehearsal_agent.py"), "run"],
        "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ProcessType": "Interactive",
        "EnvironmentVariables": {"PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "zh_CN.UTF-8"}})
    if plist.exists():
        require(plist.read_bytes() == data and not plist.is_symlink(), "已有不同的后台启动配置。")
    else:
        plist.write_bytes(data)
        plist.chmod(0o600)
    domain = "gui/" + str(value["uid"])
    label = domain + "/" + value["label"]
    if subprocess.run(["/bin/launchctl", "print", label], capture_output=True).returncode != 0:
        subprocess.run(["/bin/launchctl", "bootstrap", domain, str(plist)], check=True, capture_output=True)
    subprocess.run(["/bin/launchctl", "print", label], check=True, capture_output=True)
    save(results / "service-installed.json", {"account": value["account"], "uid": value["uid"],
         "service_sha256": digest((HERE / "service.json").read_bytes()), "at": now()}, public=True)
    print("测试账户后台程序已登记。以后批准测试后自动启动；系统登录方式保持原设置。")


def validate_request(configured, folder, verify_material=True):
    owned(folder, configured["issuer_uid"], directory=True)
    owned(folder / "request.json", configured["issuer_uid"])
    request = read(folder / "request.json")
    plan = request["plan"]
    plan_bytes = (json.dumps(plan, ensure_ascii=False, indent=2) + "\n").encode()
    identifier = hashlib.sha256(json.dumps({"plan": digest(plan_bytes), "approval": request["approval"]},
        sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    require(request["id"] == folder.name and request["issuer_uid"] == configured["issuer_uid"] and
            request["plan_sha256"] == digest(plan_bytes) and identifier == request["id"] and
            plan["account"] == configured["account"] and plan["uid"] == configured["uid"] and
            plan["repo"] == configured["repo"] and plan["service_sha256"] == digest((HERE / "service.json").read_bytes()),
            "测试请求与后台配置不符。")
    require(plan["allowed_actions"] == list(ACTIONS) and plan["max_launches"] == 4 and plan["max_actions"] == 16 and
            plan["real_model_requests"] == 0, "测试请求越过固定范围。")
    deadline = datetime.fromisoformat(plan["expires_at"].replace("Z", "+00:00"))
    require(deadline.tzinfo is not None and deadline > datetime.now(timezone.utc), "测试授权已到期。")
    for name, sha in configured["harness"].items():
        require(plan["files"].get(name) == sha, "测试脚本不是已安装的版本。")
    for name, sha in (plan["files"].items() if verify_material else ()):
        require(not Path(name).is_absolute() and ".." not in Path(name).parts, "测试路径无效。")
        path = folder / "kit" / name
        for parent in path.parents:
            if parent == folder:
                break
            owned(parent, configured["issuer_uid"], directory=True)
        owned(path, configured["issuer_uid"])
        require(digest(path.read_bytes()) == sha, "测试材料发生变化。")
    if verify_material:
        bundle = read(folder / "kit" / "bundle.json")
        identifier = digest(json.dumps({k: v for k, v in bundle.items() if k != "id"},
            sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())[:12]
        require(bundle["id"] == identifier and all(plan[key] == bundle[value] for key, value in
                (("source", "candidate"), ("bundle", "id"), ("older", "older"), ("newer", "newer"))) and
                all(plan["files"].get(row["file"]) == row["sha256"] for row in bundle["packages"]),
                "源码、版本或归档与批准计划不符。")
    return request


def process_alive(pid):
    if not isinstance(pid, int) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def matching_runner(configured, folder, pid):
    if not process_alive(pid):
        return False
    result = subprocess.run(["/bin/ps", "-ww", "-p", str(pid), "-o", "uid=,args="], capture_output=True)
    line = result.stdout.decode().strip()
    expected = configured["node"] + " " + str(folder / "kit" / "run.mjs") + " "
    parts = line.split(None, 1)
    return len(parts) == 2 and parts[0] == str(configured["uid"]) and parts[1].startswith(expected)


def stopped(configured, folder):
    for path, field in ((HERE / "disable.json", None), (HERE / "pause.json", "paused"),
                        (folder / "cancel.json", None)):
        if not path.exists():
            continue
        owned(path, configured["issuer_uid"])
        row = read(path)
        if path.parent == HERE:
            require(row["service_sha256"] == digest((HERE / "service.json").read_bytes()), "控制请求对象不符。")
        else:
            require(row["job"] == folder.name, "取消请求对象不符。")
        if field is None or row.get(field) is True:
            return True
    return False


class Agent:
    def __init__(self, configured):
        self.config = configured
        self.private = local(configured)
        self.private.mkdir(parents=True, exist_ok=True, mode=0o700)
        owned(self.private, configured["uid"], directory=True)
        require(not self.private.stat().st_mode & 0o077, "测试后台状态目录必须保持私人权限。")
        self.results = outbox(configured)
        self.children = {}

    def report(self, request, state, **details):
        row = {"job": request["id"], "source": request["plan"]["source"], "uid": self.config["uid"],
               "account": self.config["account"], "state": state, "at": now(), **details}
        save(self.results / (request["id"] + ".json"), row, public=True)
        return row

    def state(self, request):
        path = self.private / (request["id"] + ".json")
        return read(path) if path.is_file() else {"last_seq": 0, "launches": 0}

    def heartbeat(self):
        save(self.results / "heartbeat.json", {"at": now(), "uid": self.config["uid"],
             "service_sha256": digest((HERE / "service.json").read_bytes())}, public=True)

    def observe(self, request, mode):
        root = Path(self.config["home"]) / ("Arcfold-DSH-Rehearsal-" + request["plan"]["bundle"] +
                                           ("-git" if mode == "git" else ""))
        try:
            check = subprocess.run([self.config["node"], str(HERE / "rehearsal_probe.mjs"),
                 str(root), str(self.config["uid"])], capture_output=True, timeout=8)
            observed = json.loads(check.stdout) if check.returncode == 0 else None
            return observed if observed and observed.get("ready") is True and observed["uid"] == self.config["uid"] else None
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return None

    def handle(self, folder):
        request = validate_request(self.config, folder, verify_material=False)
        progress = self.state(request)
        state_path = self.private / (request["id"] + ".json")
        if progress.get("pending"):
            # Recover a recorded live launch only by observing its original window, never by spawning.
            pending = progress["pending"]
            if pending["action"] in ("launch", "git") and matching_runner(self.config, folder, progress.get("pid")):
                observed = self.observe(request, pending["action"])
                if observed:
                    progress.update(last_seq=pending["seq"], pending=None)
                    save(state_path, progress)
                    self.report(request, "ready", last_seq=progress["last_seq"], window=observed, recovered=True,
                                next="已重新核对原测试窗口，没有重复启动；实际验收仍须逐项检查。")
                    return
            self.report(request, "unknown", last_seq=progress["last_seq"], next="前一动作结果未知，先核对原进程与回执。")
            return
        cancelled = folder / "cancel.json"
        if cancelled.exists():
            owned(cancelled, self.config["issuer_uid"])
            self.report(request, "cancelled", last_seq=progress["last_seq"], next="不再执行后续动作；已有窗口保留。")
            return
        commands = folder / "commands"
        owned(commands, self.config["issuer_uid"], directory=True)
        seq = progress["last_seq"] + 1
        command_path = commands / (f"{seq:06d}.json")
        if not command_path.exists():
            receipt = self.results / (request["id"] + ".json")
            if progress.get("pid") and not matching_runner(self.config, folder, progress["pid"]) and \
                    receipt.is_file() and read(receipt).get("state") == "ready":
                self.report(request, "window_closed", last_seq=progress["last_seq"],
                            next="前一测试窗口已退出，可按原计划继续下一动作。")
            return
        owned(command_path, self.config["issuer_uid"])
        action = read(command_path)
        require(action == {"job": request["id"], "seq": seq, "action": action.get("action")} and
                action["action"] in ACTIONS and seq <= request["plan"]["max_actions"], "测试动作无效。")
        mode = action["action"]
        validate_request(self.config, folder)
        if mode in ("launch", "git"):
            # Check every persisted runner, including another approved job using the same ports.
            for saved in self.private.glob("*.json"):
                old = read(saved)
                if old.get("pending") or (old.get("pid") and old.get("folder") and
                        matching_runner(self.config, Path(old["folder"]), old["pid"])):
                    self.report(request, "waiting_window_exit", last_seq=progress["last_seq"],
                                next="前一测试窗口仍在运行，关闭后才会打开下一个。")
                    return
            require(progress["launches"] < request["plan"]["max_launches"], "测试窗口启动次数达到上限。")
        elif not matching_runner(self.config, folder, progress.get("pid")):
            self.report(request, "failed", last_seq=progress["last_seq"], next="没有可核对的当前测试窗口，不执行检查。")
            return
        if stopped(self.config, folder):
            return
        # Persist an action attempt before spawning. It survives daemon restart.
        progress["pending"] = {"seq": seq, "action": mode, "at": now()}
        save(state_path, progress)
        self.report(request, "starting" if mode in ("launch", "git") else "checking", last_seq=progress["last_seq"])
        log = self.private / (request["id"] + "-" + str(seq) + ".log")
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "HOME": self.config["home"],
               "LANG": "zh_CN.UTF-8", "DSH_TELEMETRY_DISABLED": "1"}
        process = None
        try:
            with log.open("ab") as stream:
                log.chmod(0o600)
                # Recheck after material validation and immediately before dispatch. Already started
                # actions are preserved; cancellation is not a cross-account transactional kill.
                if stopped(self.config, folder):
                    progress["pending"] = None
                    save(state_path, progress)
                    self.report(request, "cancelled", last_seq=progress["last_seq"],
                                next="在启动前已停止；已有窗口保留。")
                    return
                process = subprocess.Popen([self.config["node"], str(folder / "kit" / "run.mjs"), mode],
                    cwd=folder / "kit", env=env, stdin=subprocess.DEVNULL, stdout=stream, stderr=stream)
            if mode in ("launch", "git"):
                progress["pid"] = process.pid
                progress["folder"] = str(folder)
                progress["launches"] += 1
                save(state_path, progress)
                self.children[request["id"]] = process
                observed = None
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    self.heartbeat()
                    if process.poll() is not None:
                        break
                    observed = self.observe(request, mode)
                    if observed:
                        break
                    time.sleep(1)
                require(observed and observed.get("ready") is True and observed["uid"] == self.config["uid"],
                        "未确认真实测试窗口就绪；不自动重复启动。")
                progress.update(last_seq=seq, pending=None)
                save(state_path, progress)
                self.report(request, "ready", last_seq=seq, window=observed,
                            next="真实测试窗口已就绪；安装、更新和验收结果仍待实际检查。")
            else:
                require(process.wait(timeout=60) == 0, "测试检查失败，原日志保留。")
                progress.update(last_seq=seq, pending=None)
                save(state_path, progress)
                exported = {}
                evidence = Path(self.config["home"]) / ("Arcfold-DSH-Rehearsal-" + request["plan"]["bundle"] + "-evidence")
                for name in ("result.json", "restored.json", "readback.json", "github-source.json", "result-with-github.json"):
                    source = evidence / name
                    if source.is_file():
                        owned(source, self.config["uid"])
                        target = self.results / (request["id"] + "-" + name)
                        save(target, read(source), public=True)
                        exported[name] = {"file": target.name, "sha256": digest(target.read_bytes())}
                self.report(request, "checked", last_seq=seq, action=mode, evidence=exported,
                            next="本动作完成；实际验收以逐项原始证据为准。")
        except Exception:
            # Preserve pending and PID. Unknown/failed attempts are never replayed.
            self.report(request, "unknown", last_seq=progress["last_seq"], action=mode,
                        exit_code=process.poll() if process else None, log=log.name,
                        reason="未确认窗口可读" if mode in ("launch", "git") else "检查未确认完成",
                        next="未确认本次动作完成，先核对原测试窗口和本机日志；不会重复启动。")

    def tick(self):
        for child in self.children.values():
            child.poll()
        if (HERE / "disable.json").exists():
            owned(HERE / "disable.json", self.config["issuer_uid"])
            require(read(HERE / "disable.json")["service_sha256"] == digest((HERE / "service.json").read_bytes()),
                    "移除请求对象不符。")
            active = any((row.get("pending") or (row.get("folder") and
                         matching_runner(self.config, Path(row["folder"]), row.get("pid"))))
                         for row in (read(path) for path in self.private.glob("*.json")))
            save(self.results / "service-status.json", {"state": "waiting_window_exit" if active else "stopped",
                 "at": now(), "uid": self.config["uid"]}, public=True)
            if active:
                return True
            plist = Path(self.config["home"]) / "Library" / "LaunchAgents" / (self.config["label"] + ".plist")
            plist.unlink(missing_ok=True)
            # bootout ends this process; write the result before invoking it.
            subprocess.run(["/bin/launchctl", "bootout", "gui/" + str(self.config["uid"]) + "/" + self.config["label"]],
                           capture_output=True)
            return False
        if (HERE / "pause.json").exists():
            owned(HERE / "pause.json", self.config["issuer_uid"])
            paused = read(HERE / "pause.json")
            require(paused["service_sha256"] == digest((HERE / "service.json").read_bytes()), "暂停对象不符。")
            if paused["paused"]:
                save(self.results / "heartbeat.json", {"at": now(), "uid": self.config["uid"],
                     "paused": True, "service_sha256": paused["service_sha256"]}, public=True)
                return True
        for folder in sorted((HERE / "inbox").iterdir()):
            if folder.is_dir() and len(folder.name) == 64 and (folder / "request.json").is_file():
                error_path = self.results / (folder.name + "-error.json")
                if error_path.exists():
                    continue
                try:
                    self.handle(folder)
                except Exception as exc:
                    # Do not fabricate a receipt when the request identity cannot be verified.
                    save(error_path, {"at": now(), "state": "request_rejected",
                         "job": folder.name, "uid": self.config["uid"],
                         "reason": str(exc) if isinstance(exc, RuntimeError) else "材料格式或读写失败",
                         "service_sha256": digest((HERE / "service.json").read_bytes())}, public=True)
        self.heartbeat()
        return True


def run():
    value = config()
    agent = Agent(value)
    with (agent.private / "dispatch.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while agent.tick():
            time.sleep(2)


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in ("install", "run"), "后台入口参数无效。")
        install() if sys.argv[1] == "install" else run()
    except Exception:
        print("测试账户后台程序未完成操作，请核对账户、授权计划和原记录。", file=sys.stderr)
        sys.exit(1)

