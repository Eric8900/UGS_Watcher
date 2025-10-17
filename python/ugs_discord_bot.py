import os, json, time, asyncio, requests, sys
import discord
from pathlib import Path
from typing import Dict, Any, List, Tuple
from dotenv import load_dotenv
load_dotenv()

# ====== CONFIG VIA ENV VARS ======
BASE_URL = "https://utexas.instructure.com"
COURSE_ID = os.getenv("COURSE_ID", "1431941")
ENDPOINT = f"{BASE_URL}/api/v1/courses/{COURSE_ID}/quizzes/assignment_overrides"
PER_PAGE = int(os.getenv("PER_PAGE", "100"))

DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")  # required
DISCORD_CHANNEL_ID = int(os.getenv("DISCORD_CHANNEL_ID", "0"))  # required

# Auth: prefer token; else raw cookie string pasted from browser
CANVAS_TOKEN = os.getenv("CANVAS_TOKEN", "").strip()
CANVAS_COOKIE_RAW = os.getenv("COOKIES_JSON", "").strip()

POLL_INTERVAL_SEC = int(os.getenv("INTERVAL_SEC", "30"))  # 15 min default

STATE_DIR = Path(os.getenv("STATE_DIR", ".canvas_state"))
STATE_DIR.mkdir(parents=True, exist_ok=True)
SNAPSHOT_FILE = STATE_DIR / f"quiz_assignment_overrides_{COURSE_ID}.json"
ETAG_FILE = STATE_DIR / f"quiz_assignment_overrides_{COURSE_ID}.etag"

# ====== Helpers ======
def parse_cookie_string(raw: str) -> Dict[str, str]:
    """Convert 'k=v; a=b; ...' into {k:v, a:b}."""
    cookies = {}
    if not raw:
        return cookies
    parts = [p.strip() for p in raw.split(";") if p.strip()]
    for part in parts:
        if "=" in part:
            k, v = part.split("=", 1)
            cookies[k.strip()] = v.strip()
    return cookies

def get_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": "CanvasQuizOverridesDiffBot/1.0"})
    if CANVAS_TOKEN:
        s.headers.update({"Authorization": f"Bearer {CANVAS_TOKEN}"})
    elif CANVAS_COOKIE_RAW:
        for name, val in parse_cookie_string(CANVAS_COOKIE_RAW).items():
            s.cookies.set(name, val, domain="utexas.instructure.com")
    else:
        print("ERROR: set CANVAS_TOKEN or CANVAS_COOKIE_RAW in your environment.", file=sys.stderr)
        sys.exit(1)
    return s

def fetch_all_overrides_sync() -> Tuple[Dict[str, Any], str, bool]:
    """
    Returns (json_obj, etag, not_modified).
    Endpoint usually returns:
    {
      "quiz_assignment_overrides": [
        { "quiz_id": 2076176, "due_dates": [ {...} ] },
        ...
      ]
    }
    """
    s = get_session()
    params = {"per_page": PER_PAGE}

    if ETAG_FILE.exists():
        et = ETAG_FILE.read_text().strip()
        if et:
            s.headers["If-None-Match"] = et

    r = s.get(ENDPOINT, params=params, timeout=30)
    if r.status_code == 304:
        return {}, "", True
    r.raise_for_status()
    etag = r.headers.get("ETag", "")

    data = r.json()
    # Some Canvas endpoints return a top-level list; normalize to object
    if isinstance(data, list):
        data = {"quiz_assignment_overrides": data}

    # pagination (unlikely here, but keep for safety)
    def next_link(resp: requests.Response):
        link = resp.headers.get("link") or resp.headers.get("Link")
        if not link:
            return None
        for part in link.split(","):
            seg, rel = part.split(";")
            if 'rel="next"' in rel:
                return seg.strip()[1:-1]
        return None

    nxt = next_link(r)
    items = data.get("quiz_assignment_overrides", [])
    while nxt:
        rr = s.get(nxt, timeout=30)
        rr.raise_for_status()
        more = rr.json()
        if isinstance(more, dict):
            items.extend(more.get("quiz_assignment_overrides", []))
        elif isinstance(more, list):
            items.extend(more)
        nxt = next_link(rr)

    data["quiz_assignment_overrides"] = items
    return data, etag, False

# ---- Normalization for diffing ----
DUE_KEYS = ("due_at", "unlock_at", "lock_at", "title", "base")

def normalize_due_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only stable fields, fill missing with None, and coerce types (e.g., booleans)."""
    out = {}
    for k in DUE_KEYS:
        v = entry.get(k, None)
        # Canvas may return booleans/strings; keep as-is, null stays None
        out[k] = v
    return out

def sort_key_due(entry: Dict[str, Any]):
    """Sort due entries deterministically."""
    return (
        str(entry.get("title") or ""),
        1 if entry.get("base") else 0,
        str(entry.get("due_at") or ""),
        str(entry.get("unlock_at") or ""),
        str(entry.get("lock_at") or ""),
    )

def normalize_payload_to_index(data: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    """
    Convert API JSON -> { str(quiz_id): [normalized due entries sorted] }
    """
    out: Dict[str, List[Dict[str, Any]]] = {}
    arr = data.get("quiz_assignment_overrides", [])
    for item in arr:
        qid = item.get("quiz_id")
        if qid is None:
            # skip unexpected items without quiz_id
            continue
        due_dates = item.get("due_dates", []) or []
        norm_list = [normalize_due_entry(d) for d in due_dates]
        norm_list.sort(key=sort_key_due)
        out[str(qid)] = norm_list
    return out

# ---- Snapshot I/O ----
def load_snapshot() -> Dict[str, List[Dict[str, Any]]]:
    if not SNAPSHOT_FILE.exists():
        return {}
    try:
        return json.loads(SNAPSHOT_FILE.read_text())
    except Exception:
        return {}

def save_snapshot(idx: Dict[str, List[Dict[str, Any]]]):
    SNAPSHOT_FILE.write_text(json.dumps(idx, indent=2, sort_keys=True))

def save_etag(etag: str):
    if etag:
        ETAG_FILE.write_text(etag)

# ---- Diff logic ----
def list_diff(a: List[Dict[str, Any]], b: List[Dict[str, Any]]) -> List[Tuple[int, Dict[str, Tuple[Any, Any]]]]:
    """
    Compare two sorted lists of due entries element-by-element.
    If lengths differ or any entry differs, return per-index field diffs.
    """
    diffs: List[Tuple[int, Dict[str, Tuple[Any, Any]]]] = []
    maxlen = max(len(a), len(b))
    for i in range(maxlen):
        left = a[i] if i < len(a) else None
        right = b[i] if i < len(b) else None
        if left == right:
            continue
        field_diffs: Dict[str, Tuple[Any, Any]] = {}
        if left is None or right is None:
            # whole entry added/removed
            field_diffs["<entry>"] = (left, right)
        else:
            keys = set(left) | set(right)
            for k in keys:
                if left.get(k) != right.get(k):
                    field_diffs[k] = (left.get(k), right.get(k))
        if field_diffs:
            diffs.append((i, field_diffs))
    return diffs

def compute_changes_quiz(old_idx: Dict[str, List[Dict[str, Any]]],
                         new_idx: Dict[str, List[Dict[str, Any]]]):
    added_quizzes, removed_quizzes, changed_quizzes = [], [], []
    old_ids, new_ids = set(old_idx), set(new_idx)

    for qid in sorted(new_ids - old_ids, key=int):
        added_quizzes.append(qid)
    for qid in sorted(old_ids - new_ids, key=int):
        removed_quizzes.append(qid)
    for qid in sorted(old_ids & new_ids, key=int):
        diffs = list_diff(old_idx[qid], new_idx[qid])
        if diffs:
            changed_quizzes.append((qid, diffs))
    return added_quizzes, removed_quizzes, changed_quizzes

def fmt_dt(x):
    return x or "null"

def render_change_message_quiz(added_qids, removed_qids, changed_qids, course_id) -> str:
    lines: List[str] = []
    if added_qids:
        lines.append("**➕ Quizzes added (new overrides):** " + ", ".join(f"`{q}`" for q in added_qids))
    if removed_qids:
        lines.append("**➖ Quizzes removed (overrides gone):** " + ", ".join(f"`{q}`" for q in removed_qids))
    if changed_qids:
        lines.append("**✏️ Overrides changed:**")
        for qid, diffs in changed_qids:
            lines.append(f"- quiz `{qid}`")
            for idx, fields in diffs:
                pretty = []
                if "<entry>" in fields:
                    ov, nv = fields["<entry>"]
                    pretty.append(f"entry #{idx}: {json.dumps(ov)} → {json.dumps(nv)}")
                else:
                    for k, (ov, nv) in fields.items():
                        # keep it compact
                        if k in ("due_at", "unlock_at", "lock_at"):
                            pretty.append(f"{k}: `{fmt_dt(ov)}` → `{fmt_dt(nv)}`")
                        else:
                            pretty.append(f"{k}: `{ov}` → `{nv}`")
                lines.append("   • " + "; ".join(pretty))
    if not lines:
        return ""
    header = f"@everyone 📣 Canvas changes detected for course `{course_id}` (quiz_assignment_overrides)"
    return header + "\n" + "\n".join(lines)

# ====== DISCORD BOT ======
intents = discord.Intents.none()  # we only send messages
bot = discord.Client(intents=intents)

async def post_message(channel_id: int, content: str):
    channel = bot.get_channel(channel_id)
    if not channel:
        channel = await bot.fetch_channel(channel_id)
    # Discord cap: 2000 chars
    await channel.send(content[:1990])

async def watcher():
    await bot.wait_until_ready()
    if DISCORD_CHANNEL_ID == 0:
        print("Set DISCORD_CHANNEL_ID.", file=sys.stderr)
        await bot.close()
        return
    while not bot.is_closed():
        try:
            data, etag, not_modified = await asyncio.to_thread(fetch_all_overrides_sync)
            if not_modified:
                await post_message(DISCORD_CHANNEL_ID, "Nothing Changed.")
            else:
                new_idx = normalize_payload_to_index(data)
                old_idx = load_snapshot()
                added_q, removed_q, changed_q = compute_changes_quiz(old_idx, new_idx)
                if added_q or removed_q or changed_q:
                    msg = render_change_message_quiz(added_q, removed_q, changed_q, COURSE_ID)
                    if msg:
                        await post_message(DISCORD_CHANNEL_ID, msg)
                    save_snapshot(new_idx)
                save_etag(etag)
        except Exception as e:
            print(f"[watcher] Error: {e}", file=sys.stderr)
        await asyncio.sleep(POLL_INTERVAL_SEC)

@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} (id={bot.user.id})")
    bot.loop.create_task(watcher())

if __name__ == "__main__":
    if not DISCORD_BOT_TOKEN:
        print("Set DISCORD_BOT_TOKEN env var.", file=sys.stderr)
        sys.exit(1)
    bot.run(DISCORD_BOT_TOKEN)
