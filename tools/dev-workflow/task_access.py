"""Delegate old/new task identities to the owning workflow, never allocate IDs."""


def resolve(flow, reference, *, current=True):
    directory, task = flow.task(reference)
    if current and task.get("delivery"):
        import delivery
        delivery.ensure_current(flow, task)
    return directory, task
