"""Only the pinned native helper starts this process with a review credential."""
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from common import require
from desktop_review_request import worker

try:
    require(len(sys.argv) == 3 and sys.argv[2] in ("dispatch", "settle", "observe"), "执行参数无效。")
    worker(Path(sys.argv[1]), settle_only=sys.argv[2] == "settle", observe_only=sys.argv[2] == "observe")
except Exception:
    # No credential or upstream response is printed, even for malformed data.
    sys.exit(1)
