"""Explicit one-packet execution consent. No text inference or price estimates."""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
import re

from common import digest, locked, read, require, timestamp, write

POLICY_VERSION = 1
KEY_ID = re.compile(r"[a-f0-9]{64}")
FIELDS = {"version", "provider", "model", "key_id", "max_requests", "expires_at",
          "max_cost_usd", "cost_bound_usd", "bound_evidence", "publish"}


def dollars(value, zero=False):
    from collab import amount
    return amount(value, allow_zero=zero)


def expiry(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError):
        parsed = None
    require(parsed is not None and parsed.tzinfo is not None, "授权到期时间须含时区。")
    return parsed


def validate_execution(value, binds):
    from desktop_review_request import MAX_COST, RELAY_MODEL
    require(isinstance(value, dict) and set(value) == FIELDS, "后台审阅执行条件缺失或含未知字段。")
    require(value["version"] == POLICY_VERSION and type(value["version"]) is int, "执行规则版本不符。")
    require(value["provider"] == "lmuai" and value["model"] == RELAY_MODEL, "后台审阅只支持已登记的灵眸模型。")
    require(isinstance(value["key_id"], str) and KEY_ID.fullmatch(value["key_id"]), "缺少专用密钥标识。")
    require(type(value["max_requests"]) is int and value["max_requests"] == 1, "本阶段每份材料只批准一次发送。")
    require(type(value["publish"]) is bool, "须明确是否允许写回提案及建立后续 Issue。")
    require("packet" in binds, "后台审阅必须绑定一份固定材料。")
    expiry(value["expires_at"])
    cap, bound = dollars(value["max_cost_usd"]), dollars(value["cost_bound_usd"])
    require(bound <= cap <= MAX_COST, "费用上界须在批准金额和专用密钥最大额度内。")
    evidence = value["bound_evidence"]
    require(isinstance(evidence, str) and evidence in binds.get("files", {}),
            "费用上界必须绑定已核对的计费依据文件，不能使用费用估算。")
    bound_document(value)
    return value


def bound_document(policy):
    """Check an operator-verified tariff/cap record, never a starting-price estimate."""
    from desktop_review_request import CONTEXT, MAX_OUTPUT
    path = Path(policy["bound_evidence"])
    require(path.is_absolute() and path.is_file(), "缺少费用上界依据文件。")
    evidence = read(path)
    require(evidence.get("provider") == policy["provider"] and evidence.get("model") == policy["model"] and
            evidence.get("verified_by_operator") is True and isinstance(evidence.get("source"), str) and
            evidence["source"].strip(), "费用依据须注明核对来源、服务、模型及操作者确认。")
    require(expiry(evidence.get("valid_until")) >= expiry(policy["expires_at"]), "计费依据先于本次授权失效。")
    if evidence.get("kind") == "provider_request_cap":
        require(evidence.get("covers_inflight") is True, "服务额度说明尚未覆盖在途请求。")
        bound = dollars(evidence.get("maximum_request_usd"))
    else:
        require(evidence.get("kind") == "verified_tariff" and evidence.get("covers_all_charges") is True,
                "须核对包含全部计费项目的实际费率，公开起步价不能作为上界。")
        require(type(evidence.get("input_token_ceiling")) is int and evidence["input_token_ceiling"] >= CONTEXT and
                type(evidence.get("output_token_ceiling")) is int and evidence["output_token_ceiling"] >= MAX_OUTPUT,
                "计费依据未覆盖请求最大输入和输出。")
        bound = (evidence["input_token_ceiling"] * dollars(evidence.get("input_usd_per_million")) +
                 evidence["output_token_ceiling"] * dollars(evidence.get("output_usd_per_million"))) / Decimal(1000000)
        bound += dollars(evidence.get("fixed_usd"), zero=True)
    require(bound <= dollars(policy["cost_bound_usd"]), "批准记录中的费用上界低于计费依据。")
    return bound


def execution_approval(flow, ask, packet, key_id, *, sending=True):
    from collab import granted, load_ask
    _, record = load_ask(flow, ask)
    policy = validate_execution(record.get("execution"), record.get("binds", {}))
    require(granted(record), f"{ask} 未批准或已经撤回。")
    require(record["binds"]["packet"] == packet and policy["key_id"] == key_id,
            "授权的审阅材料或密钥发生变化。")
    if sending:
        require(expiry(policy["expires_at"]) > datetime.now(timezone.utc), "审阅授权已经到期。")
        evidence = Path(policy["bound_evidence"])
        require(evidence.is_file() and digest(evidence.read_bytes()) == record["binds"]["files"][str(evidence)],
                "费用依据文件已经变化，不能沿用旧授权。")
    return policy


def revoke(flow, ask, words):
    from collab import asks_dir, load_ask
    require(isinstance(words, str) and words.strip(), "撤回需登记开发者原话。")
    with locked(asks_dir(flow), "answers"):
        path, record = load_ask(flow, ask)
        require(record["kind"] == "approve", "只能撤回授权单。")
        require(not record.get("revoked"), "这张授权单已经撤回。")
        record["revoked"] = {"text": words.strip(), "at": timestamp()}
        write(path, record)
    return {"id": ask, "revoked": record["revoked"], "note": "停止后续发送；已发送请求仍可能计费。"}


def check_balance(before, policy, previous=None):
    cap = dollars(before.get("key_limit_usd"))
    used = dollars(before.get("key_used_usd"), zero=True)
    balance = dollars(before.get("balance_usd"), zero=True)
    actual = dollars(before.get("actual_cost_usd"), zero=True)
    require(used <= cap and used + balance == cap, "专用密钥额度口径不一致。")
    # Both counters must agree before dispatch. Never silently mix a wallet,
    # a reset quota counter, and lifetime usage.
    require(actual == used, "密钥累计费用与额度已用值不一致，请先核对。")
    require(balance >= dollars(policy["cost_bound_usd"]), "实时余额不足以覆盖已核对的费用上界。")
    if previous:
        require(cap == dollars(previous["key_limit_usd"]) and
                before["requests"] == previous["requests"] and
                actual == dollars(previous["actual_cost_usd"], zero=True),
                "密钥额度或用量在队列之外发生变化，请先核对。")
    return before


def key_root(flow, key_id):
    require(isinstance(key_id, str) and KEY_ID.fullmatch(key_id), "密钥标识无效。")
    return flow.state.parents[1] / "review-keys" / key_id


def check_unsettled(flow, key_id, current=None):
    """Legacy unknown LMU attempts conservatively block newly unattended work."""
    for path in flow.state.parents[1].glob("*/*/prs/*/*/attempt.json"):
        if current is not None and path.parent == current:
            continue
        attempt = read(path)
        if attempt.get("provider") != "lmuai" or attempt.get("request_sent") is False:
            continue
        if attempt.get("key_id") not in (None, key_id):
            continue
        response = path.parent / "response.json"
        if response.is_file() and read(response).get("billing"):
            continue
        reconciliation = path.parent / "billing-reconciliation.json"
        if reconciliation.is_file():
            row = read(reconciliation)
            if row.get("client_request_id") == attempt.get("client_request_id") and row.get("evidence"):
                if row.get("outcome") == "no_usage":
                    continue
                if row.get("outcome") == "usage_confirmed":
                    dollars(row.get("actual_cost_usd"), zero=True)
                    continue
        require(False, "共用密钥还有结果或费用未知的请求，先核对；不会自动重发。")
