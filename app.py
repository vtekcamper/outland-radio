import os
import json
import time
import uuid
import random
import threading
import requests
from datetime import datetime
from pathlib import Path
from functools import wraps
from urllib.parse import urlencode
from flask import (
    Flask, render_template, request, jsonify,
    redirect, url_for, session, flash, send_from_directory
)
from werkzeug.utils import secure_filename
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "change-me-in-production")

SPOTIFY_CLIENT_ID     = os.getenv("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET")
SPOTIFY_REDIRECT_URI  = os.getenv("SPOTIFY_REDIRECT_URI")
ADMIN_PASSWORD        = os.getenv("ADMIN_PASSWORD", "outland2024")

# Railway Volume mount path — persiste tra i redeploy
DATA_DIR       = Path(os.getenv("DATA_DIR", "/programmatic-seo"))
TOKEN_FILE     = DATA_DIR / "spotify_tokens.json"
DEVICE_FILE    = DATA_DIR / "device_id.txt"
LAST_PLAY_FILE = DATA_DIR / "last_played.json"
BRANDING_FILE  = DATA_DIR / "branding.json"
JINGLES_DIR    = DATA_DIR / "jingles"
JINGLE_META    = DATA_DIR / "jingles_meta.json"
JINGLE_CFG     = DATA_DIR / "jingle_settings.json"

JINGLE_ALLOWED   = {"mp3", "wav", "ogg", "m4a"}

ANNOUNCE_DIR     = DATA_DIR / "announcements"
ANNOUNCE_META    = DATA_DIR / "announce_meta.json"
ANNOUNCE_ALLOWED = {"mp3", "wav", "ogg", "m4a"}

def _ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    JINGLES_DIR.mkdir(parents=True, exist_ok=True)
    ANNOUNCE_DIR.mkdir(parents=True, exist_ok=True)

_ensure_dirs()

SCOPES = " ".join([
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-read-playback-state",
    "user-modify-playback-state",
    "playlist-read-private",
    "playlist-read-collaborative",
])

# ── Token management ──────────────────────────────────────────────────────

def load_tokens():
    refresh_token_env = os.getenv("SPOTIFY_REFRESH_TOKEN")
    try:
        tokens = json.loads(TOKEN_FILE.read_text())
        if refresh_token_env and not tokens.get("refresh_token"):
            tokens["refresh_token"] = refresh_token_env
        return tokens
    except Exception:
        if refresh_token_env:
            return {"refresh_token": refresh_token_env, "access_token": "", "expires_at": 0}
        return {}

def save_tokens(tokens):
    TOKEN_FILE.write_text(json.dumps(tokens))

def refresh_access_token():
    tokens = load_tokens()
    if not tokens.get("refresh_token"):
        return None
    r = requests.post("https://accounts.spotify.com/api/token", data={
        "grant_type":    "refresh_token",
        "refresh_token": tokens["refresh_token"],
        "client_id":     SPOTIFY_CLIENT_ID,
        "client_secret": SPOTIFY_CLIENT_SECRET,
    })
    if r.status_code != 200:
        return None
    data = r.json()
    tokens["access_token"] = data["access_token"]
    tokens["expires_at"]   = time.time() + data["expires_in"] - 60
    if "refresh_token" in data:
        tokens["refresh_token"] = data["refresh_token"]
    save_tokens(tokens)
    return tokens["access_token"]

def get_access_token():
    tokens = load_tokens()
    if not tokens.get("access_token") and not tokens.get("refresh_token"):
        return None
    if time.time() >= tokens.get("expires_at", 0):
        return refresh_access_token()
    return tokens.get("access_token")

def is_authenticated():
    return bool(get_access_token())

def spotify_api(method, endpoint, **kwargs):
    token = get_access_token()
    if not token:
        return None, 401
    headers = {"Authorization": f"Bearer {token}"}
    r = getattr(requests, method)(
        f"https://api.spotify.com/v1{endpoint}",
        headers=headers,
        **kwargs
    )
    if r.status_code == 204:
        return {}, 204
    try:
        return r.json(), r.status_code
    except Exception:
        return {}, r.status_code

# ── Auth decorators ───────────────────────────────────────────────────────

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("admin"):
            return redirect(url_for("admin_login"))
        return f(*args, **kwargs)
    return decorated

# ── Public routes ─────────────────────────────────────────────────────────

@app.route("/")
def player():
    if not is_authenticated():
        return redirect(url_for("auth"))
    return render_template("player.html", branding=load_branding())

@app.route("/auth")
def auth():
    params = {
        "client_id":     SPOTIFY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri":  SPOTIFY_REDIRECT_URI,
        "scope":         SCOPES,
        "show_dialog":   "false",
    }
    return redirect("https://accounts.spotify.com/authorize?" + urlencode(params))

@app.route("/callback")
def callback():
    code  = request.args.get("code")
    error = request.args.get("error")
    if error:
        return f"Errore Spotify: {error}", 400
    r = requests.post("https://accounts.spotify.com/api/token", data={
        "grant_type":   "authorization_code",
        "code":         code,
        "redirect_uri": SPOTIFY_REDIRECT_URI,
        "client_id":    SPOTIFY_CLIENT_ID,
        "client_secret": SPOTIFY_CLIENT_SECRET,
    })
    if r.status_code != 200:
        return f"Errore nella ricezione del token Spotify: {r.text}", 400
    data = r.json()
    save_tokens({
        "access_token":  data["access_token"],
        "refresh_token": data["refresh_token"],
        "expires_at":    time.time() + data["expires_in"] - 60,
    })
    return redirect(url_for("player"))

# ── API ───────────────────────────────────────────────────────────────────

@app.route("/api/token")
def api_token():
    token = get_access_token()
    if not token:
        return jsonify({"error": "not_authenticated"}), 401
    return jsonify({"access_token": token})

@app.route("/api/now-playing")
def api_now_playing():
    data, status = spotify_api("get", "/me/player/currently-playing")
    if status == 204 or not data:
        return jsonify({"playing": False})
    item    = data.get("item") or {}
    artists = ", ".join(a["name"] for a in item.get("artists", []))
    images  = item.get("album", {}).get("images", [])
    return jsonify({
        "playing":      data.get("is_playing", False),
        "title":        item.get("name", ""),
        "artist":       artists,
        "album":        item.get("album", {}).get("name", ""),
        "image":        images[0]["url"] if images else "",
        "progress_ms":  data.get("progress_ms", 0),
        "duration_ms":  item.get("duration_ms", 0),
    })

@app.route("/api/register-device", methods=["POST"])
def register_device():
    device_id = (request.json or {}).get("device_id", "")
    if not device_id:
        return jsonify({"ok": False})
    DEVICE_FILE.write_text(device_id)
    # Auto-resume last played playlist on the new device
    try:
        last = json.loads(LAST_PLAY_FILE.read_text())
        uri  = last.get("uri")
        if uri:
            import threading
            def _resume():
                time.sleep(1.5)  # wait for SDK to stabilize
                spotify_api("put", f"/me/player/play?device_id={device_id}",
                            json={"context_uri": uri})
            threading.Thread(target=_resume, daemon=True).start()
    except Exception:
        pass
    return jsonify({"ok": True})

def get_device_id():
    try:
        return DEVICE_FILE.read_text().strip()
    except Exception:
        return ""

@app.route("/api/search-playlists")
def search_playlists():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])
    token = get_access_token()
    if not token:
        app.logger.warning("search-playlists: no token")
        return jsonify({"error": "no_token", "message": "Vai su / per autenticarti con Spotify"}), 401
    search_params = {"q": q, "type": "playlist"}
    app.logger.info("Spotify search params: %s", search_params)
    r = requests.get(
        "https://api.spotify.com/v1/search",
        headers={"Authorization": f"Bearer {token}"},
        params=search_params,
    )
    app.logger.info("Spotify search status: %s url: %s", r.status_code, r.url)
    if r.status_code != 200:
        app.logger.warning("Spotify search error: %s", r.text[:500])
        return jsonify([])
    data = r.json()
    items = [p for p in (data or {}).get("playlists", {}).get("items", []) if p]
    app.logger.info("Spotify search items: %d (after filter)", len(items))
    return jsonify([{
        "name":        p.get("name", ""),
        "uri":         p.get("uri", ""),
        "image":       (p.get("images") or [{}])[0].get("url", ""),
        "owner":       p.get("owner", {}).get("display_name", ""),
        "track_count": (p.get("tracks") or {}).get("total", 0),
    } for p in items[:24]])

@app.route("/api/debug/search")
def api_debug_search():
    q = request.args.get("q", "rock")
    token = get_access_token()
    r = requests.get(
        "https://api.spotify.com/v1/search",
        headers={"Authorization": f"Bearer {token}"},
        params={"q": q, "type": "playlist", "limit": 5},
    )
    return jsonify({"status": r.status_code, "raw": r.json()})

@app.route("/api/debug/playlists")
def api_debug_playlists():
    data, status = spotify_api("get", "/me/playlists?limit=50")
    return jsonify({"status": status, "raw": data})

@app.route("/api/playlists")
def api_playlists():
    data, _ = spotify_api("get", "/me/playlists?limit=50")
    if not data:
        return jsonify([])
    items = [p for p in data.get("items", []) if p]
    return jsonify([{
        "id":     p["id"],
        "name":   p["name"],
        "uri":    p["uri"],
        "tracks": p["tracks"]["total"],
        "image":  p["images"][0]["url"] if p.get("images") else "",
    } for p in items])

@app.route("/api/play", methods=["POST"])
@admin_required
def api_play():
    body      = request.json or {}
    uri       = body.get("context_uri")
    device_id = body.get("device_id") or get_device_id()
    qs        = f"?device_id={device_id}" if device_id else ""
    payload   = {"context_uri": uri} if uri else {}
    _, status = spotify_api("put", f"/me/player/play{qs}", json=payload)
    ok = status in (200, 204)
    if ok and uri:
        try:
            LAST_PLAY_FILE.write_text(json.dumps({"uri": uri}))
        except Exception:
            pass
    return jsonify({"ok": ok})

@app.route("/api/pause", methods=["POST"])
@admin_required
def api_pause():
    data, status = spotify_api("put", "/me/player/pause")
    app.logger.info("pause → %s %s", status, data)
    return jsonify({"ok": status in (200, 204)})

@app.route("/api/next", methods=["POST"])
@admin_required
def api_next():
    data, status = spotify_api("post", "/me/player/next")
    app.logger.info("next → %s %s", status, data)
    return jsonify({"ok": status in (200, 204)})

@app.route("/api/prev", methods=["POST"])
@admin_required
def api_prev():
    data, status = spotify_api("post", "/me/player/previous")
    app.logger.info("prev → %s %s", status, data)
    return jsonify({"ok": status in (200, 204)})

@app.route("/api/volume", methods=["POST"])
@admin_required
def api_volume():
    vol = int((request.json or {}).get("volume_percent", 80))
    vol = max(0, min(100, vol))
    _, status = spotify_api("put", f"/me/player/volume?volume_percent={vol}")
    return jsonify({"ok": status in (200, 204)})

@app.route("/api/shuffle", methods=["POST"])
@admin_required
def api_shuffle():
    state = (request.json or {}).get("state", True)
    _, status = spotify_api("put", f"/me/player/shuffle?state={'true' if state else 'false'}")
    return jsonify({"ok": status in (200, 204)})

# ── Branding helpers ─────────────────────────────────────────────────────

BRANDING_DEFAULTS = {
    "store_name":    "OUTLAND RADIO",
    "store_subtitle": "Outland Store · Accessori Camper",
    "primary_color": "#d97706",
    "bg_color":      "#1c2b33",
    "text_color":    "#f0f4f5",
}
LOGO_ALLOWED = {"png", "jpg", "jpeg", "svg", "webp", "gif"}

def _logo_path():
    for ext in LOGO_ALLOWED:
        p = DATA_DIR / f"logo.{ext}"
        if p.exists():
            return p
    return None

def load_branding():
    try:
        b = {**BRANDING_DEFAULTS, **json.loads(BRANDING_FILE.read_text())}
    except Exception:
        b = dict(BRANDING_DEFAULTS)
    b["has_logo"] = _logo_path() is not None
    return b

def save_branding(data):
    BRANDING_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2))

@app.route("/api/branding")
def api_branding():
    return jsonify(load_branding())

@app.route("/api/logo")
def serve_logo():
    p = _logo_path()
    if not p:
        return "", 404
    from flask import send_file
    return send_file(str(p))

@app.route("/admin/branding", methods=["POST"])
@admin_required
def admin_save_branding():
    body = request.json or {}
    b = load_branding()
    for key in BRANDING_DEFAULTS:
        if key in body:
            b[key] = str(body[key])[:200]
    save_branding(b)
    return jsonify({"ok": True})

@app.route("/admin/branding/logo", methods=["POST"])
@admin_required
def upload_logo():
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "Nessun file"}), 400
    f = request.files["file"]
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in LOGO_ALLOWED:
        return jsonify({"ok": False, "error": "Formato non supportato (usa PNG, JPG, SVG, WEBP)"}), 400
    for old in DATA_DIR.glob("logo.*"):
        old.unlink(missing_ok=True)
    f.save(str(DATA_DIR / f"logo.{ext}"))
    return jsonify({"ok": True, "url": f"/api/logo?v={int(time.time())}"})

@app.route("/admin/branding/logo/delete", methods=["POST"])
@admin_required
def delete_logo():
    for old in DATA_DIR.glob("logo.*"):
        old.unlink(missing_ok=True)
    return jsonify({"ok": True})

# ── Scheduler helpers ────────────────────────────────────────────────────

SCHEDULE_FILE = DATA_DIR / "schedule.json"

def load_schedule():
    try:
        return json.loads(SCHEDULE_FILE.read_text())
    except Exception:
        return []

def save_schedule(entries):
    SCHEDULE_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2))

@app.route("/api/schedule")
def api_schedule():
    return jsonify(load_schedule())

@app.route("/admin/schedule", methods=["POST"])
@admin_required
def admin_save_schedule():
    entries = request.json or []
    if not isinstance(entries, list):
        return jsonify({"ok": False}), 400
    save_schedule(entries)
    return jsonify({"ok": True})

# ── Jingle helpers ────────────────────────────────────────────────────────

ROTATION_FILE = DATA_DIR / "jingle_rotation.json"
_rotation_lock = threading.Lock()

JINGLE_DEFAULTS = {"weight": 1, "time_start": None, "time_end": None, "days": []}

ANNOUNCE_DEFAULTS = {
    "duck_volume":    0.3,    # fraction of slider vol during announcement
    "tolerance_sec":  60,     # ± seconds window for specific-time triggers
    "times":          [],     # list of "HH:MM" strings
    "interval_min":   0,      # every N minutes (0 = disabled)
    "interval_start": None,   # "HH:MM" – start of interval window
    "interval_end":   None,   # "HH:MM" – end of interval window
    "days":           [],     # ["mon","tue",...] — empty = all days
    "cooldown_min":   5,      # minimum minutes between plays
}

def load_jingle_meta():
    try:
        raw = json.loads(JINGLE_META.read_text())
    except Exception:
        return []
    return [{**JINGLE_DEFAULTS, **j} for j in raw]

def save_jingle_meta(meta):
    JINGLE_META.write_text(json.dumps(meta, indent=2, ensure_ascii=False))

def load_jingle_cfg():
    defaults = {"enabled": True, "every_n_songs": 3, "every_n_minutes": 0,
                "rotation_mode": "no_repeat", "crossfade_ms": 1500}
    try:
        return {**defaults, **json.loads(JINGLE_CFG.read_text())}
    except Exception:
        return defaults

def save_jingle_cfg(cfg):
    JINGLE_CFG.write_text(json.dumps(cfg, indent=2))

def load_rotation():
    defaults = {"mode": "no_repeat", "seq_index": 0, "played_ids": [], "last_id": None}
    try:
        return {**defaults, **json.loads(ROTATION_FILE.read_text())}
    except Exception:
        return defaults

def save_rotation(rot):
    ROTATION_FILE.write_text(json.dumps(rot, indent=2))

def _jingle_active_now(j):
    if not j.get("enabled", True):
        return False
    now = datetime.now()
    days = j.get("days") or []
    if days:
        day_keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        if day_keys[now.weekday()] not in days:
            return False
    t_start = j.get("time_start")
    t_end   = j.get("time_end")
    if t_start and t_end:
        now_hm = now.strftime("%H:%M")
        if not (t_start <= now_hm <= t_end):
            return False
    return True

def _pick_jingle(active, mode, rot):
    """Select one jingle from `active` using `mode`, mutate and save `rot`."""
    if not active:
        return None

    if mode == "sequential":
        idx = rot.get("seq_index", 0) % len(active)
        rot["seq_index"] = (idx + 1) % len(active)
        chosen = active[idx]

    elif mode == "weighted":
        weights = [max(1, j.get("weight", 1)) for j in active]
        pool = active.copy()
        # Avoid immediate repeat when possible
        last_id = rot.get("last_id")
        if len(pool) > 1 and last_id:
            reduced = [j for j in pool if j["id"] != last_id]
            if reduced:
                pool   = reduced
                weights = [max(1, j.get("weight", 1)) for j in pool]
        chosen = random.choices(pool, weights=weights, k=1)[0]

    elif mode == "no_repeat":
        played = set(rot.get("played_ids", []))
        last_id = rot.get("last_id")
        remaining = [j for j in active if j["id"] not in played]
        if not remaining:
            # Full cycle done — restart, avoid last played
            played = set()
            remaining = active.copy()
        if len(remaining) > 1 and last_id:
            filtered = [j for j in remaining if j["id"] != last_id]
            if filtered:
                remaining = filtered
        chosen = random.choice(remaining)
        played.add(chosen["id"])
        rot["played_ids"] = list(played)

    else:  # random (pure, avoid immediate repeat)
        last_id = rot.get("last_id")
        pool = active if len(active) <= 1 or not last_id else \
               ([j for j in active if j["id"] != last_id] or active)
        chosen = random.choice(pool)

    rot["last_id"] = chosen["id"]
    save_rotation(rot)
    return chosen

# ── Announce helpers ─────────────────────────────────────────────────────

def load_announce_meta():
    try:
        raw = json.loads(ANNOUNCE_META.read_text())
    except Exception:
        return []
    return [{**ANNOUNCE_DEFAULTS, **a} for a in raw]

def save_announce_meta(meta):
    ANNOUNCE_META.write_text(json.dumps(meta, indent=2, ensure_ascii=False))

def _announce_due(ann):
    """Return True if this announcement should be triggered right now."""
    if not ann.get("enabled", True):
        return False
    now = datetime.now()
    # Day-of-week filter
    days = ann.get("days") or []
    if days:
        day_keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        if day_keys[now.weekday()] not in days:
            return False
    # Cooldown guard (client marks played BEFORE playing, so this resets immediately)
    cooldown_min = max(1, ann.get("cooldown_min", 5))
    last_str = ann.get("last_played_at")
    if last_str:
        try:
            elapsed = (now - datetime.fromisoformat(last_str)).total_seconds() / 60
            if elapsed < cooldown_min:
                return False
        except Exception:
            pass
    now_total = now.hour * 60 + now.minute   # minutes since midnight
    tolerance = ann.get("tolerance_sec", 60)
    # Specific times (with ± tolerance window)
    for t in (ann.get("times") or []):
        try:
            h, m = map(int, t.split(":"))
            if abs(now_total - (h * 60 + m)) * 60 <= tolerance:
                return True
        except Exception:
            pass
    # Interval trigger
    interval = ann.get("interval_min", 0)
    if interval > 0:
        i_start = ann.get("interval_start")
        i_end   = ann.get("interval_end")
        now_hm  = now.strftime("%H:%M")
        in_win  = not (i_start and i_end) or (i_start <= now_hm <= i_end)
        if in_win:
            if not last_str:
                return True   # never played → trigger immediately
            try:
                elapsed = (now - datetime.fromisoformat(last_str)).total_seconds() / 60
                if elapsed >= interval:
                    return True
            except Exception:
                return True
    return False

# ── Jingle API ────────────────────────────────────────────────────────────

@app.route("/api/jingles")
def api_jingles():
    return jsonify(load_jingle_meta())

@app.route("/api/jingles/settings")
def api_jingle_settings():
    return jsonify(load_jingle_cfg())

@app.route("/api/jingles/random")
def api_jingle_random():
    cfg = load_jingle_cfg()
    if not cfg.get("enabled", True):
        return jsonify({"url": None})
    meta   = load_jingle_meta()
    active = [j for j in meta if _jingle_active_now(j)]
    if not active:
        return jsonify({"url": None})
    mode = cfg.get("rotation_mode", "no_repeat")
    with _rotation_lock:
        rot    = load_rotation()
        jingle = _pick_jingle(active, mode, rot)
    if not jingle:
        return jsonify({"url": None})
    return jsonify({"url": f"/jingles/files/{jingle['filename']}", "name": jingle["name"]})

@app.route("/jingles/files/<filename>")
def serve_jingle(filename):
    return send_from_directory(str(JINGLES_DIR), filename)

@app.route("/admin/jingles/upload", methods=["POST"])
@admin_required
def upload_jingle():
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "Nessun file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"ok": False, "error": "Nome file mancante"}), 400
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in JINGLE_ALLOWED:
        return jsonify({"ok": False, "error": "Formato non supportato (usa MP3, WAV, OGG)"}), 400
    uid      = uuid.uuid4().hex[:8]
    filename = f"{uid}_{secure_filename(f.filename)}"
    f.save(str(JINGLES_DIR / filename))
    meta = load_jingle_meta()
    name = Path(f.filename).stem.replace("_", " ").replace("-", " ")
    entry = {**JINGLE_DEFAULTS, "id": uid, "filename": filename, "name": name, "enabled": True}
    meta.append(entry)
    save_jingle_meta(meta)
    return jsonify({"ok": True, "id": uid, "name": name})

@app.route("/admin/jingles/<jingle_id>/toggle", methods=["POST"])
@admin_required
def toggle_jingle(jingle_id):
    meta = load_jingle_meta()
    for j in meta:
        if j["id"] == jingle_id:
            j["enabled"] = not j.get("enabled", True)
            break
    save_jingle_meta(meta)
    return jsonify({"ok": True})

@app.route("/admin/jingles/<jingle_id>/rename", methods=["POST"])
@admin_required
def rename_jingle(jingle_id):
    name = (request.json or {}).get("name", "").strip()
    if not name:
        return jsonify({"ok": False}), 400
    meta = load_jingle_meta()
    for j in meta:
        if j["id"] == jingle_id:
            j["name"] = name
            break
    save_jingle_meta(meta)
    return jsonify({"ok": True})

@app.route("/admin/jingles/<jingle_id>/settings", methods=["POST"])
@admin_required
def jingle_per_settings(jingle_id):
    body = request.json or {}
    meta = load_jingle_meta()
    for j in meta:
        if j["id"] == jingle_id:
            if "weight" in body:
                j["weight"] = max(1, min(10, int(body["weight"])))
            if "time_start" in body:
                j["time_start"] = body["time_start"] or None
            if "time_end" in body:
                j["time_end"] = body["time_end"] or None
            if "days" in body:
                j["days"] = [d for d in body["days"]
                             if d in ("mon","tue","wed","thu","fri","sat","sun")]
            break
    save_jingle_meta(meta)
    return jsonify({"ok": True})

@app.route("/admin/jingles/<jingle_id>/delete", methods=["POST"])
@admin_required
def delete_jingle(jingle_id):
    meta = load_jingle_meta()
    target = next((j for j in meta if j["id"] == jingle_id), None)
    if target:
        try:
            (JINGLES_DIR / target["filename"]).unlink(missing_ok=True)
        except Exception:
            pass
        meta = [j for j in meta if j["id"] != jingle_id]
        save_jingle_meta(meta)
    return jsonify({"ok": True})

@app.route("/admin/jingles/settings", methods=["POST"])
@admin_required
def save_jingle_settings():
    body = request.json or {}
    cfg  = load_jingle_cfg()
    cfg["enabled"]         = bool(body.get("enabled", cfg["enabled"]))
    cfg["every_n_songs"]   = max(0, int(body.get("every_n_songs",   cfg["every_n_songs"])))
    cfg["every_n_minutes"] = max(0, int(body.get("every_n_minutes", cfg["every_n_minutes"])))
    new_mode = body.get("rotation_mode")
    if new_mode and new_mode in ("random", "no_repeat", "sequential", "weighted"):
        cfg["rotation_mode"] = new_mode
        with _rotation_lock:
            rot = load_rotation()
            rot["seq_index"]  = 0
            rot["played_ids"] = []
            rot["last_id"]    = None
            save_rotation(rot)
    if "crossfade_ms" in body:
        cfg["crossfade_ms"] = max(0, min(5000, int(body["crossfade_ms"])))
    save_jingle_cfg(cfg)
    return jsonify({"ok": True})

# ── Announce API ─────────────────────────────────────────────────────────

@app.route("/api/announce/pending")
def api_announce_pending():
    """Return the first announcement that should play right now, or {id: null}."""
    meta = load_announce_meta()
    for ann in meta:
        if _announce_due(ann):
            return jsonify({
                "id":          ann["id"],
                "url":         f"/announce/files/{ann['filename']}",
                "name":        ann["name"],
                "duck_volume": ann.get("duck_volume", 0.3),
            })
    return jsonify({"id": None})

@app.route("/api/announce/<ann_id>/played", methods=["POST"])
def api_announce_played(ann_id):
    """Mark an announcement as played now (called by client BEFORE playing)."""
    meta = load_announce_meta()
    for ann in meta:
        if ann["id"] == ann_id:
            ann["last_played_at"] = datetime.now().isoformat()
            break
    save_announce_meta(meta)
    return jsonify({"ok": True})

@app.route("/announce/files/<filename>")
def serve_announce(filename):
    return send_from_directory(str(ANNOUNCE_DIR), filename)

@app.route("/admin/announce/upload", methods=["POST"])
@admin_required
def upload_announce():
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "Nessun file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"ok": False, "error": "Nome file mancante"}), 400
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in ANNOUNCE_ALLOWED:
        return jsonify({"ok": False, "error": "Formato non supportato (usa MP3, WAV, OGG)"}), 400
    uid      = uuid.uuid4().hex[:8]
    filename = f"{uid}_{secure_filename(f.filename)}"
    f.save(str(ANNOUNCE_DIR / filename))
    meta = load_announce_meta()
    name = Path(f.filename).stem.replace("_", " ").replace("-", " ")
    entry = {**ANNOUNCE_DEFAULTS, "id": uid, "filename": filename,
             "name": name, "enabled": True, "last_played_at": None}
    meta.append(entry)
    save_announce_meta(meta)
    return jsonify({"ok": True, "id": uid, "name": name})

@app.route("/admin/announce/<ann_id>/toggle", methods=["POST"])
@admin_required
def toggle_announce(ann_id):
    meta = load_announce_meta()
    for ann in meta:
        if ann["id"] == ann_id:
            ann["enabled"] = not ann.get("enabled", True)
            break
    save_announce_meta(meta)
    return jsonify({"ok": True})

@app.route("/admin/announce/<ann_id>/rename", methods=["POST"])
@admin_required
def rename_announce(ann_id):
    name = (request.json or {}).get("name", "").strip()
    if not name:
        return jsonify({"ok": False}), 400
    meta = load_announce_meta()
    for ann in meta:
        if ann["id"] == ann_id:
            ann["name"] = name
            break
    save_announce_meta(meta)
    return jsonify({"ok": True})

@app.route("/admin/announce/<ann_id>/settings", methods=["POST"])
@admin_required
def announce_settings(ann_id):
    body = request.json or {}
    meta = load_announce_meta()
    for ann in meta:
        if ann["id"] == ann_id:
            if "duck_volume" in body:
                ann["duck_volume"] = max(0.0, min(1.0, float(body["duck_volume"])))
            if "tolerance_sec" in body:
                ann["tolerance_sec"] = max(10, min(600, int(body["tolerance_sec"])))
            if "times" in body:
                ann["times"] = [t for t in body["times"]
                                if isinstance(t, str) and len(t) == 5 and ":" in t]
            if "interval_min" in body:
                ann["interval_min"] = max(0, int(body["interval_min"]))
            if "interval_start" in body:
                ann["interval_start"] = body["interval_start"] or None
            if "interval_end" in body:
                ann["interval_end"] = body["interval_end"] or None
            if "cooldown_min" in body:
                ann["cooldown_min"] = max(1, int(body["cooldown_min"]))
            if "days" in body:
                ann["days"] = [d for d in body["days"]
                               if d in ("mon","tue","wed","thu","fri","sat","sun")]
            break
    save_announce_meta(meta)
    return jsonify({"ok": True})

@app.route("/admin/announce/<ann_id>/delete", methods=["POST"])
@admin_required
def delete_announce(ann_id):
    meta = load_announce_meta()
    target = next((a for a in meta if a["id"] == ann_id), None)
    if target:
        try:
            (ANNOUNCE_DIR / target["filename"]).unlink(missing_ok=True)
        except Exception:
            pass
        meta = [a for a in meta if a["id"] != ann_id]
        save_announce_meta(meta)
    return jsonify({"ok": True})

# ── Admin routes ──────────────────────────────────────────────────────────

@app.route("/admin")
@admin_required
def admin():
    jingles       = load_jingle_meta()
    jingle_cfg    = load_jingle_cfg()
    branding      = load_branding()
    schedule      = load_schedule()
    announcements = load_announce_meta()
    return render_template("admin.html",
                           jingles=jingles, jingle_cfg=jingle_cfg,
                           branding=branding, schedule=schedule,
                           announcements=announcements)

@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if request.method == "POST":
        if request.form.get("password") == ADMIN_PASSWORD:
            session["admin"] = True
            return redirect(url_for("admin"))
        flash("Password errata")
    return render_template("admin_login.html")

@app.route("/admin/logout")
def admin_logout():
    session.pop("admin", None)
    return redirect(url_for("player"))

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(debug=False, host="0.0.0.0", port=port)
