import hashlib
import json
import os
import re
import tempfile
import time
from copy import deepcopy
from pathlib import Path
from threading import RLock

from flask import Flask, jsonify, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = Path(os.environ.get("WHITEBOARD_DATA_FILE", BASE_DIR / "data" / "rooms.json"))
MAX_EVENTS_PER_ROOM = int(os.environ.get("MAX_EVENTS_PER_ROOM", "30000"))
MAX_IMAGE_DATA_URL = int(os.environ.get("MAX_IMAGE_DATA_URL", "8000000"))  # about 8 MB
MAX_UNDO_DEPTH = int(os.environ.get("MAX_UNDO_DEPTH", "50"))
MAX_ROOM_NAME_LENGTH = 80
MAX_USER_NAME_LENGTH = 30
SAVE_INTERVAL_SECONDS = 1.0

USER_COLORS = [
    "#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2",
    "#be123c", "#4f46e5", "#65a30d", "#c026d3", "#0f766e", "#ca8a04",
]

ALLOWED_EVENT_TYPES = {"draw", "image", "shape"}
ALLOWED_SHAPES = {"line", "rect", "ellipse", "arrow"}

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "whiteboard-v4-dev-secret")

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    max_http_buffer_size=MAX_IMAGE_DATA_URL + 1024 * 1024,
)

state_lock = RLock()
rooms = {}
room_members = {}
user_rooms = {}
room_users = {}
room_active_strokes = {}
_last_save_at = 0.0


def now_ms():
    return int(time.time() * 1000)


def sanitize_room_name(room):
    room = str(room or "").strip()
    if not room:
        room = "default"
    room = re.sub(r"\s+", "-", room)
    room = re.sub(r"[^\w\-\u4e00-\u9fff]", "", room, flags=re.UNICODE)
    return room[:MAX_ROOM_NAME_LENGTH] or "default"


def sanitize_user_name(name):
    name = str(name or "").strip()
    name = re.sub(r"\s+", " ", name)
    name = re.sub(r"[<>]", "", name)
    return name[:MAX_USER_NAME_LENGTH] or "匿名使用者"


def number(value, default=0, min_value=None, max_value=None):
    try:
        value = float(value)
    except (TypeError, ValueError):
        value = default
    if min_value is not None:
        value = max(min_value, value)
    if max_value is not None:
        value = min(max_value, value)
    return value


def text_value(value, limit=5000):
    value = str(value or "")
    return value[:limit]


def hash_password(room, password):
    password = str(password or "")
    if not password:
        return ""
    secret = app.config.get("SECRET_KEY", "")
    material = f"{secret}|{room}|{password}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def color_for_sid(sid):
    digest = hashlib.sha256(str(sid).encode("utf-8")).hexdigest()
    idx = int(digest[:4], 16) % len(USER_COLORS)
    return USER_COLORS[idx]


def room_snapshot(room):
    data = rooms.get(room, make_empty_room())
    return {
        "events": deepcopy(data.get("events", [])),
        "texts": deepcopy(data.get("texts", {})),
    }


def restore_snapshot(room, snapshot):
    room = ensure_room(room)
    rooms[room]["events"] = deepcopy(snapshot.get("events", [])) if isinstance(snapshot.get("events"), list) else []
    rooms[room]["texts"] = deepcopy(snapshot.get("texts", {})) if isinstance(snapshot.get("texts"), dict) else {}
    rooms[room]["updated_at"] = now_ms()


def snapshots_equal(a, b):
    return a.get("events") == b.get("events") and a.get("texts") == b.get("texts")


def save_undo_snapshot(room):
    room = ensure_room(room)
    current = room_snapshot(room)
    stack = rooms[room].setdefault("undo_stack", [])
    if stack and snapshots_equal(stack[-1], current):
        return
    stack.append(current)
    if len(stack) > MAX_UNDO_DEPTH:
        del stack[:-MAX_UNDO_DEPTH]
    rooms[room]["redo_stack"] = []


def make_empty_room():
    ts = now_ms()
    return {
        "events": [],
        "texts": {},
        "password_hash": "",
        "undo_stack": [],
        "redo_stack": [],
        "created_at": ts,
        "updated_at": ts,
    }


def normalize_loaded_event(event):
    if not isinstance(event, dict):
        return None
    event_type = event.get("type")
    if event_type not in ALLOWED_EVENT_TYPES:
        return None
    normalized = {"type": event_type, "room": text_value(event.get("room"), 80), "ts": int(event.get("ts") or now_ms())}
    if event_type == "draw":
        normalized.update({
            "x1": number(event.get("x1"), 0, 0, 4000),
            "y1": number(event.get("y1"), 0, 0, 4000),
            "x2": number(event.get("x2"), 0, 0, 4000),
            "y2": number(event.get("y2"), 0, 0, 4000),
            "color": text_value(event.get("color") or "#000000", 32),
            "size": number(event.get("size"), 5, 1, 120),
            "tool": "eraser" if event.get("tool") == "eraser" else "pen",
            "stroke_id": text_value(event.get("stroke_id"), 120),
            "client_id": text_value(event.get("client_id"), 80),
        })
    elif event_type == "image":
        src = text_value(event.get("src"), MAX_IMAGE_DATA_URL + 1)
        if not src.startswith("data:image/") or len(src) > MAX_IMAGE_DATA_URL:
            return None
        normalized.update({
            "id": text_value(event.get("id") or f"img-{now_ms()}", 120),
            "src": src,
            "x": number(event.get("x"), 50, -2000, 4000),
            "y": number(event.get("y"), 50, -2000, 4000),
            "w": number(event.get("w"), 320, 10, 4000),
            "h": number(event.get("h"), 240, 10, 4000),
            "client_id": text_value(event.get("client_id"), 80),
        })
    elif event_type == "shape":
        shape = event.get("shape") if event.get("shape") in ALLOWED_SHAPES else "line"
        normalized.update({
            "id": text_value(event.get("id") or f"shape-{now_ms()}", 120),
            "shape": shape,
            "x1": number(event.get("x1"), 0, 0, 4000),
            "y1": number(event.get("y1"), 0, 0, 4000),
            "x2": number(event.get("x2"), 0, 0, 4000),
            "y2": number(event.get("y2"), 0, 0, 4000),
            "color": text_value(event.get("color") or "#000000", 32),
            "size": number(event.get("size"), 5, 1, 120),
            "client_id": text_value(event.get("client_id"), 80),
        })
    return normalized


def normalize_text_object(text_obj):
    if not isinstance(text_obj, dict):
        return None
    text_id = text_value(text_obj.get("id"), 120)
    if not text_id:
        return None
    return {
        "id": text_id,
        "room": text_value(text_obj.get("room"), 80),
        "kind": "sticky" if text_obj.get("kind") == "sticky" else "text",
        "x": number(text_obj.get("x"), 100, -2000, 4000),
        "y": number(text_obj.get("y"), 100, -2000, 4000),
        "w": number(text_obj.get("w"), 220, 40, 4000),
        "h": number(text_obj.get("h"), 80, 24, 4000),
        "text": text_value(text_obj.get("text") or "雙擊輸入文字", 5000),
        "color": text_value(text_obj.get("color") or "#111111", 32),
        "fontSize": int(number(text_obj.get("fontSize"), 22, 8, 96)),
        "client_id": text_value(text_obj.get("client_id"), 80),
        "updated_at": int(text_obj.get("updated_at") or now_ms()),
    }


def normalize_loaded_room(room_data):
    room_data = room_data if isinstance(room_data, dict) else {}
    normalized = make_empty_room()
    loaded_events = room_data.get("events", []) if isinstance(room_data.get("events"), list) else []
    normalized["events"] = [event for event in (normalize_loaded_event(e) for e in loaded_events) if event]
    loaded_texts = room_data.get("texts", {}) if isinstance(room_data.get("texts"), dict) else {}
    texts = {}
    for key, value in loaded_texts.items():
        obj = normalize_text_object(value)
        if obj:
            texts[obj["id"]] = obj
    normalized["texts"] = texts
    normalized["password_hash"] = text_value(room_data.get("password_hash", ""), 128)
    normalized["created_at"] = int(room_data.get("created_at", normalized["created_at"]) or normalized["created_at"])
    normalized["updated_at"] = int(room_data.get("updated_at", normalized["updated_at"]) or normalized["updated_at"])
    return normalized


def load_rooms():
    if not DATA_FILE.exists():
        return {}
    try:
        with DATA_FILE.open("r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        return {}

    source_rooms = payload.get("rooms", payload) if isinstance(payload, dict) else {}
    if not isinstance(source_rooms, dict):
        return {}

    loaded = {}
    for name, data in source_rooms.items():
        loaded[sanitize_room_name(name)] = normalize_loaded_room(data)
    return loaded


def serializable_rooms():
    clean = {}
    for room, data in rooms.items():
        clean[room] = {
            "events": data.get("events", []),
            "texts": data.get("texts", {}),
            "password_hash": data.get("password_hash", ""),
            "created_at": data.get("created_at", now_ms()),
            "updated_at": data.get("updated_at", now_ms()),
        }
    return clean


def persist_rooms(force=False):
    global _last_save_at
    current = time.time()
    if not force and current - _last_save_at < SAVE_INTERVAL_SECONDS:
        return False

    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 4,
        "saved_at": now_ms(),
        "rooms": serializable_rooms(),
    }
    fd, tmp_name = tempfile.mkstemp(prefix="rooms-", suffix=".json", dir=str(DATA_FILE.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp_name, DATA_FILE)
    _last_save_at = current
    return True


def ensure_room(room):
    room = sanitize_room_name(room)
    if room not in rooms:
        rooms[room] = make_empty_room()
    if room not in room_members:
        room_members[room] = set()
    if room not in room_active_strokes:
        room_active_strokes[room] = set()
    rooms[room].setdefault("undo_stack", [])
    rooms[room].setdefault("redo_stack", [])
    return room


def public_users(room):
    users = []
    for sid in sorted(room_members.get(room, set())):
        meta = room_users.get(sid)
        if not meta:
            continue
        users.append({
            "id": sid,
            "name": meta.get("name", "匿名使用者"),
            "color": meta.get("color", "#2563eb"),
        })
    return users


def public_state(room):
    room = ensure_room(room)
    snapshot = room_snapshot(room)
    snapshot["room"] = room
    snapshot["user_count"] = len(room_members.get(room, set()))
    snapshot["users"] = public_users(room)
    snapshot["password_required"] = bool(rooms[room].get("password_hash"))
    snapshot["can_undo"] = bool(rooms[room].get("undo_stack"))
    snapshot["can_redo"] = bool(rooms[room].get("redo_stack"))
    snapshot["version"] = 4
    return snapshot


def emit_room_presence(room):
    payload = {
        "room": room,
        "count": len(room_members.get(room, set())),
        "users": public_users(room),
    }
    socketio.emit("room_count", payload, to=room)
    socketio.emit("users_update", payload, to=room)


def emit_save_status(room, saved=False):
    socketio.emit(
        "save_status",
        {
            "room": room,
            "saved": saved,
            "saved_at": rooms.get(room, {}).get("updated_at", now_ms()),
            "can_undo": bool(rooms.get(room, {}).get("undo_stack")),
            "can_redo": bool(rooms.get(room, {}).get("redo_stack")),
        },
        to=room,
    )


def broadcast_room_state(room, message=None):
    state = public_state(room)
    if message:
        state["message"] = message
    socketio.emit("room_state", state, to=room)
    emit_save_status(room, saved=True)


def delete_room_if_empty(room):
    """最後一位使用者離開後，刪除該房間所有白板資料，避免記憶體與儲存檔案持續累積。"""
    members = room_members.get(room)
    if members and len(members) > 0:
        return False

    rooms.pop(room, None)
    room_members.pop(room, None)
    room_active_strokes.pop(room, None)
    persist_rooms(force=True)
    return True


def leave_current_room(sid):
    old_room = user_rooms.pop(sid, None)
    if not old_room:
        room_users.pop(sid, None)
        return

    try:
        leave_room(old_room, sid=sid)
    except TypeError:
        leave_room(old_room)

    members = room_members.get(old_room)
    if members is not None:
        members.discard(sid)

    room_users.pop(sid, None)

    if old_room in room_members and len(room_members[old_room]) > 0:
        socketio.emit("cursor_remove", {"room": old_room, "user_id": sid}, to=old_room)
        emit_room_presence(old_room)
    else:
        delete_room_if_empty(old_room)


def add_event(room, event, snapshot=True):
    room = ensure_room(room)
    if snapshot:
        save_undo_snapshot(room)
    event["room"] = room
    event["ts"] = int(event.get("ts") or now_ms())
    rooms[room]["events"].append(event)
    if len(rooms[room]["events"]) > MAX_EVENTS_PER_ROOM:
        rooms[room]["events"] = rooms[room]["events"][-MAX_EVENTS_PER_ROOM:]
    rooms[room]["updated_at"] = now_ms()
    saved = persist_rooms()
    emit_save_status(room, saved=saved)


def validate_import_snapshot(snapshot):
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    events = snapshot.get("events", []) if isinstance(snapshot.get("events"), list) else []
    texts = snapshot.get("texts", {}) if isinstance(snapshot.get("texts"), dict) else {}
    clean_events = []
    for event in events[:MAX_EVENTS_PER_ROOM]:
        normalized = normalize_loaded_event(event)
        if normalized:
            clean_events.append(normalized)
    clean_texts = {}
    for value in texts.values():
        normalized = normalize_text_object(value)
        if normalized:
            clean_texts[normalized["id"]] = normalized
    return {"events": clean_events, "texts": clean_texts}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True, "rooms": len(rooms), "version": 4})


@app.route("/api/rooms/<room>/snapshot")
def room_snapshot_route(room):
    room = sanitize_room_name(room)
    with state_lock:
        return jsonify(public_state(room))


@socketio.on("connect")
def handle_connect():
    emit("connected", {"sid": request.sid, "server_time": now_ms(), "version": 4})


@socketio.on("join_room")
def handle_join(data):
    data = data or {}
    sid = request.sid
    room = sanitize_room_name(data.get("room"))
    user_name = sanitize_user_name(data.get("user_name"))
    password = text_value(data.get("password"), 256)

    with state_lock:
        if user_rooms.get(sid) == room:
            room_users[sid] = {
                "name": user_name,
                "color": room_users.get(sid, {}).get("color") or color_for_sid(sid),
            }
            emit("room_state", public_state(room))
            emit_room_presence(room)
            return

        if sid in user_rooms:
            leave_current_room(sid)

        room = ensure_room(room)
        existing_hash = rooms[room].get("password_hash", "")
        submitted_hash = hash_password(room, password)

        if existing_hash and existing_hash != submitted_hash:
            emit("join_error", {"message": "房間密碼錯誤，請重新輸入。", "room": room})
            return

        if not existing_hash and password:
            rooms[room]["password_hash"] = submitted_hash
            rooms[room]["updated_at"] = now_ms()
            persist_rooms(force=True)

        join_room(room)
        room_members[room].add(sid)
        user_rooms[sid] = room
        room_users[sid] = {
            "name": user_name,
            "color": color_for_sid(sid),
        }
        state = public_state(room)

    emit("room_state", state)
    emit_room_presence(room)


@socketio.on("cursor_move")
def handle_cursor_move(data):
    data = data or {}
    sid = request.sid
    room = user_rooms.get(sid)
    if not room:
        return
    meta = room_users.get(sid, {"name": "匿名使用者", "color": color_for_sid(sid)})
    payload = {
        "room": room,
        "user_id": sid,
        "name": meta.get("name", "匿名使用者"),
        "color": meta.get("color", "#2563eb"),
        "x": number(data.get("x"), 0, -1000, 5000),
        "y": number(data.get("y"), 0, -1000, 5000),
    }
    emit("cursor_move", payload, to=room, include_self=False)


@socketio.on("cursor_leave")
def handle_cursor_leave(data):
    sid = request.sid
    room = user_rooms.get(sid)
    if room:
        emit("cursor_remove", {"room": room, "user_id": sid}, to=room, include_self=False)


@socketio.on("draw_event")
def handle_draw(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    stroke_id = text_value(data.get("stroke_id") or f"stroke-{now_ms()}", 120)
    event = {
        "type": "draw",
        "x1": number(data.get("x1"), 0, 0, 4000),
        "y1": number(data.get("y1"), 0, 0, 4000),
        "x2": number(data.get("x2"), 0, 0, 4000),
        "y2": number(data.get("y2"), 0, 0, 4000),
        "color": text_value(data.get("color") or "#000000", 32),
        "size": number(data.get("size"), 5, 1, 120),
        "tool": "eraser" if data.get("tool") == "eraser" else "pen",
        "stroke_id": stroke_id,
        "client_id": text_value(data.get("client_id"), 80),
    }
    with state_lock:
        room = ensure_room(room)
        active = room_active_strokes.setdefault(room, set())
        should_snapshot = stroke_id not in active
        if should_snapshot:
            active.add(stroke_id)
        add_event(room, event, snapshot=should_snapshot)
    emit("draw_event", event, to=room)


@socketio.on("stroke_end")
def handle_stroke_end(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    stroke_id = text_value(data.get("stroke_id"), 120)
    with state_lock:
        room_active_strokes.setdefault(room, set()).discard(stroke_id)


@socketio.on("shape_add")
def handle_shape_add(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    shape = data.get("shape") if data.get("shape") in ALLOWED_SHAPES else "line"
    event = {
        "type": "shape",
        "id": text_value(data.get("id") or f"shape-{now_ms()}", 120),
        "shape": shape,
        "x1": number(data.get("x1"), 0, 0, 4000),
        "y1": number(data.get("y1"), 0, 0, 4000),
        "x2": number(data.get("x2"), 0, 0, 4000),
        "y2": number(data.get("y2"), 0, 0, 4000),
        "color": text_value(data.get("color") or "#000000", 32),
        "size": number(data.get("size"), 5, 1, 120),
        "client_id": text_value(data.get("client_id"), 80),
    }
    with state_lock:
        add_event(room, event, snapshot=True)
    emit("shape_add", event, to=room)


@socketio.on("image_add")
def handle_image_add(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    src = text_value(data.get("src"), MAX_IMAGE_DATA_URL + 1)
    if not src.startswith("data:image/") or len(src) > MAX_IMAGE_DATA_URL:
        emit("error_message", {"message": "圖片過大或格式不支援，請改用較小的 PNG/JPG。"})
        return

    event = {
        "type": "image",
        "id": text_value(data.get("id") or f"img-{now_ms()}", 120),
        "src": src,
        "x": number(data.get("x"), 50, -2000, 4000),
        "y": number(data.get("y"), 50, -2000, 4000),
        "w": number(data.get("w"), 320, 10, 4000),
        "h": number(data.get("h"), 240, 10, 4000),
        "client_id": text_value(data.get("client_id"), 80),
    }
    with state_lock:
        add_event(room, event, snapshot=True)
    emit("image_add", event, to=room)


@socketio.on("image_update")
def handle_image_update(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    image_id = text_value(data.get("id"), 120)
    if not image_id:
        return

    with state_lock:
        room = ensure_room(room)
        target = None
        for event in rooms[room]["events"]:
            if event.get("type") == "image" and event.get("id") == image_id:
                target = event
                break
        if not target:
            return

        save_undo_snapshot(room)
        if "x" in data:
            target["x"] = number(data.get("x"), target.get("x", 50), -2000, 4000)
        if "y" in data:
            target["y"] = number(data.get("y"), target.get("y", 50), -2000, 4000)
        if "w" in data:
            target["w"] = number(data.get("w"), target.get("w", 320), 10, 4000)
        if "h" in data:
            target["h"] = number(data.get("h"), target.get("h", 240), 10, 4000)
        target["updated_at"] = now_ms()
        rooms[room]["updated_at"] = now_ms()
        saved = persist_rooms()
        emit_save_status(room, saved=saved)
        payload = deepcopy(target)

    emit("image_update", payload, to=room)


@socketio.on("image_delete")
def handle_image_delete(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    image_id = text_value(data.get("id"), 120)
    if not image_id:
        return

    with state_lock:
        room = ensure_room(room)
        exists = any(event.get("type") == "image" and event.get("id") == image_id for event in rooms[room]["events"])
        if not exists:
            return
        save_undo_snapshot(room)
        rooms[room]["events"] = [
            event for event in rooms[room]["events"]
            if not (event.get("type") == "image" and event.get("id") == image_id)
        ]
        rooms[room]["updated_at"] = now_ms()
        saved = persist_rooms(force=True)
        emit_save_status(room, saved=saved)

    emit("image_delete", {"room": room, "id": image_id}, to=room)


@socketio.on("text_add")
def handle_text_add(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    text_id = text_value(data.get("id") or f"txt-{now_ms()}", 120)
    text_obj = {
        "id": text_id,
        "room": room,
        "kind": "sticky" if data.get("kind") == "sticky" else "text",
        "x": number(data.get("x"), 100, -2000, 4000),
        "y": number(data.get("y"), 100, -2000, 4000),
        "w": number(data.get("w"), 220, 40, 4000),
        "h": number(data.get("h"), 80, 24, 4000),
        "text": text_value(data.get("text") or ("便利貼" if data.get("kind") == "sticky" else "雙擊輸入文字"), 5000),
        "color": text_value(data.get("color") or "#111111", 32),
        "fontSize": int(number(data.get("fontSize"), 22, 8, 96)),
        "client_id": text_value(data.get("client_id"), 80),
        "updated_at": now_ms(),
    }
    with state_lock:
        room = ensure_room(room)
        save_undo_snapshot(room)
        rooms[room]["texts"][text_id] = text_obj
        rooms[room]["updated_at"] = now_ms()
        saved = persist_rooms()
        emit_save_status(room, saved=saved)
    emit("text_add", text_obj, to=room)


@socketio.on("text_update")
def handle_text_update(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    text_id = text_value(data.get("id"), 120)
    with state_lock:
        room = ensure_room(room)
        current = rooms[room]["texts"].get(text_id)
        if not current:
            return
        save_undo_snapshot(room)
        allowed = {
            "x": lambda v: number(v, current.get("x", 0), -2000, 4000),
            "y": lambda v: number(v, current.get("y", 0), -2000, 4000),
            "w": lambda v: number(v, current.get("w", 220), 40, 4000),
            "h": lambda v: number(v, current.get("h", 80), 24, 4000),
            "text": lambda v: text_value(v, 5000),
            "color": lambda v: text_value(v, 32),
            "fontSize": lambda v: int(number(v, current.get("fontSize", 22), 8, 96)),
            "kind": lambda v: "sticky" if v == "sticky" else "text",
        }
        for key, caster in allowed.items():
            if key in data:
                current[key] = caster(data[key])
        current["updated_at"] = now_ms()
        rooms[room]["updated_at"] = now_ms()
        saved = persist_rooms()
        emit_save_status(room, saved=saved)
        payload = deepcopy(current)
    emit("text_update", payload, to=room)


@socketio.on("text_delete")
def handle_text_delete(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    text_id = text_value(data.get("id"), 120)
    with state_lock:
        if room in rooms and text_id in rooms[room]["texts"]:
            save_undo_snapshot(room)
            rooms[room]["texts"].pop(text_id, None)
            rooms[room]["updated_at"] = now_ms()
            saved = persist_rooms(force=True)
            emit_save_status(room, saved=saved)
    emit("text_delete", {"room": room, "id": text_id}, to=room)


@socketio.on("clear")
def handle_clear(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    with state_lock:
        room = ensure_room(room)
        save_undo_snapshot(room)
        rooms[room]["events"] = []
        rooms[room]["texts"] = {}
        rooms[room]["updated_at"] = now_ms()
        saved = persist_rooms(force=True)
        emit_save_status(room, saved=saved)
    emit("clear", {"room": room}, to=room)


@socketio.on("undo")
def handle_undo(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    with state_lock:
        room = ensure_room(room)
        undo_stack = rooms[room].setdefault("undo_stack", [])
        if not undo_stack:
            emit("error_message", {"message": "目前沒有可以復原的動作。"})
            return
        rooms[room].setdefault("redo_stack", []).append(room_snapshot(room))
        if len(rooms[room]["redo_stack"]) > MAX_UNDO_DEPTH:
            del rooms[room]["redo_stack"][:-MAX_UNDO_DEPTH]
        restore_snapshot(room, undo_stack.pop())
        persist_rooms(force=True)
        state = public_state(room)
    socketio.emit("room_state", state, to=room)


@socketio.on("redo")
def handle_redo(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    with state_lock:
        room = ensure_room(room)
        redo_stack = rooms[room].setdefault("redo_stack", [])
        if not redo_stack:
            emit("error_message", {"message": "目前沒有可以重做的動作。"})
            return
        rooms[room].setdefault("undo_stack", []).append(room_snapshot(room))
        if len(rooms[room]["undo_stack"]) > MAX_UNDO_DEPTH:
            del rooms[room]["undo_stack"][:-MAX_UNDO_DEPTH]
        restore_snapshot(room, redo_stack.pop())
        persist_rooms(force=True)
        state = public_state(room)
    socketio.emit("room_state", state, to=room)


@socketio.on("room_import")
def handle_room_import(data):
    data = data or {}
    room = sanitize_room_name(data.get("room") or user_rooms.get(request.sid))
    try:
        snapshot = validate_import_snapshot(data.get("snapshot"))
    except Exception:
        emit("error_message", {"message": "匯入檔案格式錯誤。"})
        return
    with state_lock:
        room = ensure_room(room)
        save_undo_snapshot(room)
        restore_snapshot(room, snapshot)
        persist_rooms(force=True)
        state = public_state(room)
    socketio.emit("room_state", state, to=room)


@socketio.on("leave_room")
def handle_leave(data):
    sid = request.sid
    with state_lock:
        leave_current_room(sid)


@socketio.on("disconnect")
def handle_disconnect():
    sid = request.sid
    with state_lock:
        leave_current_room(sid)


with state_lock:
    rooms.update(load_rooms())

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    socketio.run(app, host="0.0.0.0", port=port, debug=debug)
