"""Delegate old/new task identities to the owning workflow, never allocate IDs."""
from common import require


def resolve(flow, reference, *, current=True):
    directory, task = flow.task(reference)
    if current and task.get("delivery"):
        import delivery
        delivery.ensure_current(flow, task)
    return directory, task


def review_directory(flow, target):
    if target.get("review_id"):
        import delivery
        rows = [row for row in delivery.reviews(flow, target["delivery"]) if row["id"] == target["review_id"]]
        require(len(rows) == 1 and rows[0]["target"] == target, "已合入源码的原独立审阅编号或材料不一致。")
        path = (flow.state / rows[0]["run"]).resolve()
        require(path.is_relative_to(flow.state), "原独立审阅位置不属于当前记录。")
        return path
    return flow.state / "prs" / str(target["pr"]) / (target["head"] + "-" + target["base"])
