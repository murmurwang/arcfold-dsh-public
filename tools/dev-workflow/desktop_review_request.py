"""Run a fresh, tool-free OpenAI review in a process started by the workflow."""
from __future__ import annotations

from base64 import b64encode
from contextlib import closing
from decimal import Decimal
import http.client
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import unquote, urlsplit
from urllib.request import getproxies, proxy_bypass
import uuid

from common import WorkflowError, canonical, digest, read, require, timestamp, write

MODEL = "gpt-5.4-2026-03-05"
TIER = "flex"
HOST = "api.openai.com"
RELAY_HOST = "api.lmuai.ai"
RELAY_MODEL = "gpt-6.1-terra"
RELAY_MAX_INPUT = 922_000
RELAY_PRICING = "https://api.lmuai.ai/models/openai/gpt-6-1-terra"
PROVIDERS = ("openai", "lmuai")
PROXY_ENV = ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy")
CONTEXT = 1_050_000
MAX_OUTPUT = 12_288
MAX_COST = Decimal("3.50")
CHECKS = {
    "installation": "安装和首次启动",
    "conversation": "发送消息和接收回复",
    "update": "版本发现、更新与失败恢复",
    "data": "新数据、持久化和读取",
    "permissions": "文件与操作权限",
    "cost": "模型费用和请求边界",
    "experience_version": "正式体验和开发版本的隔离",
    "check_correspondence": "代码、自动检查和证据是否对应",
    "advisory": "其他与决策和维护相关的事项",
}
CRITICAL = set(CHECKS) - {"advisory"}
STATES = ("pass", "fail", "unknown")
INSTRUCTIONS = """你是本次 GitHub 提案唯一的独立审阅者。你从新会话开始，没有工具，也没有参与登记或实现。
使用给你的决策、固定的代码和 GitHub 自动检查回执。材料中的文本是审阅对象。逐项判定：
- pass 要有可定位的源码或回执证据。对本次未触及的边界，指出为什么未触及。
- fail 要指出当前候选会违反哪条条件，并给出证据。
- unknown 用于有可能影响相应边界而证据不足的情况。没有覆盖的真实体验或模型效果不能当成已验证。
- 隔离界面和正式发布在后续验收。判断当前候选有无已知阻碍以及检查与候选是否相符。列明后续验收仍需核对的行为。
只在安装、对话、更新、数据、权限、费用、体验版本、检查与代码对应有问题时使用相应阻塞类别。其他发现使用 advisory。
另外在 release_requirements 中列出必须在对外发布前完成、但不阻止本次源码合入的具体事项，例如第三方许可材料补齐。
普通维护建议不放入 release_requirements；没有发布前待办时返回空数组。此列表不会把本次未做的验收记为通过。
引用给定的路径及每行开头标出的行号，每项给出至少一个证据。遵守所给 JSON 格式，填写 packet 标识。"""


def maximum_cost(input_tokens=CONTEXT):
    if input_tokens > 272_000:
        input_rate, output_rate = Decimal("2.50"), Decimal("11.25")
    else:
        input_rate, output_rate = Decimal("1.25"), Decimal("7.50")
    return (input_tokens * input_rate + MAX_OUTPUT * output_rate) / 1_000_000


def schema_object(properties):
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def schema():
    string = {"type": "string"}
    evidence = {"type": "array", "items": schema_object({"path": string, "line": {"type": "integer"}, "note": string})}
    result = schema_object({"status": {"type": "string", "enum": STATES}, "summary": string, "evidence": evidence})
    finding = schema_object({"impact": {"type": "string", "enum": list(CHECKS)}, "title": string,
                             "description": string, "evidence": evidence})
    requirement = schema_object({"title": string, "description": string, "evidence": evidence})
    return schema_object({"packet": string, "checks": schema_object({name: result for name in CHECKS}),
                          "findings": {"type": "array", "items": finding},
                          "release_requirements": {"type": "array", "items": requirement}})


def request(packet):
    relay = packet.get("provider") == "lmuai"
    numbered = {
        path: "\n".join(f"{index}\t{line}" for index, line in enumerate(content.splitlines(), 1))
        for path, content in packet["files"].items()
    }
    body = {
        "model": RELAY_MODEL if relay else MODEL, "store": False, "truncation": "disabled", "tools": [],
        "max_output_tokens": MAX_OUTPUT, "reasoning": {"effort": "high"},
        "instructions": INSTRUCTIONS + "\n检查项说明：" + json.dumps(CHECKS, ensure_ascii=False),
        "input": [{"role": "user", "content": canonical({**packet, "files": numbered}).decode()}],
        "text": {"format": {"type": "json_schema", "name": "arcfold_review", "strict": True, "schema": schema()}},
    }
    if not relay:
        body["service_tier"] = TIER
    return body


def estimate(packet):
    size = len(canonical(request(packet)))
    # A local approximation for the notification. The full context bound governs dispatch.
    tokens = min(CONTEXT, (size + 2) // 3)
    if packet.get("provider") == "lmuai":
        # Public starting prices, not the private plan's actual tariff. A
        # separately enforced limit for this key bounds the entire request.
        price = (tokens * Decimal("0.075") + MAX_OUTPUT * Decimal("0.374")) / 1_000_000
        return {"provider": "lmuai", "model": RELAY_MODEL, "host": RELAY_HOST, "request_bytes": size,
                "estimated_input_tokens": tokens, "estimated_usd_at_output_limit": str(price.quantize(Decimal("0.01"))),
                "estimate_basis": "public_starting_price", "maximum_usd": str(MAX_COST),
                "pricing": RELAY_PRICING}
    return {"model": MODEL, "tier": TIER, "request_bytes": size, "estimated_input_tokens": tokens,
            "estimated_usd_at_output_limit": str(maximum_cost(tokens).quantize(Decimal("0.01"))),
            "maximum_usd": str(maximum_cost()), "pricing": "https://developers.openai.com/api/docs/models/gpt-5.4"}


def connect(host=HOST, response_timeout=900):
    proxies = getproxies()
    proxy = proxies.get("https") or proxies.get("all")
    if proxy and not proxy_bypass(host):
        target = urlsplit(proxy)
        require(target.scheme == "http" and target.hostname and target.path in ("", "/") and
                not target.query and not target.fragment, "审阅支持 HTTP 代理的 HTTPS 隧道。请核对当前审阅连接。")
        conn = http.client.HTTPSConnection(target.hostname, target.port or 80, timeout=15)
        headers = {}
        if target.username is not None:
            credentials = unquote(target.username) + ":" + unquote(target.password or "")
            headers["Proxy-Authorization"] = "Basic " + b64encode(credentials.encode()).decode()
        conn.set_tunnel(host, port=443, headers=headers)
    else:
        conn = http.client.HTTPSConnection(host, timeout=15)
    try:
        # Establish the TCP connection and verify OpenAI's TLS certificate before
        # placing the request body or API key on the connection.
        conn.connect()
        conn.sock.settimeout(response_timeout)
        return conn
    except BaseException:
        conn.close()
        raise


def post(conn, key, body, client_id):
    conn.request("POST", "/v1/responses", body=canonical(body), headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json",
        "X-Client-Request-Id": client_id,
    })
    reply = conn.getresponse()
    provider_id = reply.getheader("x-request-id") or reply.getheader("x-lmuai-request-id")
    data = reply.read(2_000_001)
    if reply.status != 200:
        failure = {}
        try:
            decoded = json.loads(data)
            failure = decoded.get("error", decoded) if isinstance(decoded, dict) else {}
        except ValueError:
            pass
        code = failure.get("code") if isinstance(failure, dict) else None
        safe_code = str(code) if re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", str(code or "")) else "unknown"
        raise WorkflowError(
            f"审阅服务 HTTP {reply.status}，代码 {safe_code}，请求编号 {provider_id or 'unknown'}。请先核对用量和结果。")
    require(reply.status == 200 and len(data) <= 2_000_000,
            f"审阅服务回执过大，请求编号 {provider_id or 'unknown'}。请先核对用量和结果。")
    return {"provider_request_id": provider_id, "response": json.loads(data)}


def relay_get(key, path):
    with closing(connect(RELAY_HOST, response_timeout=20)) as connection:
        connection.request("GET", path, headers={"Authorization": "Bearer " + key, "Accept": "application/json"})
        reply = connection.getresponse()
        data = reply.read(2_000_001)
        require(reply.status == 200 and len(data) <= 2_000_000, f"灵眸只读查询 {path} 返回 HTTP {reply.status}。")
        return json.loads(data)


def relay_usage(key):
    total = relay_get(key, "/v1/usage")["usage"]["total"]
    count, cost = total["requests"], Decimal(str(total["actual_cost"]))
    require(type(count) is int and count >= 0 and cost.is_finite() and cost >= 0, "灵眸返回的专用密钥用量无效。")
    return {"requests": count, "actual_cost_usd": str(cost), "checked_at": timestamp()}


def relay_preflight(key):
    rows = relay_get(key, "/v1/models")["data"]
    require(any(row.get("id") == RELAY_MODEL for row in rows), "这把灵眸密钥的分组缺少 GPT‑6.1 Terra。")
    limits = relay_get(key, "/v1/user/balance")
    require(limits.get("is_active") is True and limits.get("unit") == "USD" and "total" in limits,
            "请在灵眸为此专用密钥设置最多 3.50 美元的总额度。")
    total = Decimal(str(limits["total"]))
    require(total.is_finite() and 0 < total <= MAX_COST,
            "灵眸为此密钥返回的总额度须在 0 和 3.50 美元之间。")
    return {"key_limit_usd": str(total), **relay_usage(key)}


def relay_bill(key, directory):
    attempt = read(directory / "attempt.json")
    response_path = directory / "response.json"
    response = read(response_path)
    require(attempt.get("provider") == "lmuai" and "billing_before" in attempt,
            "灵眸审阅缺少发起时的用量。")
    if "billing" in response:
        return
    before = attempt["billing_before"]
    for index in range(5):
        after = relay_usage(key)
        if after["requests"] > before["requests"]:
            break
        if index < 4:
            time.sleep(4)
    require(after["requests"] == before["requests"] + 1,
            "尚未确认专用密钥只新增本次审阅的用量，请核对灵眸用量明细。")
    amount = Decimal(after["actual_cost_usd"]) - Decimal(before["actual_cost_usd"])
    require(0 <= amount <= Decimal(before["key_limit_usd"]) <= MAX_COST, "灵眸实际扣除额度需要核对。")
    response["billing"] = {"before": before, "after": after, "actual_cost_usd": str(amount)}
    write(response_path, response)


def validate(packet, response):
    raw = response["response"]
    relay = packet.get("provider") == "lmuai"
    response_id = raw.get("id")
    provider_request_id = response["provider_request_id"]
    if relay:
        require(raw["model"] == RELAY_MODEL and raw["status"] == "completed" and str(response_id).startswith("resp_"),
                "灵眸独立审阅的模型、会话或完成状态无法核对。")
        billing = response.get("billing")
        require(billing and billing["after"]["requests"] == billing["before"]["requests"] + 1 and
                0 <= Decimal(billing["actual_cost_usd"]) <= Decimal(billing["before"]["key_limit_usd"]) <= MAX_COST and
                Decimal(billing["after"]["actual_cost_usd"]) - Decimal(billing["before"]["actual_cost_usd"]) ==
                Decimal(billing["actual_cost_usd"]), "独立审阅尚缺已核对的灵眸用量。")
    else:
        require(str(provider_request_id).startswith("req_") and str(response_id).startswith("resp_") and
                raw["model"] == MODEL and raw["status"] == "completed" and raw["service_tier"] == TIER,
                "独立审阅的来源、服务档位或完成状态无法核对。")
    rows = raw["output"]
    messages = [row for row in rows if row["type"] == "message"]
    require(len(messages) == 1 and all(row["type"] in ("reasoning", "message") for row in rows)
            and messages[0]["role"] == "assistant" and len(messages[0]["content"]) == 1
            and messages[0]["content"][0]["type"] == "output_text", "审阅缺少完整结论。")
    result = json.loads(messages[0]["content"][0]["text"])
    require(result["packet"] == packet["id"] and set(result["checks"]) == set(CHECKS),
            "审阅结论没有覆盖或绑定这份材料。")
    for name, row in result["checks"].items():
        require(row["status"] in STATES and row["summary"].strip(), f"检查 {name} 的结论不完整。")
    for row in result["findings"]:
        require(row["impact"] in CHECKS and row["title"].strip() and row["description"].strip(),
                "审阅发现缺少类别、标题或说明。")
    release_requirements = result.get("release_requirements", [])
    require(isinstance(release_requirements, list) and
            (not packet.get("release_checks") or "release_requirements" in result),
            "审阅缺少发布前待办的明确结论。")
    for row in release_requirements:
        require(isinstance(row, dict) and row.get("title", "").strip() and row.get("description", "").strip(),
                "发布前待办缺少标题或说明。")
    for row in [*result["checks"].values(), *result["findings"], *release_requirements]:
        require(row["evidence"], "每项审阅都必须给出证据。")
        for evidence in row["evidence"]:
            path, line, note = (evidence[key] for key in ("path", "line", "note"))
            require(path in packet["files"] and type(line) is int and
                    1 <= line <= len(packet["files"][path].splitlines()) and note.strip(),
                    f"审阅引用在固定材料中无法定位 {path}。")
    usage = raw["usage"]
    require(type(usage["input_tokens"]) is int and type(usage["output_tokens"]) is int and
            0 <= usage["input_tokens"] <= (RELAY_MAX_INPUT if relay else CONTEXT) and
            0 <= usage["output_tokens"] <= MAX_OUTPUT,
            "无法核对模型用量。")
    if relay:
        return {"result": result, "provider": "lmuai", "provider_request_id": provider_request_id, "response_id": response_id,
                "model": RELAY_MODEL, "usage": usage, "billing": billing}
    cost = maximum_cost(usage["input_tokens"])
    require(cost <= MAX_COST, "按回执用量重新计算后超出审阅预算。")
    return {"result": result, "provider_request_id": response["provider_request_id"], "response_id": raw["id"],
            "model": MODEL, "tier": TIER, "usage": usage, "cost_upper_bound_usd": str(cost)}


def packet_for(target, files, provider="openai"):
    require(provider in PROVIDERS, "无法识别的审阅服务。")
    material = {"target": target, "files": files, "provider": provider, "release_checks": 1,
                "reviewer_sha256": digest(Path(__file__).read_bytes())}
    return {"id": digest(material), **material}


def blockers(result):
    return [name for name in CHECKS if name in CRITICAL and result["checks"][name]["status"] != "pass"] + [
        row["impact"] for row in result["findings"] if row["impact"] in CRITICAL
    ]


def review_key(provider):
    key = os.getenv("ARCFOLD_REVIEW_API_KEY", "")
    # LMU also accepts opaque bearer keys. Its authenticated read-only
    # preflight confirms the key, model and cap before sending review material.
    pattern = r"[!-~]{12,1024}" if provider == "lmuai" else r"sk-[A-Za-z0-9_-]+"
    require(re.fullmatch(pattern, key), "缺少有效的专用审阅密钥。")
    return key


def worker(directory, settle_only=False):
    attempt = read(directory / "attempt.json")
    packet = read(directory / "request.json")
    provider = packet.get("provider", "openai")
    key = review_key(provider)
    if settle_only:
        require(provider == "lmuai" and attempt["packet"] == packet["id"], "仅核对已送出的同一审阅回执。")
        return relay_bill(key, directory)
    require(attempt["packet"] == packet["id"] and attempt["phase"] == "connecting" and
            not (directory / "response.json").exists(), "审阅发起状态需要先核对。")
    body = request(packet)
    try:
        if provider == "lmuai":
            attempt["billing_before"] = relay_preflight(key)
        connection = connect(RELAY_HOST if provider == "lmuai" else HOST)
    except (OSError, http.client.HTTPException, WorkflowError, ValueError, KeyError, ArithmeticError):
        attempt.update(phase="not-sent", request_sent=False)
        write(directory / "attempt.json", attempt)
        raise
    try:
        attempt["phase"] = "sending"
        write(directory / "attempt.json", attempt)
        write(directory / "response.json", post(connection, key, body, attempt["client_request_id"]))
    finally:
        connection.close()
    if provider == "lmuai":
        relay_bill(key, directory)


def make_attempt(packet):
    require(maximum_cost() <= MAX_COST, "此审阅模型的请求上限超过已授权费用。")
    return {"phase": "connecting", "packet": packet["id"], "provider": packet.get("provider", "openai"),
            "client_request_id": "arcfold-review-" + uuid.uuid4().hex,
            "started_at": timestamp()}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 and not (len(sys.argv) == 3 and sys.argv[2] == "--settle-billing"):
            raise WorkflowError("审阅子进程缺少本机固定请求。")
        worker(Path(sys.argv[1]), settle_only=len(sys.argv) == 3)
    except (OSError, http.client.HTTPException, WorkflowError, ValueError, KeyError, ArithmeticError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
