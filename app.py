import os
import json
import time
import uuid
import random
import requests
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
JINGLES_DIR    = DATA_DIR / "jingles"
JINGLE_META    = DATA_DIR / "jingles_meta.json"
JINGLE_CFG     = DATA_DIR / "jingle_settings.json"

JINGLE_ALLOWED = {"mp3", "wav", "ogg", "m4a"}

def _ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    JINGLES_DIR.mkdir(parents=True, exist_ok=True)

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
    return render_template("player.html")

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
    device_id = body.get("device_id", "")
    qs        = f"?device_id={device_id}" if device_id else ""
    payload   = {"context_uri": uri} if uri else {}
    _, status = spotify_api("put", f"/me/player/play{qs}", json=payload)
    return jsonify({"ok": status in (200, 204)})

@app.route("/api/pause", methods=["POST"])
@admin_required
def api_pause():
    _, status = spotify_api("put", "/me/player/pause")
    return jsonify({"ok": status in (200, 204)})

@app.route("/api/next", methods=["POST"])
@admin_required
def api_next():
    _, status = spotify_api("post", "/me/player/next")
    return jsonify({"ok": status in (200, 204)})

@app.route("/api/prev", methods=["POST"])
@admin_required
def api_prev():
    _, status = spotify_api("post", "/me/player/previous")
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

# ── Jingle helpers ────────────────────────────────────────────────────────

def load_jingle_meta():
    try:
        return json.loads(JINGLE_META.read_text())
    except Exception:
        return []

def save_jingle_meta(meta):
    JINGLE_META.write_text(json.dumps(meta, indent=2, ensure_ascii=False))

def load_jingle_cfg():
    defaults = {"enabled": True, "every_n_songs": 3, "every_n_minutes": 0}
    try:
        return {**defaults, **json.loads(JINGLE_CFG.read_text())}
    except Exception:
        return defaults

def save_jingle_cfg(cfg):
    JINGLE_CFG.write_text(json.dumps(cfg, indent=2))

# ── Jingle API ────────────────────────────────────────────────────────────

@app.route("/api/jingles")
def api_jingles():
    return jsonify(load_jingle_meta())

@app.route("/api/jingles/settings")
def api_jingle_settings():
    return jsonify(load_jingle_cfg())

@app.route("/api/jingles/random")
def api_jingle_random():
    meta = [j for j in load_jingle_meta() if j.get("enabled", True)]
    if not meta:
        return jsonify({"url": None})
    jingle = random.choice(meta)
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
    meta.append({"id": uid, "filename": filename, "name": name, "enabled": True})
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
    cfg = load_jingle_cfg()
    cfg["enabled"]         = bool(body.get("enabled", cfg["enabled"]))
    cfg["every_n_songs"]   = max(1, int(body.get("every_n_songs",   cfg["every_n_songs"])))
    cfg["every_n_minutes"] = max(0, int(body.get("every_n_minutes", cfg["every_n_minutes"])))
    save_jingle_cfg(cfg)
    return jsonify({"ok": True})

# ── Admin routes ──────────────────────────────────────────────────────────

@app.route("/admin")
@admin_required
def admin():
    data, _ = spotify_api("get", "/me/playlists?limit=50")
    playlists = [p for p in (data or {}).get("items", []) if p]
    jingles   = load_jingle_meta()
    jingle_cfg = load_jingle_cfg()
    return render_template("admin.html", playlists=playlists,
                           jingles=jingles, jingle_cfg=jingle_cfg)

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
