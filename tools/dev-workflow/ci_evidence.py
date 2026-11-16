"""Read actual legacy or split CI jobs; an aggregate name is never evidence."""
from common import require

RUNTIME = "Desktop runtime checks"
WORKFLOW = "Dev workflow checks"
SUMMARY = "Desktop checks"
VERIFY = "核对检查使用的提交"
RUNTIME_STEP = "在独立副本运行 Desktop 模拟检查"
WORKFLOW_STEP = "运行工作流检查"
SUMMARY_STEP = "核对全部并行检查结果"


def select(jobs, head, legacy_steps):
    names = [job["name"] for job in jobs]
    if RUNTIME not in names and WORKFLOW not in names:
        matches = [j for j in jobs if j["name"] == SUMMARY]
        require(len(matches) == 1, "缺少唯一的 Desktop 检查作业。")
        job = matches[0]
        require(job.get("head_sha") == head and job.get("status") == "completed" and
                job.get("conclusion") == "success", "旧检查作业的源码或完成结果不符。")
        completed = {s["name"] for s in job["steps"] if s["conclusion"] == "success"}
        require(set(legacy_steps) <= completed, "自动检查回执缺少确切提交、Desktop 检查或工作流检查。")
        return job
    required = {RUNTIME: {VERIFY, RUNTIME_STEP}, WORKFLOW: {VERIFY, WORKFLOW_STEP}, SUMMARY: {SUMMARY_STEP}}
    selected = []
    for name, steps in required.items():
        matches = [j for j in jobs if j["name"] == name]
        require(len(matches) == 1, "并行检查缺少唯一作业：" + name)
        job = matches[0]
        require(job.get("head_sha") == head and job.get("status") == "completed" and
                job.get("conclusion") == "success", "并行检查的源码或完成结果不符：" + name)
        completed = {s["name"] for s in job["steps"] if s["conclusion"] == "success"}
        require(steps <= completed, "并行检查缺少实际成功步骤：" + name)
        selected.append(job)
    return {"layout": "split-v1", "jobs": selected}


def record(ci, group, log, desktop_pattern, workflow_pattern):
    desktop, workflow = [], []
    for line in log.splitlines():
        label, step, stamped = (line.split("\t", 2) + ["", ""])[:3]
        text = stamped.partition(" ")[2]
        if label == RUNTIME and step == RUNTIME_STEP and desktop_pattern.fullmatch(text):
            desktop.append(text)
        if label == WORKFLOW and step == WORKFLOW_STEP and workflow_pattern.fullmatch(text):
            workflow.append(text)
    require(desktop and workflow, "并行作业日志缺少实际测试结果。")
    return {"run": ci, "layout": "split-v1", "jobs": [
        {"id": j["id"], "name": j["name"], "head": j["head_sha"], "url": j["html_url"],
         "steps": {s["name"]: s["conclusion"] for s in j["steps"]}} for j in group["jobs"]],
        "desktop_results": desktop, "workflow_results": workflow}
