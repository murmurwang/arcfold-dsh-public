"""Local collaboration records between the developer and the Agent.

Progress is derived from the receipts the entry already writes. Requests,
alignment and feedback record the developer's own words and bind them to the exact
object they concern, so a changed object cannot reuse an old answer. These are
files owned by the same system account. They prevent mistakes and omissions;
they do not authenticate a person.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
import os
from pathlib import Path
import re
import shutil

from common import WorkflowError, digest, git_line, locked, read, require, timestamp, write
from workflow import ID, OUTCOMES, SHA, VERSION, actor, text_field

HERE = Path(__file__).resolve().parent
ASK_KINDS = {"approve": "授权单", "decide": "决定单", "act": "操作单"}
VERDICTS = ("yes", "no", "other")
ASK_ID = re.compile(r"A[1-9][0-9]{0,5}")
FEEDBACK_ID = re.compile(r"F[1-9][0-9]{0,5}")
DIGEST = re.compile(r"[a-f0-9]{64}")
ROUTE = re.compile(rf"(close-loop|new):({ID})|issue:[1-9][0-9]*|note")
BINDS = {"packet", "pr", "repo", "cap_usd", "packages", "files", "version", "commit", "candidate"}
PACKAGES = ("@arcfold/dsh", "@arcfold/dsh-method-ui")
DAILY_PROFILE = "~/.dsh/profiles/desktop"
MARK_START = "<!-- arcfold-next:start -->"
MARK_END = "<!-- arcfold-next:end -->"
SKIP_DIRS = {"workspaces", "source", "cache", "node_modules", ".git"}
IN_FLIGHT = {
    "submit.json": ({"pushing", "creating"}, "推送分支或创建 PR"),
    "comment.json": ({"posting"}, "写 PR 审阅评论"),
    "merge-attempt.json": ({"marking-ready", "merging"}, "合入 PR"),
    "github.json": ({"tagging", "creating", "uploading"}, "建 Git 标签或 GitHub 发行"),
    "finalize.json": ({"finalizing"}, "公开 GitHub 发行"),
    "publication.json": ({"publishing"}, "发布固定候选"),
    "npm-publish.json": ({"publishing"}, "发布候选的 npm 安装包"),
}
ADVISORY = ({"posting", "check_github"}, "创建后续 Issue")


def next_number(names, prefix):
    numbers = [int(name[1:]) for name in names if re.fullmatch(prefix + r"[1-9][0-9]*", name)]
    return max(numbers, default=0) + 1


def amount(value, allow_zero=False):
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        number = None
    require(number is not None and number.is_finite() and (number >= 0 if allow_zero else number > 0),
            "金额要写成美元数字。")
    return number


def daily_version():
    """Read the versions actually installed in the developer's daily DSH profile. Read only."""
    profile = Path(os.getenv("ARCFOLD_DAILY_PROFILE", DAILY_PROFILE)).expanduser()
    packages = {}
    for name in PACKAGES:
        try:
            version = read(profile / "node_modules" / name / "package.json").get("version")
        except (OSError, ValueError, AttributeError):
            version = None
        packages[name] = version if isinstance(version, str) and version else "unknown"
    return {"packages": packages, "checked_at": timestamp()}


# Requests -------------------------------------------------------------------

def asks_dir(flow):
    return flow.state / "asks"


def load_ask(flow, ask):
    require(isinstance(ask, str) and ASK_ID.fullmatch(ask), "请求单编号形如 A3。")
    path = asks_dir(flow) / f"{ask}.json"
    require(path.is_file(), f"没有请求单 {ask}。")
    return path, read(path)


def all_asks(flow):
    directory = asks_dir(flow)
    if not directory.is_dir():
        return []
    rows = [read(path) for path in directory.glob("A*.json") if ASK_ID.fullmatch(path.stem)]
    return sorted(rows, key=lambda row: int(row["id"][1:]))


def open_decisions(flow, key):
    return [row["id"] for row in all_asks(flow)
            if row["kind"] == "decide" and row.get("task") == key and row["status"] == "open"]


def digests(value, label):
    require(isinstance(value, dict) and value and all(
        isinstance(name, str) and name and isinstance(sha, str) and DIGEST.fullmatch(sha) for name, sha in value.items()),
        f"{label} 要逐项写名称和 64 位摘要。")


def validate_binds(flow, binds):
    require(isinstance(binds, dict) and binds, "授权单要绑定被批准的对象。")
    unknown = sorted(set(binds) - BINDS)
    require(not unknown, f"无法识别的绑定 {'、'.join(unknown)}。")
    if "packet" in binds:
        require(isinstance(binds["packet"], str) and DIGEST.fullmatch(binds["packet"]), "审阅材料编号是 64 位摘要。")
    if "pr" in binds or "cap_usd" in binds:
        require(type(binds.get("pr")) is int and binds["pr"] > 0 and "packet" not in binds,
                "金额上限要绑定一个 PR，不能同时绑定材料编号。")
        amount(binds.get("cap_usd"))
    if "repo" in binds:
        require(binds["repo"] == flow.repo.name, "授权单绑定的是另一个仓库。")
    if "packages" in binds:
        digests(binds["packages"], "安装包")
    if "files" in binds:
        digests(binds["files"], "文件")
        for name, sha in binds["files"].items():
            path = Path(name).expanduser()
            require(path.is_absolute() and path.is_file() and digest(path.read_bytes()) == sha,
                    f"文件 {path.name} 的内容和绑定的摘要不一致。")
    if "version" in binds:
        require(isinstance(binds["version"], str) and re.fullmatch(VERSION, binds["version"]), "版本使用三段数字。")
    if "candidate" in binds:
        require(isinstance(binds["candidate"], str) and DIGEST.fullmatch(binds["candidate"]) and
                binds.get("repo") == flow.repo.name and "version" in binds and
                set(binds.get("packages", {})) == set(PACKAGES),
                "候选授权同时绑定仓库、版本和两份安装包。")
    if "commit" in binds:
        require(isinstance(binds["commit"], str) and re.fullmatch(SHA, binds["commit"]), "提交使用 40 位编号。")


def suggested_replies(ask, kind, steps):
    if kind == "approve":
        return [f"批准 {ask}", f"不批准 {ask}"]
    if kind == "decide":
        return [f"{ask} 选……", f"{ask} 按你建议"]
    if steps:
        return [f"{ask}.{index} 好了" for index in range(1, len(steps) + 1)]
    return [f"{ask} 做完了，再说看到的结果"]


def create_ask(flow, request):
    require(isinstance(request, dict), "请求单输入是一个 JSON 对象。")
    kind = request.get("kind")
    require(kind in ASK_KINDS, "请求单类型是 approve、decide 或 act。")
    title = text_field(request.get("title"), "请求单标题")
    require("\n" not in title, "请求单标题使用一行。")
    body = text_field(request.get("body"), "请求单说明")
    key = request.get("task")
    if key is not None:
        flow.task(key)
    binds = request.get("binds") or {}
    if kind == "approve":
        validate_binds(flow, binds)
    else:
        require(not binds, "只有授权单绑定对象。")
    lists = {}
    for field, owner, label in (("options", "decide", "选项"), ("steps", "act", "操作步骤")):
        values = request.get(field) or []
        require(isinstance(values, list) and all(isinstance(row, str) and row.strip() for row in values),
                f"{label}要逐条写清。")
        require(kind == owner or not values, f"只有{ASK_KINDS[owner]}写{label}。")
        lists[field] = [row.strip() for row in values]
    directory = asks_dir(flow)
    with locked(directory, "numbering"):
        ask = f"A{next_number([path.stem for path in directory.glob('A*.json')], 'A')}"
        record = {"id": ask, "kind": kind, "title": title, "body": body, "task": key, "binds": binds, **lists,
                  "replies": suggested_replies(ask, kind, lists["steps"]), "status": "open",
                  "created_at": timestamp(), "created_by": actor(), "answers": []}
        write(directory / f"{ask}.json", record)
    return record


def answer(flow, ask, verdict, text, step=None):
    require(verdict in VERDICTS, "答复标注为 yes、no 或 other。")
    words = text_field(text, "开发者的原话")
    with locked(asks_dir(flow), "answers"):
        path, record = load_ask(flow, ask)
        require(record["status"] == "open", f"{ask} 已经答过。情况变了就另开一张。")
        row = {"verdict": verdict, "text": words, "at": timestamp(), "recorded_by": actor()}
        if step is not None:
            steps = record.get("steps") or []
            require(record["kind"] == "act" and steps, f"{ask} 没有分步骤。")
            require(type(step) is int and 1 <= step <= len(steps), f"{ask} 没有第 {step} 步。")
            require(all(item.get("step") != step for item in record["answers"]), f"{ask}.{step} 已经答过。")
            row["step"] = step
            record["answers"].append(row)
            done = {item["step"] for item in record["answers"] if "step" in item}
            if verdict == "no" or done == set(range(1, len(steps) + 1)):
                record["status"] = "answered"
        else:
            record["answers"].append(row)
            # For an approval, an unclear reply is kept on the record but grants nothing.
            if not (record["kind"] == "approve" and verdict == "other"):
                record["status"] = "answered"
        if record["status"] == "answered":
            record["answered_at"] = row["at"]
        write(path, record)
    return record


def granted(record):
    return record["kind"] == "approve" and record["status"] == "answered" and record["answers"][-1]["verdict"] == "yes"


def review_spent(flow, number):
    """Spending already recorded for reviews of this PR.

    Each earlier request counts its billed amount, the upper bound from its
    returned usage, or the amount written in its reconciliation. A request
    whose spending cannot be determined refuses instead of counting as zero.
    """
    from desktop_review_request import maximum_cost

    root = flow.state / "prs" / str(number)
    runs = sorted({path.parent for name in ("attempt.json", "response.json") for path in root.glob(f"*/{name}")})
    total = Decimal("0")
    for here in runs:
        attempt = load_json(here / "attempt.json")
        if attempt.get("request_sent") is False:
            continue
        response = load_json(here / "response.json")
        billing = response.get("billing")
        if isinstance(billing, dict) and "actual_cost_usd" in billing:
            total += amount(billing["actual_cost_usd"], allow_zero=True)
            continue
        usage = (response.get("response") or {}).get("usage") or {}
        if attempt.get("provider", "openai") != "lmuai" and type(usage.get("input_tokens")) is int:
            total += maximum_cost(usage["input_tokens"])
            continue
        settled = load_json(here / "billing-reconciliation.json")
        if attempt and settled.get("client_request_id") == attempt.get("client_request_id") and settled.get("evidence"):
            if settled.get("outcome") == "no_usage":
                continue
            if settled.get("outcome") == "usage_confirmed" and "actual_cost_usd" in settled:
                total += amount(settled["actual_cost_usd"], allow_zero=True)
                continue
        raise WorkflowError(f"无法确定 PR #{number} 之前一次审阅（{here.name[:12]}）的实际花费。"
                            "按金额上限批准时，先在 billing-reconciliation.json 写明 actual_cost_usd。")
    return total


def review_approval(flow, ask, number, packet, estimate):
    _, record = load_ask(flow, ask)
    require(record["kind"] == "approve", f"{ask} 不是授权单。")
    require(record["status"] == "answered", f"{ask} 还没有得到开发者的答复。")
    require(granted(record), f"{ask} 没有获得同意。")
    binds = record["binds"]
    if "packet" in binds:
        require(binds["packet"] == packet, f"{ask} 批准的是另一份审阅材料。材料变化后要重新批准。")
        return {"ask": ask, "packet": packet}
    require(binds.get("pr") == number and binds.get("repo", flow.repo.name) == flow.repo.name and "cap_usd" in binds,
            f"{ask} 没有批准 PR #{number} 的审阅费用。")
    cap = amount(binds["cap_usd"])
    spent = review_spent(flow, number)
    planned = amount(estimate["estimated_usd_at_output_limit"], allow_zero=True)
    require(spent + planned <= cap,
            f"PR #{number} 已花 {spent} 美元，加上本次估算 {planned} 美元，超过 {ask} 批准的 {cap} 美元。")
    return {"ask": ask, "cap_usd": str(cap), "spent_usd": str(spent), "estimate_usd": str(planned)}


# Alignment ------------------------------------------------------------------

def aligned(directory, sha):
    path = directory / "alignment.json"
    if not path.is_file():
        return False
    row = read(path)
    return row.get("decision_sha256") == sha and isinstance(row.get("text"), str) and bool(row["text"].strip())


def require_alignment(flow, key, sha):
    directory, _ = flow.task(key)
    require((directory / "alignment.json").is_file(),
            "开发者还没有确认决策对齐。先把决策全文给开发者看，再用 align 登记开发者的原话。")
    require(aligned(directory, sha), "对齐确认之后决策又改过，先请开发者重新确认。")


def align(flow, key, text):
    directory, _ = flow.task(key)
    words = text_field(text, "开发者的原话")
    with locked(directory, "task"):
        _, record = flow.task(key)
        require(record["phase"] == "draft", "任务已经启动，决策已冻结。方案要变时另开任务。")
        note = flow.check(key)
        path = directory / "alignment.json"
        result = {"decision_sha256": note["sha256"], "text": words, "at": timestamp(), "recorded_by": actor()}
        if path.is_file():
            previous = read(path)
            result["previous"] = [*previous.pop("previous", []), previous]
        write(path, result)
    return {"task": key, **result}


# Feedback -------------------------------------------------------------------

def feedback_dir(flow):
    return flow.state / "feedback"


def load_feedback(flow, item):
    require(isinstance(item, str) and FEEDBACK_ID.fullmatch(item), "反馈编号形如 F3。")
    path = feedback_dir(flow) / item / "feedback.json"
    require(path.is_file(), f"没有反馈 {item}。")
    return path, read(path)


def record_feedback(flow, text, attachments=()):
    words = text_field(text, "反馈内容")
    sources = [Path(name).expanduser() for name in attachments]
    for source in sources:
        require(source.is_file(), f"找不到附件 {source.name}。")
    root = feedback_dir(flow)
    with locked(root, "numbering"):
        item = f"F{next_number([path.name for path in root.iterdir() if path.is_dir()], 'F')}"
        directory = root / item
        files = []
        for index, source in enumerate(sources, 1):
            name = f"{index:02d}-{source.name}"
            target = directory / "attachments" / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copyfile(source, target)
            data = target.read_bytes()
            files.append({"file": name, "sha256": digest(data), "bytes": len(data)})
        record = {"id": item, "text": words, "at": timestamp(), "recorded_by": actor(), "daily": daily_version(),
                  "attachments": files, "routes": []}
        write(directory / "feedback.json", record)
    return record


def route(flow, item, to, note=None):
    match = ROUTE.fullmatch(to or "")
    require(match, "去向写成 close-loop:任务、new:任务、issue:编号 或 note。")
    if match[2]:
        flow.task(match[2])
    note = note.strip() if isinstance(note, str) else ""
    require(to != "note" or note, "只记录不处理时，写明原因。")
    with locked(feedback_dir(flow), "routes"):
        path, record = load_feedback(flow, item)
        require(all(row["to"] != to for row in record["routes"]), f"{item} 已经记过去向 {to}。")
        row = {"to": to, "at": timestamp(), "recorded_by": actor()}
        if note:
            row["note"] = note
        record["routes"].append(row)
        write(path, record)
    return record


def new_from_feedback(flow, request, item):
    _, record = load_feedback(flow, item)
    request = dict(request)
    # The decision is committed to the repository. Keep the developer's words in the local
    # feedback record and let the Agent write the reviewed summary in the decision.
    request.setdefault("authorization_ref", f"开发者反馈 {item}（{record['at']} 登记）")
    if not request.get("observed_in_version"):
        version = record["daily"]["packages"].get(PACKAGES[0])
        require(version and version != "unknown", f"{item} 没有读到日常版本，请在输入里写明 observed_in_version。")
        request["observed_in_version"] = version
    result = flow.new(request)
    route(flow, item, "new:" + request["id"])
    return {**result, "feedback": item}


def unrouted_feedback(flow):
    root = feedback_dir(flow)
    rows = []
    if root.is_dir():
        paths = [path for path in root.glob("F*/feedback.json") if FEEDBACK_ID.fullmatch(path.parent.name)]
        for path in sorted(paths, key=lambda row: int(row.parent.name[1:])):
            record = read(path)
            if not record["routes"]:
                summary = record["text"].strip().splitlines()[0][:120]
                rows.append({"id": record["id"], "at": record["at"], "summary": summary,
                             "daily": record["daily"]["packages"]})
    return rows


# Retirement -----------------------------------------------------------------

def retire(flow, key, reason, replaced_by=None):
    directory, _ = flow.task(key)
    words = text_field(reason, "退场原因")
    if replaced_by is not None:
        require(replaced_by != key, "任务不能被自己取代。")
        flow.task(replaced_by)
    with locked(directory, "task"):
        path = directory / "retired.json"
        require(not path.exists(), f"{key} 已经退场。")
        result = {"reason": words, "replaced_by": replaced_by, "at": timestamp(), "recorded_by": actor()}
        write(path, result)
    return {"task": key, **result}


# Progress -------------------------------------------------------------------

def unknown_fields(value, path=""):
    found = []
    if isinstance(value, dict):
        if value.get("phase") == "unknown":
            found.append((path + "." if path else "") + "phase")
        for key, child in value.items():
            if isinstance(child, (dict, list)):
                found += unknown_fields(child, (path + "." if path else "") + str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found += unknown_fields(child, f"{path}[{index}]")
    return found


def pending_writes(state):
    """Records of external writes whose outcome was never confirmed."""
    from release_candidates import settled_journals
    found = []
    if not state.is_dir():
        return found
    settled = settled_journals(state)
    for root, dirs, files in os.walk(state):
        dirs[:] = sorted(name for name in dirs if name not in SKIP_DIRS)
        here = Path(root)
        for name in sorted(files):
            if not name.endswith(".json"):
                continue
            path = here / name
            try:
                data = read(path)
                if (path, digest(path.read_bytes())) in settled:
                    continue
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict):
                continue
            relative = path.relative_to(state).as_posix()
            phase = data.get("phase")
            rule = ADVISORY if name.startswith("advisory-") else IN_FLIGHT.get(name)
            if rule and phase in rule[0]:
                found.append({"file": relative, "field": "phase", "phase": phase, "what": rule[1]})
                continue
            if name == "task.json" and phase == "starting":
                found.append({"file": relative, "field": "phase", "phase": phase, "what": "start 建独立目录"})
                continue
            if (name == "attempt.json" and data.get("request_sent") is not False and
                    not (here / "response.json").is_file() and not (here / "billing-reconciliation.json").is_file()):
                found.append({"file": relative, "field": "phase", "phase": str(phase), "what": "独立审阅请求"})
                continue
            for field in unknown_fields(data):
                found.append({"file": relative, "field": field, "phase": "unknown", "what": "结果未知的记录"})
    return found


def local_head(task):
    checkout = task.get("checkout")
    if not checkout or not Path(checkout).is_dir():
        return None
    try:
        return git_line(Path(checkout), "rev-parse", "HEAD")
    except (WorkflowError, OSError):
        return None


def local_development(task):
    checkout = task.get("checkout")
    if not checkout or not Path(checkout).is_dir():
        return "独立目录不存在，先核对任务记录"
    try:
        dirty = git_line(Path(checkout), "status", "--porcelain")
        ahead = git_line(Path(checkout), "rev-list", "--count", f"{task['base']}..HEAD")
    except (WorkflowError, OSError, KeyError) as exc:
        return f"读不到独立目录的提交：{exc}"
    if dirty:
        return "开发中，独立目录有未提交的改动"
    if ahead == "0":
        return "开发中，还没有提交"
    return f"已有 {ahead} 个提交，待 submit"


def load_json(path):
    return read(path) if path.is_file() else {}


class Row:
    def __init__(self, task, mine):
        self.task = task
        self.mine = mine

    def __call__(self, stage, step, waiting, closed=False, **extra):
        return {"id": self.task["id"], "title": self.task.get("title"), "stage": stage, "next": step,
                "waiting_on": waiting, "closed": closed, "asks": [row["id"] for row in self.mine], **extra}

    def wait(self, agent_step, murphy_step):
        if self.mine:
            return f"{murphy_step}：{'、'.join(row['id'] for row in self.mine)}", "开发者"
        return agent_step, "Agent"


def review_progress(flow, run, number, row):
    extra = {"pr": number}
    if (run / "receipt.json").is_file():
        receipt = read(run / "receipt.json")
        if receipt.get("verdict") == "pass":
            if load_json(run / "comment.json").get("phase") != "confirmed":
                return row("D4", f"PR #{number} 的审阅评论结果未确认，先核对", "核对", **extra)
            return row("D4", f"PR #{number} 独立审阅通过，可以 merge --pr {number}", "Agent", **extra)
        blocking = "、".join(receipt.get("blocking_checks") or []) or "未列明"
        return row("D4", f"PR #{number} 独立审阅未通过（阻塞项：{blocking}），退回修复", "Agent", **extra)
    if (run / "attempt.json").is_file():
        if (run / "response.json").is_file():
            return row("D4", f"已收到 PR #{number} 的审阅回复，再运行 review 生成回执", "Agent", **extra)
        if load_json(run / "attempt.json").get("request_sent") is False:
            return row("D4", f"PR #{number} 的审阅请求没有送出，核对后再发起", "核对", **extra)
        return row("D4", f"PR #{number} 的审阅结果未知，先核对请求编号和服务用量", "核对", **extra)
    if (run / "estimate.json").is_file():
        estimate = read(run / "estimate.json")
        usd = estimate.get("estimated_usd_at_output_limit", "未知")
        waiting = [item["id"] for item in row.mine if item["kind"] == "approve"]
        if waiting:
            return row("D4", f"PR #{number} 审阅估算 {usd} 美元，等开发者答授权单：{'、'.join(waiting)}",
                       "开发者", **extra)
        approved = [item["id"] for item in all_asks(flow) if granted(item) and (
            item["binds"].get("packet") == estimate.get("packet") or item["binds"].get("pr") == number)]
        if approved:
            return row("D4", f"PR #{number} 的审阅已获批准，可以 review --pr {number} --approval {approved[-1]}",
                       "Agent", **extra)
        return row("D4", f"PR #{number} 审阅材料已准备，估算 {usd} 美元，开审阅费用授权单", "Agent", **extra)
    return row("D4", f"PR #{number} 等 GitHub 检查通过后运行 review --pr {number} 准备材料", "GitHub", **extra)


def after_merge(flow, directory, merge, number, row):
    release = (merge.get("target") or {}).get("release")
    if not release:
        return row("D5", f"已合入 main（{merge.get('source', '')[:7]}），不涉及发行", "无", closed=True, pr=number)
    version = release["version"]
    folder = flow.state / "releases" / version
    extra = {"pr": number, "version": version}
    import release_candidates as candidates
    if candidates.index(flow, version):
        candidate_dir, candidate = candidates.current(flow, version)
        extra.update(candidate=candidate["id"], candidate_number=candidate["number"])
        if candidate["source"] != merge["source"] and candidates.publication_record(flow, candidate, "npm-publish.json").get("phase") != "published":
            return row("D5", f"原候选已被第 {candidate['number']} 次候选取代；运行 candidate --version {version} 查看当前待办",
                       "Agent", **extra)
        folder = candidates.publication_directory(flow, candidate)
        built = (candidates.artifacts(flow, candidate) / "release.json").is_file()
        if not built:
            return row("D5", f"第 {candidate['number']} 次候选待构建，运行 release --version {version} --prepare",
                       "Agent", **extra)
        github = candidates.publication_record(flow, candidate, "github.json")
        if not github:
            pending = candidates.readiness(candidate_dir, candidate)
            if pending:
                return row("D5", "发布前待办：" + "；".join(pending), "Agent", **extra)
            if candidates.frozen_reasons(flow, version):
                return row("D5", "本候选已有对外写入记录，先核对远端结果", "核对", **extra)
            step, who = row.wait("候选已通过发布前验证，准备绑定本候选及整组包的发布授权", "等开发者答复发布授权")
            return row("D5", step, who, **extra)
    else:
        built = (folder / "release.json").is_file()
    names = ("github.json", "finalize.json", "npm-publish.json")
    github, final, npm = (candidates.publication_record(flow, candidate, name) for name in names) if candidates.index(flow, version) else (
        load_json(folder / name) for name in names)
    if not built:
        return row("D5", f"已合入，待 release --version {version} 构建发行包", "Agent", **extra)
    if github.get("phase") in IN_FLIGHT["github.json"][0]:
        return row("D5", f"{version} 的 GitHub 发行写入结果未知，先核对", "核对", **extra)
    if not github:
        return row("D5", f"已构建，待 release --version {version} 建 GitHub 发行草稿", "Agent", **extra)
    if final.get("phase") == "finalizing":
        return row("D5", f"{version} 公开 GitHub 发行的结果未知，先核对", "核对", **extra)
    if github.get("phase") != "published":
        step, who = row.wait(f"{version} 的 GitHub 草稿已建，准备隔离验收并开操作单", "等开发者完成隔离验收")
        return row("D5", step, who, **extra)
    if npm.get("phase") != "published":
        step, who = row.wait(f"{version} 已在 GitHub 发行，待 npm 发布（需授权单和通行密钥）", "等开发者答复")
        return row("D5", step, who, **extra)
    observations = sorted((read(path) for path in (directory / "observations").glob("*.json")),
                          key=lambda item: item.get("at", ""))
    if not observations:
        step, who = row.wait(f"{version} 已上架 npm，开日常更新操作单", "等开发者在日常 DSH 更新并回报")
        return row("D6", step, who, **extra)
    latest = observations[-1]
    outcome = latest.get("outcome") if latest.get("outcome") in OUTCOMES else "unconfirmed"
    if outcome == "pass":
        return row("D6", f"{version} 已通过开发者的实际验收", "无", closed=True, outcome=outcome, **extra)
    label = {"fail": "未通过", "unconfirmed": "未确认"}[outcome]
    step, who = row.wait(f"{version} 的实际验收{label}，决定修复还是继续验证", "等开发者答复")
    return row("D6", step, who, outcome=outcome, observed_at=latest.get("at"), **extra)


def task_progress(flow, directory, task, open_asks):
    key = task["id"]
    row = Row(task, [item for item in open_asks if item.get("task") == key])
    if (directory / "retired.json").is_file():
        info = read(directory / "retired.json")
        return row("retired", "已退场：" + info["reason"], "无", closed=True, reason=info["reason"],
                   replaced_by=info.get("replaced_by"))
    phase = task.get("phase")
    if phase == "draft":
        try:
            note = flow.check(key)
        except (WorkflowError, OSError, ValueError, KeyError) as exc:
            return row("D2", f"补全决策：{exc}", "Agent")
        if not aligned(directory, note["sha256"]):
            return row("D2", "决策已写完，等开发者读完全文后确认对齐", "开发者")
        decisions = [item["id"] for item in row.mine if item["kind"] == "decide"]
        if decisions:
            return row("D2", f"等开发者答决定单：{'、'.join(decisions)}", "开发者")
        return row("D2", "决策已对齐，可以 start", "Agent")
    if phase == "starting":
        return row("D3", "start 没有完成，先核对独立目录和 main", "核对")
    if phase != "open":
        return row("?", f"无法识别的任务阶段 {phase}", "核对")
    submit = load_json(directory / "submit.json")
    if submit.get("phase") != "confirmed":
        if submit.get("phase") in IN_FLIGHT["submit.json"][0]:
            return row("D3", "上次推送或创建 PR 的结果未知，先到 GitHub 核对", "核对")
        return row("D3", local_development(task), "Agent")
    number = submit["pr"]
    merge = load_json(flow.state / "prs" / str(number) / "merge-attempt.json")
    if merge.get("phase") in IN_FLIGHT["merge-attempt.json"][0]:
        return row("D5", f"PR #{number} 上次合入结果未知，先到 GitHub 核对", "核对", pr=number)
    if merge.get("phase") == "confirmed":
        return after_merge(flow, directory, merge, number, row)
    head = local_head(task)
    if head and head != submit["head"]:
        return row("D3", f"独立目录有 PR #{number} 之后的新提交，待重新 submit", "Agent", pr=number)
    return review_progress(flow, flow.state / "prs" / str(number) / f"{submit['head']}-{submit['base']}", number, row)


def ask_summary(record):
    steps = record.get("steps") or []
    done = len({item["step"] for item in record["answers"] if "step" in item})
    summary = {"id": record["id"], "kind": ASK_KINDS[record["kind"]], "title": record["title"],
               "task": record.get("task"), "replies": record["replies"]}
    if steps:
        summary["steps_done"] = f"{done}/{len(steps)}"
    return summary


def entry_commit(main):
    try:
        commit = git_line(HERE, "rev-parse", "HEAD")
    except (WorkflowError, OSError):
        return {"commit": None, "same_as_main": False, "note": "入口代码不在 Git 副本中"}
    return {"commit": commit, "same_as_main": commit == main}


def remote_facts(flow, tasks):
    main = flow.repo.main()
    facts = {"main": main, "entry": entry_commit(main), "prs": []}
    for row in tasks:
        number = row.get("pr")
        if not number or row["stage"] not in ("D3", "D4"):
            continue
        pr = flow.repo.pr(number)
        item = {"task": row["id"], "pr": number, "state": pr.get("state"), "merged": bool(pr.get("merged")),
                "draft": pr.get("draft"), "head": pr["head"]["sha"], "base_is_main": pr["base"]["sha"] == main}
        runs = flow.repo.api(f"/actions/workflows/desktop-checks.yml/runs?head_sha={item['head']}&per_page=1")
        latest = runs.get("workflow_runs") or []
        item["ci"] = ({"status": latest[0]["status"], "conclusion": latest[0]["conclusion"], "url": latest[0]["html_url"]}
                      if latest else None)
        if pr.get("state") == "closed" and not pr.get("merged"):
            item["note"] = "PR 已关闭且未合入，确认后用 retire 标记任务"
        facts["prs"].append(item)
    return facts


def progress(flow, remote=False):
    """Read-only summary for `next`. Without --remote it uses no network and writes nothing."""
    open_asks = [row for row in all_asks(flow) if row["status"] == "open"]
    tasks, retired = [], []
    for path in sorted((flow.state / "tasks").glob("*/task.json")):
        row = task_progress(flow, path.parent, read(path), open_asks)
        (retired if row["stage"] == "retired" else tasks).append(row)
    result = {"repo": flow.repo.name, "daily": daily_version(), "tasks": tasks,
              "asks": [ask_summary(row) for row in open_asks], "feedback": unrouted_feedback(flow),
              "pending_writes": pending_writes(flow.state), "retired": retired}
    if remote:
        result["remote"] = remote_facts(flow, tasks)
    return result


def cell(value):
    return str(value).replace("|", "\\|").replace("\n", " ")


def render(result):
    daily = "，".join(f"{name} {version}" for name, version in result["daily"]["packages"].items())
    lines = [MARK_START, "", "以下由 `next --write` 生成，请勿手改。", "",
             f"日常 DSH 实际安装：{daily}（读取于 {result['daily']['checked_at']}）", ""]
    if result["tasks"]:
        lines += ["| 任务 | 环节 | 下一步 | 等谁 |", "|---|---|---|---|"]
        for row in result["tasks"]:
            stage = row["stage"] + ("，已闭环" if row["closed"] else "")
            lines.append(f"| {cell(row['id'])} | {stage} | {cell(row['next'])} | {cell(row['waiting_on'])} |")
        lines.append("")
    sections = (
        ("等开发者回复的请求单", [f"{row['id']} {row['kind']}：{row['title']}" for row in result["asks"]]),
        ("结果未知的写入，先核对", [f"{row['file']}：{row['what']}（{row['field']} = {row['phase']}）"
                                  for row in result["pending_writes"]]),
        ("还没有去向的反馈", [f"{row['id']}（{row['at']}）：{row['summary']}" for row in result["feedback"]]),
        ("已退场的任务", [f"{row['id']}：{row['reason']}" + (f"（由 {row['replaced_by']} 取代）" if row["replaced_by"] else "")
                         for row in result["retired"]]),
    )
    for title, items in sections:
        if items:
            lines += [title + "：", "", *[f"- {cell(item)}" for item in items], ""]
    lines.append(MARK_END)
    return "\n".join(lines)


def write_section(target, section):
    target = Path(target).expanduser()
    current = target.read_text() if target.is_file() else ""
    mode = target.stat().st_mode & 0o777 if target.is_file() else 0o644
    if MARK_START in current and MARK_END in current.partition(MARK_START)[2]:
        head, _, rest = current.partition(MARK_START)
        updated = head + section + rest.partition(MARK_END)[2]
    else:
        updated = current.rstrip("\n") + ("\n\n" if current.strip() else "") + section + "\n"
    write(target, updated.encode())
    target.chmod(mode)
