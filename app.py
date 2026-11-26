import os, re, secrets, sqlite3, time
from collections import defaultdict, deque
from functools import wraps

import numpy as np
from flask import Flask, g, jsonify, redirect, render_template, request, session, url_for
from werkzeug.middleware.proxy_fix import ProxyFix

from face_utils import (CLOSED_RATIO, MATCH_THRESHOLD, POSE_ID_MIN, STRAIGHT_MAX_DEG,
                        TILT_MIN_DEG, YAW_MIN, FaceError, get_engine)

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)  # correct client IP / https behind a host proxy
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY", "dev-only-change-me"),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("SECURE_COOKIES") == "1",
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
)
DB_PATH = os.environ.get("DATABASE_PATH", os.path.join(app.root_path, "instance", "faces.db"))
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")

# ---------- database ----------
def db():
    if "db" not in g:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.executescript("""
            CREATE TABLE IF NOT EXISTS users(
                id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                embedding BLOB NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS notes(
                id INTEGER PRIMARY KEY, username TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS events(
                id INTEGER PRIMARY KEY, username TEXT NOT NULL, kind TEXT NOT NULL,
                success INTEGER NOT NULL, ip TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);""")
    return g.db

@app.teardown_appcontext
def close_db(_):
    d = g.pop("db", None)
    if d: d.close()

def all_users():
    return [(r["username"], np.frombuffer(r["embedding"], dtype=np.float32))
            for r in db().execute("SELECT username, embedding FROM users")]

def log_event(username, kind, success):
    db().execute("INSERT INTO events(username, kind, success, ip) VALUES(?,?,?,?)",
                 (username, kind, int(success), request.remote_addr))
    db().commit()

def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if "user" not in session: return err("Not signed in.", 401)
        return fn(*a, **kw)
    return wrapper

RESCAN_WINDOW = 120  # seconds a fresh face scan stays valid for sensitive actions

# ---------- tiny in-memory rate limiter ----------
_hits = defaultdict(deque)
def limited(key, limit, window=60):
    now, q = time.time(), _hits[key]
    while q and now - q[0] > window: q.popleft()
    if len(q) >= limit: return True
    q.append(now); return False

def err(msg, code=400):
    return jsonify(error=msg), code

# ---------- liveness challenge ----------
# Held in memory (the app runs a single worker). Each token works once and expires after 90s.
CHALLENGES = {}

def run_liveness(engine, data):
    """Check the three poses: straight, turn/tilt, eyes closed. Returns the person's face print."""
    ch = CHALLENGES.pop(data.get("token"), None)
    if not ch or ch["exp"] < time.time():
        raise FaceError("The scan timed out. Start again.")

    def analyze_all(key, limit):
        frames = (data.get(key) or [])[:limit]
        out = []
        for f in frames:
            try:
                out.append(engine.analyze(f))
            except FaceError:
                pass  # a bad frame is fine as long as another one in the set works
        if not out:
            raise FaceError({"straight": "No face found. Face the camera in good light.",
                             "tilt": f"Lost your face while turning {ch['tilt']}. Stay in the frame.",
                             "eyes": "Lost your face when the eyes closed. Stay in frame."}[key])
        return out

    straight, tilt, eyes = analyze_all("straight", 4), analyze_all("tilt", 4), analyze_all("eyes", 4)

    if max(abs(a.roll) for a in straight) > STRAIGHT_MAX_DEG:
        raise FaceError("Keep your head level for the first photo.")

    baseline_yaw = float(np.median([a.yaw for a in straight]))
    baseline_roll = float(np.median([a.roll for a in straight]))
    sign = 1 if ch["tilt"] == "left" else -1

    # Checks if head turned horizontally OR tilted slightly in requested direction
    best_turn = max(tilt, key=lambda a: max(sign * (a.yaw - baseline_yaw) / YAW_MIN,
                                            sign * (a.roll - baseline_roll) / TILT_MIN_DEG))
    rel_yaw = sign * (best_turn.yaw - baseline_yaw)
    rel_roll = sign * (best_turn.roll - baseline_roll)
    if rel_yaw < YAW_MIN and rel_roll < TILT_MIN_DEG:
        raise FaceError(f"Turn your head slightly to the {ch['tilt']}.")

    open_contrast = max(a.contrast for a in straight)
    closed = min(eyes, key=lambda a: a.contrast)
    if open_contrast <= 0 or (closed.contrast / open_contrast) > CLOSED_RATIO:
        raise FaceError("Close your eyes fully and hold still.")

    face_print = engine.average([a.emb for a in straight])
    if engine.similarity(face_print, best_turn.emb) < POSE_ID_MIN or \
       engine.similarity(face_print, closed.emb) < POSE_ID_MIN:
        raise FaceError("The face changed during the scan. Start again.")
    return face_print

# ---------- pages ----------
@app.get("/")
def login_page():
    if "user" in session: return redirect(url_for("dashboard"))
    return render_template("login.html")

@app.get("/register")
def register_page():
    return render_template("register.html")

@app.get("/dashboard")
def dashboard():
    if "user" not in session: return redirect(url_for("login_page"))
    row = db().execute("SELECT created_at FROM users WHERE username=?", (session["user"],)).fetchone()
    if not row:
        session.clear(); return redirect(url_for("login_page"))
    d = db()
    sign_ins = d.execute("SELECT created_at FROM events WHERE username=? AND success=1 AND kind IN ('login','register') "
                         "ORDER BY id DESC LIMIT 2", (session["user"],)).fetchall()
    total = d.execute("SELECT COUNT(*) c FROM events WHERE username=? AND success=1 AND kind IN ('login','register')",
                      (session["user"],)).fetchone()["c"]
    previous = sign_ins[1]["created_at"] if len(sign_ins) > 1 else None
    return render_template("dashboard.html", username=session["user"], created=row["created_at"],
                           previous=previous, total=total)

# ---------- api ----------
@app.post("/api/challenge")
def api_challenge():
    if limited(("chal", request.remote_addr), 30): return err("Too many attempts. Wait a minute.", 429)
    now = time.time()
    for k in [k for k, v in CHALLENGES.items() if v["exp"] < now]:
        del CHALLENGES[k]
    if len(CHALLENGES) > 2000: CHALLENGES.clear()
    token, side = secrets.token_urlsafe(16), secrets.choice(["left", "right"])
    CHALLENGES[token] = {"tilt": side, "exp": now + 90}
    return jsonify(ok=True, token=token, tilt=side)

@app.post("/api/verify_pose")
def api_verify_pose():
    """Live interactive check for each step: straight, turn/rotate head, eyes closed."""
    data = request.get_json(silent=True) or {}
    token = data.get("token")
    step = data.get("step")
    frame = data.get("frame")
    ch = CHALLENGES.get(token)
    if not ch or ch["exp"] < time.time():
        return jsonify(ok=False, error="Session expired. Please restart."), 400
    if not frame or not step:
        return jsonify(ok=False, error="Missing parameters"), 400

    try:
        engine = get_engine()
        analysis = engine.analyze(frame)
    except FaceError as e:
        return jsonify(ok=True, passed=False, reason=str(e))
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

    if step == "straight":
        if abs(analysis.roll) > STRAIGHT_MAX_DEG:
            return jsonify(ok=True, passed=False, roll=analysis.roll, reason="Keep your head level and face the camera")
        return jsonify(ok=True, passed=True, roll=analysis.roll, yaw=analysis.yaw, contrast=analysis.contrast)

    elif step in ("tilt", "turn"):
        baseline_yaw = float(data.get("baseline_yaw", 0.0))
        baseline_roll = float(data.get("baseline_roll", 0.0))
        sign = 1 if ch["tilt"] == "left" else -1
        rel_yaw = sign * (analysis.yaw - baseline_yaw)
        rel_roll = sign * (analysis.roll - baseline_roll)

        # Check if head is rotated horizontally OR tilted slightly in correct direction
        if rel_yaw >= YAW_MIN or rel_roll >= TILT_MIN_DEG:
            return jsonify(ok=True, passed=True, rel_yaw=rel_yaw, rel_roll=rel_roll,
                           yaw=analysis.yaw, roll=analysis.roll)
        if rel_yaw < -0.04 or rel_roll < -3.0:
            return jsonify(ok=True, passed=False,
                           reason=f"Wrong direction! Turn your head to the {ch['tilt']}")
        return jsonify(ok=True, passed=False,
                       reason=f"Turn your head slightly to the {ch['tilt']}")

    elif step == "eyes":
        open_contrast = float(data.get("open_contrast", 30.0))
        ratio = analysis.contrast / open_contrast if open_contrast > 0 else 1.0
        if ratio > CLOSED_RATIO:
            return jsonify(ok=True, passed=False, ratio=ratio, reason="Close your eyes and hold still")
        return jsonify(ok=True, passed=True, ratio=ratio, contrast=analysis.contrast)

    return jsonify(ok=False, error="Unknown step"), 400

@app.post("/api/register")
def api_register():
    if limited(("reg", request.remote_addr), 5): return err("Too many attempts. Wait a minute.", 429)
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    if not USERNAME_RE.match(username):
        return err("Username must be 3-20 letters, numbers or underscores.")
    if db().execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
        return err("That username is taken.", 409)
    try:
        engine = get_engine()
        embedding = run_liveness(engine, data)
    except FaceError as e:
        return err(str(e), 422)
    except RuntimeError as e:
        return err(str(e), 500)
    for _, vec in all_users():
        if engine.similarity(embedding, vec) >= MATCH_THRESHOLD:
            return err("This face is already registered.", 409)
    db().execute("INSERT INTO users(username, embedding) VALUES(?,?)", (username, embedding.tobytes()))
    db().commit()
    session["user"] = username
    log_event(username, "register", True)
    return jsonify(ok=True, redirect=url_for("dashboard"))

@app.post("/api/login")
def api_login():
    if limited(("login", request.remote_addr), 10): return err("Too many attempts. Wait a minute.", 429)
    data = request.get_json(silent=True) or {}
    try:
        engine = get_engine()
        probe = run_liveness(engine, data)
    except FaceError as e:
        return err(str(e), 422)
    except RuntimeError as e:
        return err(str(e), 500)
    best_name, best = None, -1.0
    for name, vec in all_users():
        s = engine.similarity(probe, vec)
        if s > best: best_name, best = name, s
    if best_name is None or best < MATCH_THRESHOLD:
        return err("Face not recognized. Try again or create an account.", 401)
    session["user"] = best_name
    log_event(best_name, "login", True)
    return jsonify(ok=True, redirect=url_for("dashboard"))

@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify(ok=True, redirect=url_for("login_page"))

@app.post("/api/rescan")
@login_required
def api_rescan():
    """Fresh liveness + face check against the signed-in account. Unlocks sensitive actions briefly."""
    if limited(("rescan", request.remote_addr), 10): return err("Too many attempts. Wait a minute.", 429)
    user = session["user"]
    row = db().execute("SELECT embedding FROM users WHERE username=?", (user,)).fetchone()
    if not row:
        session.clear(); return err("Account not found.", 401)
    try:
        engine = get_engine()
        probe = run_liveness(engine, request.get_json(silent=True) or {})
    except FaceError as e:
        return err(str(e), 422)
    except RuntimeError as e:
        return err(str(e), 500)
    if engine.similarity(probe, np.frombuffer(row["embedding"], dtype=np.float32)) < MATCH_THRESHOLD:
        log_event(user, "rescan", False)
        return err("That face doesn't match this account.", 403)
    session["scan_at"] = time.time()
    log_event(user, "rescan", True)
    return jsonify(ok=True)

@app.post("/api/detect_landmarks")
@login_required
def api_detect_landmarks():
    """Real-time landmarks detection for live face accessories overlay."""
    data = request.get_json(silent=True) or {}
    frame = data.get("frame")
    if not frame:
        return jsonify(ok=False, error="No frame provided"), 400
    try:
        engine = get_engine()
        landmarks = engine.detect_landmarks(frame)
        return jsonify(ok=True, landmarks=landmarks)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

@app.post("/api/delete")
@login_required
def api_delete():
    if time.time() - session.get("scan_at", 0) > RESCAN_WINDOW:
        return err("Scan your face again to confirm.", 403)
    user = session["user"]
    for table in ("events", "users"):
        db().execute(f"DELETE FROM {table} WHERE username=?", (user,))
    db().commit()
    session.clear()
    return jsonify(ok=True, redirect=url_for("login_page"))

@app.get("/healthz")
def health():
    return "ok"

if __name__ == "__main__":
    app.run(debug=True, port=5000)
