"""Prepare reviewable local installation artifacts; install only with bound consent."""
from __future__ import annotations

import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

from common import command, digest, read, require, timestamp, write

HERE = Path(__file__).resolve().parent


def verify_files(directory, files):
    directory = Path(directory)
    for name, sha in files.items():
        path = directory / name
        require(not Path(name).is_absolute() and ".." not in Path(name).parts and
                path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == sha,
                "后台执行文件不符，请重新准备并核对安装内容。")


def verify_installation(profile):
    installed = Path(profile["install_dir"])
    require(digest((installed / "runtime.json").read_bytes()) == profile["manifest_sha256"],
            "后台执行配置已变化。")
    runtime = read(installed / "runtime.json")
    require(runtime["install_dir"] == str(installed), "后台安装目录不一致。")
    verify_files(installed, runtime["files"])
    require(digest((installed / "ReviewKeychain").read_bytes()) == profile["helper_sha256"], "密钥执行程序已变化。")
    require(digest(Path(runtime["python"]).read_bytes()) == runtime["python_sha256"], "Python 已更新，请重新核对执行版本。")
    return runtime


def authorize_plan(flow, plan_path, approval):
    from collab import granted, load_ask
    plan_path = Path(plan_path).expanduser().resolve()
    _, ask = load_ask(flow, approval)
    bound_files = {str(Path(name).resolve()): sha for name, sha in ask.get("binds", {}).get("files", {}).items()}
    require(granted(ask) and bound_files.get(str(plan_path)) == digest(plan_path.read_bytes()),
            "本机变更需要绑定当前计划文件的有效授权单。")
    plan = read(plan_path)
    require(plan.get("repo") == flow.repo.name and plan.get("state_root") == str(flow.state.parents[1]),
            "计划绑定的是另一套状态目录或仓库。")
    return plan


def prepare(flow, output, name="default"):
    from review_queue import root
    require(sys.platform == "darwin", "本机密钥与后台安装计划需要 macOS。")
    import re
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,47}", name or ""), "配置名称无效。")
    output = Path(output).expanduser().resolve()
    require(not output.exists(), "安装材料目录已存在，请保留它并使用新目录。")
    output.mkdir(parents=True, mode=0o700)
    stage = output / "runtime"
    stage.mkdir(mode=0o700)
    identifier = digest({"repo": flow.repo.name, "state_root": str(flow.state.parents[1]), "profile": name})[:20]
    install_dir = Path.home() / "Library" / "Application Support" / "Arcfold Review" / identifier
    label = "org.arcfold.review." + identifier
    python = Path(sys.executable).resolve()
    gh = shutil.which("gh")
    require(gh is not None, "需要已配置的 GitHub 命令行。")
    for path in HERE.glob("*.py"):
        if not path.name.startswith("test_"):
            shutil.copyfile(path, stage / path.name)
    files = {path.name: digest(path.read_bytes()) for path in sorted(stage.iterdir())}
    runtime = {"schema": 1, "repo": flow.repo.name, "state_root": str(flow.state.parents[1]),
               "name": name, "install_dir": str(install_dir), "service": label, "account": "review",
               "python": str(python), "python_sha256": digest(python.read_bytes()), "files": files,
               "path": str(Path(gh).parent) + ":/usr/bin:/bin:/usr/sbin:/sbin"}
    write(stage / "runtime.json", runtime)
    sha = digest((stage / "runtime.json").read_bytes())
    source = output / "main.swift"
    source.write_text('let expectedRuntimeHash = "' + sha + '"\n' + (HERE / "ReviewKeychain.swift").read_text())
    command(["/usr/bin/xcrun", "swiftc", "-O", str(source), "-o", str(stage / "ReviewKeychain")], timeout=120)
    command(["/usr/bin/codesign", "--force", "--sign", "-", str(stage / "ReviewKeychain")], timeout=30)
    plist_path = Path.home() / "Library" / "LaunchAgents" / (label + ".plist")
    plist = {"Label": label, "ProgramArguments": [str(python), "-I", "-B", str(install_dir / "review_daemon.py")],
             "RunAtLoad": True, "StartInterval": 30, "ProcessType": "Background",
             "EnvironmentVariables": {"PATH": runtime["path"], "LANG": "en_US.UTF-8"}}
    (output / "launch-agent.plist").write_bytes(plistlib.dumps(plist))
    plan = {"action": "install", "repo": flow.repo.name, "state_root": str(flow.state.parents[1]), "profile": name,
            "stage": str(stage), "install_dir": str(install_dir), "service": label, "account": "review",
            "manifest_sha256": sha, "helper_sha256": digest((stage / "ReviewKeychain").read_bytes()),
            "files": {path.name: digest(path.read_bytes()) for path in sorted(stage.iterdir())},
            "launch_agent_source": str(output / "launch-agent.plist"), "launch_agent_path": str(plist_path),
            "launch_agent_sha256": digest((output / "launch-agent.plist").read_bytes()),
            "profile_path": str(root(flow) / "profiles" / (name + ".json")),
            "effects": ["复制并核对固定程序", "弹出本机密钥设置窗口", "保存专用钥匙串项",
                        "登记密钥指纹", "安装并启动用户后台程序；只执行另行批准的队列任务"]}
    write(output / "install-plan.json", plan)
    return {"plan": str(output / "install-plan.json"), "sha256": digest((output / "install-plan.json").read_bytes()),
            "effects": plan["effects"], "note": "只准备材料，尚未安装、访问钥匙串或调用模型。"}


def install(flow, plan_path, approval):
    plan = authorize_plan(flow, plan_path, approval)
    require(plan["action"] == "install", "不是安装计划。")
    verify_files(plan["stage"], plan["files"])
    source = Path(plan["launch_agent_source"])
    require(digest(source.read_bytes()) == plan["launch_agent_sha256"], "后台启动配置已变化。")
    target = Path(plan["install_dir"])
    if target.exists():
        verify_files(target, plan["files"])
    else:
        shutil.copytree(plan["stage"], target)
        target.chmod(0o700)
    verify_installation(plan)
    if not (target / "credential.json").is_file():
        # Native secure input; no credential is accepted as a CLI argument.
        result = subprocess.run([str(target / "ReviewKeychain"), "enroll"], timeout=600)
        require(result.returncode == 0, "本机密钥设置未完成；不启动后台程序，可核对后继续同一安装计划。")
    profile_path = Path(plan["profile_path"])
    profile_row = {k: plan[k] for k in ("install_dir", "service", "account", "manifest_sha256", "helper_sha256")}
    profile_row.update(approval=approval, installed_at=timestamp())
    if profile_path.exists():
        old = read(profile_path)
        require(all(old.get(k) == profile_row[k] for k in ("install_dir", "manifest_sha256", "helper_sha256")),
                "已有不同的后台安装，不能覆盖。")
    else:
        write(profile_path, profile_row)
    agent = Path(plan["launch_agent_path"])
    agent.parent.mkdir(parents=True, exist_ok=True)
    if agent.exists():
        require(digest(agent.read_bytes()) == plan["launch_agent_sha256"], "现有后台配置与计划不符。")
    else:
        agent.write_bytes(source.read_bytes())
        agent.chmod(0o600)
    domain = "gui/" + str(os.getuid())
    identifier = domain + "/" + plan["service"]
    probe = subprocess.run(["/bin/launchctl", "print", identifier], capture_output=True)
    if probe.returncode:
        command(["/bin/launchctl", "bootstrap", domain, str(agent)], timeout=30)
    command(["/bin/launchctl", "print", identifier], timeout=30)
    write(target / "installation-receipt.json", {"plan_sha256": digest(Path(plan_path).read_bytes()),
          "approval": approval, "at": timestamp(), "launched": True})
    return {"profile": plan["profile"], "installed": True, "note": "后台已登记；没有批准的任务不会发送。"}


def removal_plan(flow, name, output):
    from review_queue import profile, root
    installed = profile(flow, name)
    runtime = verify_installation(installed)
    target = Path(output).expanduser().resolve()
    require(not target.exists(), "移除计划已存在，请使用新文件。")
    plan = {"action": "remove", "repo": flow.repo.name, "state_root": str(flow.state.parents[1]),
            "profile": name, "installation": installed,
            "profile_path": str(root(flow) / "profiles" / (name + ".json")),
            "launch_agent_path": str(Path.home() / "Library" / "LaunchAgents" / (runtime["service"] + ".plist")),
            "effects": ["停止后台程序", "移除专用钥匙串项", "移除启动和配置登记", "保留审阅记录与程序材料"]}
    write(target, plan)
    return {"plan": str(target), "sha256": digest(target.read_bytes()), "effects": plan["effects"]}


def remove(flow, plan_path, approval):
    from review_policy import key_root
    from common import locked
    plan = authorize_plan(flow, plan_path, approval)
    require(plan["action"] == "remove", "不是移除计划。")
    installed = plan["installation"]
    verify_installation(installed)
    with locked(key_root(flow, installed["key_id"]), "dispatch"):
        reservation = key_root(flow, installed["key_id"]) / "reservation.json"
        require(not reservation.is_file() or not read(reservation).get("job"), "仍有未结算请求，先核对，不能移除。")
        label = "gui/" + str(os.getuid()) + "/" + installed["service"]
        probe = subprocess.run(["/bin/launchctl", "print", label], capture_output=True)
        if probe.returncode == 0:
            command(["/bin/launchctl", "bootout", label], timeout=30)
        require(subprocess.run(["/bin/launchctl", "print", label], capture_output=True).returncode != 0,
                "后台停止结果尚未确认。")
        command([str(Path(installed["install_dir"]) / "ReviewKeychain"), "remove"], timeout=30)
        Path(plan["launch_agent_path"]).unlink(missing_ok=True)
        Path(plan["profile_path"]).unlink(missing_ok=True)
        write(Path(installed["install_dir"]) / "removal-receipt.json",
              {"approval": approval, "at": timestamp(), "plan_sha256": digest(Path(plan_path).read_bytes())})
    return {"removed": plan["profile"], "evidence_preserved": True}

