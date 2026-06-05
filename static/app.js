const socket = io({
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 700,
});

const els = {
    joinPage: document.getElementById("joinPage"),
    whiteboardPage: document.getElementById("whiteboardPage"),
    userNameInput: document.getElementById("userNameInput"),
    joinRoomInput: document.getElementById("joinRoomInput"),
    roomPasswordInput: document.getElementById("roomPasswordInput"),
    joinBtn: document.getElementById("joinBtn"),
    randomRoomBtn: document.getElementById("randomRoomBtn"),
    currentRoom: document.getElementById("currentRoom"),
    currentUser: document.getElementById("currentUser"),
    roomCount: document.getElementById("roomCount"),
    saveStatus: document.getElementById("saveStatus"),
    shareBtn: document.getElementById("shareBtn"),
    leaveBtn: document.getElementById("leaveBtn"),
    selectBtn: document.getElementById("selectBtn"),
    penBtn: document.getElementById("penBtn"),
    eraserBtn: document.getElementById("eraserBtn"),
    textBtn: document.getElementById("textBtn"),
    stickyBtn: document.getElementById("stickyBtn"),
    imageBtn: document.getElementById("imageBtn"),
    imageInput: document.getElementById("imageInput"),
    lineBtn: document.getElementById("lineBtn"),
    rectBtn: document.getElementById("rectBtn"),
    ellipseBtn: document.getElementById("ellipseBtn"),
    arrowBtn: document.getElementById("arrowBtn"),
    undoBtn: document.getElementById("undoBtn"),
    redoBtn: document.getElementById("redoBtn"),
    clearBtn: document.getElementById("clearBtn"),
    downloadPngBtn: document.getElementById("downloadPngBtn"),
    downloadJpgBtn: document.getElementById("downloadJpgBtn"),
    exportJsonBtn: document.getElementById("exportJsonBtn"),
    importJsonBtn: document.getElementById("importJsonBtn"),
    importJsonInput: document.getElementById("importJsonInput"),
    gridBtn: document.getElementById("gridBtn"),
    colorPicker: document.getElementById("colorPicker"),
    brushSize: document.getElementById("brushSize"),
    brushSizeLabel: document.getElementById("brushSizeLabel"),
    fontSize: document.getElementById("fontSize"),
    fontSizeLabel: document.getElementById("fontSizeLabel"),
    toolHint: document.getElementById("toolHint"),
    canvas: document.getElementById("canvas"),
    previewCanvas: document.getElementById("previewCanvas"),
    textLayer: document.getElementById("textLayer"),
    cursorLayer: document.getElementById("cursorLayer"),
    userList: document.getElementById("userList"),
    boardWrap: document.getElementById("boardWrap"),
    toast: document.getElementById("toast"),
};

const ctx = els.canvas.getContext("2d");
const previewCtx = els.previewCanvas.getContext("2d");
const CLIENT_ID = uniqueId("client");

let room = "";
let userName = "";
let tool = "pen";
let currentColor = "#111111";
let currentSize = 5;
let currentFontSize = 22;
let drawing = false;
let lastPoint = null;
let activeStrokeId = null;
let shapeStart = null;
let replaying = false;
let currentEvents = [];
let canUndo = false;
let canRedo = false;

const textBoxes = new Map();
const remoteCursors = new Map();

function uniqueId(prefix = "id") {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeRoom(roomName) {
    return String(roomName || "")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^\w\-\u4e00-\u9fff]/g, "")
        .slice(0, 80) || "default";
}

function sanitizeUserName(name) {
    return String(name || "")
        .trim()
        .replace(/\s+/g, " ")
        .replace(/[<>]/g, "")
        .slice(0, 30) || "匿名使用者";
}

function initCanvas() {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
}

function showToast(message, ms = 2400) {
    els.toast.textContent = message;
    els.toast.classList.remove("hidden");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.add("hidden"), ms);
}

function randomRoomName() {
    return `room-${Math.random().toString(36).slice(2, 8)}`;
}

function getRoomFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return sanitizeRoom(params.get("room") || "");
}

function updateUrlRoom(roomName) {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomName);
    window.history.replaceState({}, "", url.toString());
}

function getShareUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", room);
    return url.toString();
}

function joinRoom(roomName) {
    const cleanRoom = sanitizeRoom(roomName);
    if (!cleanRoom) {
        showToast("請輸入房間名稱");
        return;
    }

    userName = sanitizeUserName(els.userNameInput.value);
    room = cleanRoom;
    updateUrlRoom(room);
    localStorage.setItem("whiteboard:lastRoom", room);
    localStorage.setItem("whiteboard:userName", userName);

    socket.emit("join_room", {
        room,
        user_name: userName,
        password: els.roomPasswordInput.value || "",
    });
    els.currentRoom.textContent = room;
    els.currentUser.textContent = userName;
    els.saveStatus.textContent = "正在加入房間...";
}

function leaveRoom() {
    if (room) {
        socket.emit("cursor_leave", { room });
        socket.emit("leave_room", { room });
    }
    room = "";
    localStorage.removeItem("whiteboard:lastRoom");
    els.joinRoomInput.value = "";
    els.roomPasswordInput.value = "";
    els.roomCount.textContent = "0";
    els.userList.innerHTML = "";
    clearRemoteCursors();
    clearLocalBoard();
    currentEvents = [];
    updateUndoRedoButtons(false, false);
    els.whiteboardPage.classList.add("hidden");
    els.joinPage.classList.remove("hidden");
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState({}, "", url.toString());
}

function clearLocalBoard() {
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
    initCanvas();
    textBoxes.clear();
    els.textLayer.innerHTML = "";
}

function allToolButtons() {
    return [
        els.selectBtn, els.penBtn, els.eraserBtn, els.textBtn, els.stickyBtn,
        els.lineBtn, els.rectBtn, els.ellipseBtn, els.arrowBtn,
    ];
}

function isShapeTool(value = tool) {
    return ["shape-line", "shape-rect", "shape-ellipse", "shape-arrow"].includes(value);
}

function setTool(nextTool) {
    tool = nextTool;
    allToolButtons().forEach(btn => btn.classList.remove("active"));
    els.boardWrap.classList.remove("select-mode", "draw-mode", "eraser-mode", "text-mode", "shape-mode");
    previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);

    if (tool === "select") {
        els.selectBtn.classList.add("active");
        els.toolHint.textContent = "目前工具：滑鼠 / 選取，可拖曳或編輯文字框，不會在畫布上畫線";
        els.canvas.style.cursor = "default";
        els.boardWrap.classList.add("select-mode");
    } else if (tool === "pen") {
        els.penBtn.classList.add("active");
        els.toolHint.textContent = "目前工具：畫筆";
        els.canvas.style.cursor = "crosshair";
        els.boardWrap.classList.add("draw-mode");
    } else if (tool === "eraser") {
        els.eraserBtn.classList.add("active");
        els.toolHint.textContent = "目前工具：橡皮擦";
        els.canvas.style.cursor = "cell";
        els.boardWrap.classList.add("eraser-mode");
    } else if (tool === "text") {
        els.textBtn.classList.add("active");
        els.toolHint.textContent = "目前工具：文字框，點一下畫布新增文字";
        els.canvas.style.cursor = "text";
        els.boardWrap.classList.add("text-mode");
    } else if (tool === "sticky") {
        els.stickyBtn.classList.add("active");
        els.toolHint.textContent = "目前工具：便利貼，點一下畫布新增貼紙式文字";
        els.canvas.style.cursor = "text";
        els.boardWrap.classList.add("text-mode");
    } else if (isShapeTool()) {
        const map = {
            "shape-line": [els.lineBtn, "直線"],
            "shape-rect": [els.rectBtn, "矩形"],
            "shape-ellipse": [els.ellipseBtn, "圓形"],
            "shape-arrow": [els.arrowBtn, "箭頭"],
        };
        const [btn, label] = map[tool];
        btn.classList.add("active");
        els.toolHint.textContent = `目前工具：${label}，拖曳即可繪製並同步給其他人`;
        els.canvas.style.cursor = "crosshair";
        els.boardWrap.classList.add("shape-mode");
    }
}

function setColor(color) {
    currentColor = color;
    els.colorPicker.value = color;
    document.querySelectorAll(".color-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.color.toLowerCase() === color.toLowerCase());
    });
}

function getCanvasPoint(event) {
    const rect = els.canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * (els.canvas.width / rect.width),
        y: (event.clientY - rect.top) * (els.canvas.height / rect.height),
    };
}

function canvasToPercentX(x) {
    return `${(x / els.canvas.width) * 100}%`;
}

function canvasToPercentY(y) {
    return `${(y / els.canvas.height) * 100}%`;
}

function drawLine(event, targetCtx = ctx) {
    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.moveTo(event.x1, event.y1);
    targetCtx.lineTo(event.x2, event.y2);
    targetCtx.strokeStyle = event.tool === "eraser" ? "#ffffff" : event.color;
    targetCtx.lineWidth = event.tool === "eraser" ? Math.max(event.size, 18) : event.size;
    targetCtx.lineCap = "round";
    targetCtx.lineJoin = "round";
    targetCtx.stroke();
    targetCtx.restore();
}

function drawArrow(targetCtx, x1, y1, x2, y2, color, size) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLength = Math.max(14, size * 4);
    targetCtx.beginPath();
    targetCtx.moveTo(x1, y1);
    targetCtx.lineTo(x2, y2);
    targetCtx.stroke();
    targetCtx.beginPath();
    targetCtx.moveTo(x2, y2);
    targetCtx.lineTo(x2 - headLength * Math.cos(angle - Math.PI / 6), y2 - headLength * Math.sin(angle - Math.PI / 6));
    targetCtx.moveTo(x2, y2);
    targetCtx.lineTo(x2 - headLength * Math.cos(angle + Math.PI / 6), y2 - headLength * Math.sin(angle + Math.PI / 6));
    targetCtx.stroke();
}

function drawShape(event, targetCtx = ctx) {
    const x1 = Number(event.x1 || 0);
    const y1 = Number(event.y1 || 0);
    const x2 = Number(event.x2 || 0);
    const y2 = Number(event.y2 || 0);
    const w = x2 - x1;
    const h = y2 - y1;
    targetCtx.save();
    targetCtx.strokeStyle = event.color || currentColor;
    targetCtx.lineWidth = Number(event.size || currentSize);
    targetCtx.lineCap = "round";
    targetCtx.lineJoin = "round";
    if (event.preview) {
        targetCtx.setLineDash([8, 6]);
    }
    if (event.shape === "rect") {
        targetCtx.strokeRect(x1, y1, w, h);
    } else if (event.shape === "ellipse") {
        targetCtx.beginPath();
        targetCtx.ellipse(x1 + w / 2, y1 + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
        targetCtx.stroke();
    } else if (event.shape === "arrow") {
        drawArrow(targetCtx, x1, y1, x2, y2, event.color || currentColor, Number(event.size || currentSize));
    } else {
        targetCtx.beginPath();
        targetCtx.moveTo(x1, y1);
        targetCtx.lineTo(x2, y2);
        targetCtx.stroke();
    }
    targetCtx.restore();
}

function emitDraw(point) {
    if (!lastPoint || !room) return;
    const event = {
        room,
        type: "draw",
        x1: lastPoint.x,
        y1: lastPoint.y,
        x2: point.x,
        y2: point.y,
        color: currentColor,
        size: currentSize,
        tool,
        stroke_id: activeStrokeId,
        client_id: CLIENT_ID,
    };
    socket.emit("draw_event", event);
    lastPoint = point;
    els.saveStatus.textContent = "儲存中...";
}

function addImageToCanvas(event, targetCtx = ctx) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            targetCtx.drawImage(img, event.x, event.y, event.w, event.h);
            resolve();
        };
        img.onerror = () => {
            showToast("有一張圖片載入失敗");
            resolve();
        };
        img.src = event.src;
    });
}

function addImageFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        showToast("目前支援 PNG、JPG、WEBP 圖片");
        return;
    }
    if (file.size > 7.5 * 1024 * 1024) {
        showToast("圖片太大，請壓縮到 7.5MB 以下再上傳");
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        const src = reader.result;
        const img = new Image();
        img.onload = () => {
            const maxW = 420;
            const ratio = Math.min(1, maxW / img.naturalWidth);
            const w = Math.max(80, img.naturalWidth * ratio);
            const h = Math.max(60, img.naturalHeight * ratio);
            const event = {
                room,
                type: "image",
                id: uniqueId("img"),
                src,
                x: Math.max(20, (els.canvas.width - w) / 2),
                y: Math.max(20, (els.canvas.height - h) / 2),
                w,
                h,
                client_id: CLIENT_ID,
            };
            socket.emit("image_add", event);
            els.saveStatus.textContent = "儲存中...";
        };
        img.src = src;
    };
    reader.readAsDataURL(file);
}

function defaultTextObject(point, kind = "text") {
    const sticky = kind === "sticky";
    return {
        room,
        id: uniqueId(sticky ? "sticky" : "txt"),
        kind,
        x: Math.min(point.x, els.canvas.width - (sticky ? 220 : 240)),
        y: Math.min(point.y, els.canvas.height - (sticky ? 150 : 120)),
        w: sticky ? 220 : 240,
        h: sticky ? 140 : 92,
        text: sticky ? "便利貼\n可記錄想法" : "雙擊輸入文字",
        color: sticky ? "#111111" : currentColor,
        fontSize: sticky ? Math.max(18, currentFontSize) : currentFontSize,
        client_id: CLIENT_ID,
    };
}

function applyTextPosition(el, data) {
    el.style.left = canvasToPercentX(data.x);
    el.style.top = canvasToPercentY(data.y);
    el.style.width = canvasToPercentX(data.w);
    el.style.height = canvasToPercentY(data.h);
}

function emitTextUpdate(id, patch) {
    if (!room || replaying) return;
    socket.emit("text_update", { room, id, ...patch });
    els.saveStatus.textContent = "儲存中...";
}

function debounce(fn, delay = 250) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function createTextBox(data, focus = false) {
    const existing = textBoxes.get(data.id);
    if (existing) {
        updateTextBox(data);
        return existing.element;
    }

    const box = document.createElement("div");
    box.className = data.kind === "sticky" ? "text-box sticky-note" : "text-box";
    box.dataset.id = data.id;

    const toolbar = document.createElement("div");
    toolbar.className = "text-box-toolbar";

    const dragHandle = document.createElement("span");
    dragHandle.className = "drag-handle";
    dragHandle.textContent = data.kind === "sticky" ? "☰ 便利貼" : "⋮⋮ 移動";

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-text-btn";
    deleteBtn.type = "button";
    deleteBtn.title = "刪除";
    deleteBtn.textContent = "×";

    const content = document.createElement("div");
    content.className = "text-content";
    content.contentEditable = "true";
    content.spellcheck = false;
    content.textContent = data.text || "";
    content.style.color = data.color || currentColor;
    content.style.fontSize = `${data.fontSize || currentFontSize}px`;

    const resizer = document.createElement("div");
    resizer.className = "text-resizer";

    toolbar.appendChild(dragHandle);
    toolbar.appendChild(deleteBtn);
    box.appendChild(toolbar);
    box.appendChild(content);
    box.appendChild(resizer);
    els.textLayer.appendChild(box);

    const normalized = {
        ...data,
        kind: data.kind === "sticky" ? "sticky" : "text",
        x: Number(data.x),
        y: Number(data.y),
        w: Number(data.w),
        h: Number(data.h),
        fontSize: Number(data.fontSize || currentFontSize),
    };
    textBoxes.set(data.id, { element: box, content, data: normalized });
    applyTextPosition(box, normalized);

    const debouncedTextUpdate = debounce(() => {
        const item = textBoxes.get(data.id);
        if (!item) return;
        item.data.text = content.innerText;
        emitTextUpdate(data.id, {
            text: item.data.text,
            color: item.data.color || currentColor,
            kind: item.data.kind,
        });
    }, 400);

    content.addEventListener("input", debouncedTextUpdate);
    deleteBtn.addEventListener("click", () => socket.emit("text_delete", { room, id: data.id }));
    dragHandle.addEventListener("pointerdown", event => startDragText(event, data.id));
    resizer.addEventListener("pointerdown", event => startResizeText(event, data.id));

    if (focus) {
        setTimeout(() => {
            content.focus();
            document.execCommand("selectAll", false, null);
        }, 50);
    }

    return box;
}

function updateTextBox(data) {
    const item = textBoxes.get(data.id);
    if (!item) return;
    item.data = { ...item.data, ...data };
    item.element.classList.toggle("sticky-note", item.data.kind === "sticky");
    applyTextPosition(item.element, item.data);
    if (typeof data.text === "string" && item.content.innerText !== data.text) item.content.textContent = data.text;
    if (data.color) item.content.style.color = data.color;
    if (data.fontSize) item.content.style.fontSize = `${data.fontSize}px`;
}

function deleteTextBox(id) {
    const item = textBoxes.get(id);
    if (!item) return;
    item.element.remove();
    textBoxes.delete(id);
}

function startDragText(event, id) {
    event.preventDefault();
    event.stopPropagation();
    const item = textBoxes.get(id);
    if (!item) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = { ...item.data };
    const rect = els.canvas.getBoundingClientRect();
    const onMove = moveEvent => {
        const dx = (moveEvent.clientX - startX) * (els.canvas.width / rect.width);
        const dy = (moveEvent.clientY - startY) * (els.canvas.height / rect.height);
        item.data.x = Math.max(0, Math.min(els.canvas.width - item.data.w, initial.x + dx));
        item.data.y = Math.max(0, Math.min(els.canvas.height - item.data.h, initial.y + dy));
        applyTextPosition(item.element, item.data);
    };
    const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        emitTextUpdate(id, { x: item.data.x, y: item.data.y });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
}

function startResizeText(event, id) {
    event.preventDefault();
    event.stopPropagation();
    const item = textBoxes.get(id);
    if (!item) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = { ...item.data };
    const rect = els.canvas.getBoundingClientRect();
    const onMove = moveEvent => {
        const dw = (moveEvent.clientX - startX) * (els.canvas.width / rect.width);
        const dh = (moveEvent.clientY - startY) * (els.canvas.height / rect.height);
        item.data.w = Math.max(80, Math.min(els.canvas.width - item.data.x, initial.w + dw));
        item.data.h = Math.max(48, Math.min(els.canvas.height - item.data.y, initial.h + dh));
        applyTextPosition(item.element, item.data);
    };
    const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        emitTextUpdate(id, { w: item.data.w, h: item.data.h });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
}

function renderUsers(users = []) {
    els.userList.innerHTML = "";
    users.forEach(user => {
        const chip = document.createElement("span");
        chip.className = "user-chip";
        const dot = document.createElement("span");
        dot.className = "user-dot";
        dot.style.background = user.color || "#2563eb";
        const label = document.createElement("span");
        label.textContent = user.name || "匿名使用者";
        chip.appendChild(dot);
        chip.appendChild(label);
        els.userList.appendChild(chip);
    });
}

function clearRemoteCursors() {
    remoteCursors.clear();
    els.cursorLayer.innerHTML = "";
}

function removeRemoteCursor(userId) {
    const item = remoteCursors.get(userId);
    if (item) item.remove();
    remoteCursors.delete(userId);
}

function updateRemoteCursor(data) {
    if (!data || !data.user_id || data.room !== room) return;
    let cursor = remoteCursors.get(data.user_id);
    if (!cursor) {
        cursor = document.createElement("div");
        cursor.className = "remote-cursor";
        cursor.innerHTML = `<div class="remote-cursor-pointer"></div><div class="remote-cursor-label"></div>`;
        els.cursorLayer.appendChild(cursor);
        remoteCursors.set(data.user_id, cursor);
    }
    cursor.style.left = `${(Number(data.x || 0) / els.canvas.width) * 100}%`;
    cursor.style.top = `${(Number(data.y || 0) / els.canvas.height) * 100}%`;
    cursor.style.setProperty("--cursor-color", data.color || "#2563eb");
    cursor.querySelector(".remote-cursor-label").textContent = data.name || "使用者";
}

function throttle(fn, delay = 40) {
    let last = 0;
    let timer = null;
    return (...args) => {
        const current = Date.now();
        if (current - last >= delay) {
            last = current;
            fn(...args);
        } else {
            clearTimeout(timer);
            timer = setTimeout(() => {
                last = Date.now();
                fn(...args);
            }, delay - (current - last));
        }
    };
}

const emitCursorMove = throttle(event => {
    if (!room) return;
    const rect = els.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (els.canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (els.canvas.height / rect.height);
    if (x < 0 || y < 0 || x > els.canvas.width || y > els.canvas.height) return;
    socket.emit("cursor_move", { room, x, y });
}, 45);

async function replayState(state) {
    replaying = true;
    clearLocalBoard();
    currentEvents = Array.isArray(state.events) ? state.events : [];
    for (const event of currentEvents) {
        if (event.type === "draw") drawLine(event);
        if (event.type === "image") await addImageToCanvas(event);
        if (event.type === "shape") drawShape(event);
    }
    const texts = state.texts || {};
    Object.values(texts).forEach(text => createTextBox(text, false));
    updateUndoRedoButtons(Boolean(state.can_undo), Boolean(state.can_redo));
    replaying = false;
}

function wrapText(ctx2d, text, x, y, maxWidth, lineHeight) {
    const rawLines = String(text || "").split(/\n/);
    const lines = [];
    rawLines.forEach(rawLine => {
        const chars = Array.from(rawLine);
        let line = "";
        chars.forEach(char => {
            const test = line + char;
            if (ctx2d.measureText(test).width > maxWidth && line) {
                lines.push(line);
                line = char;
            } else {
                line = test;
            }
        });
        lines.push(line);
    });
    lines.forEach((line, index) => ctx2d.fillText(line, x, y + index * lineHeight));
}

function drawTextBoxesForExport(targetCtx) {
    textBoxes.forEach(item => {
        const data = item.data;
        const text = item.content.innerText;
        targetCtx.save();
        if (data.kind === "sticky") {
            targetCtx.fillStyle = "#fff3a3";
            targetCtx.strokeStyle = "rgba(180, 140, 0, 0.65)";
            targetCtx.fillRect(data.x, data.y, data.w, data.h);
            targetCtx.strokeRect(data.x, data.y, data.w, data.h);
        } else {
            targetCtx.fillStyle = "rgba(255,255,255,0.72)";
            targetCtx.fillRect(data.x, data.y, data.w, data.h);
            targetCtx.strokeStyle = "rgba(37,99,235,0.45)";
            targetCtx.setLineDash([6, 4]);
            targetCtx.strokeRect(data.x, data.y, data.w, data.h);
            targetCtx.setLineDash([]);
        }
        targetCtx.fillStyle = data.color || currentColor;
        targetCtx.font = `${data.fontSize || currentFontSize}px sans-serif`;
        targetCtx.textBaseline = "top";
        wrapText(targetCtx, text, data.x + 12, data.y + 12, data.w - 24, (data.fontSize || currentFontSize) * 1.35);
        targetCtx.restore();
    });
}

function exportBoard(type = "png") {
    const out = document.createElement("canvas");
    out.width = els.canvas.width;
    out.height = els.canvas.height;
    const outCtx = out.getContext("2d");
    outCtx.fillStyle = "#ffffff";
    outCtx.fillRect(0, 0, out.width, out.height);
    outCtx.drawImage(els.canvas, 0, 0);
    drawTextBoxesForExport(outCtx);
    const link = document.createElement("a");
    link.download = `${room || "whiteboard"}.${type}`;
    link.href = type === "jpg" ? out.toDataURL("image/jpeg", 0.96) : out.toDataURL("image/png");
    link.click();
}

function getTextSnapshot() {
    const result = {};
    textBoxes.forEach((item, id) => {
        result[id] = { ...item.data, text: item.content.innerText };
    });
    return result;
}

function exportJson() {
    const payload = {
        app: "whiteboard-v4",
        exported_at: new Date().toISOString(),
        room,
        snapshot: {
            events: currentEvents,
            texts: getTextSnapshot(),
        },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.download = `${room || "whiteboard"}-snapshot.json`;
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
}

function importJsonFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const parsed = JSON.parse(reader.result);
            const snapshot = parsed.snapshot || parsed;
            if (!snapshot || !Array.isArray(snapshot.events) || typeof snapshot.texts !== "object") {
                showToast("JSON 格式不正確，必須包含 events 與 texts。", 3000);
                return;
            }
            const ok = confirm("確定要匯入這份白板資料嗎？目前房間內容會被覆蓋，且會同步給同房間所有人。");
            if (!ok) return;
            socket.emit("room_import", { room, snapshot });
            els.saveStatus.textContent = "匯入中...";
        } catch (err) {
            showToast("JSON 讀取失敗，請確認檔案格式。", 3000);
        }
    };
    reader.readAsText(file, "utf-8");
}

function clearBoardRemote() {
    if (!room) return;
    const ok = confirm("確定要清除這個房間的畫筆、圖片、形狀與文字框嗎？此動作會同步給同房間所有人，可用 Undo 復原。 再次確認？");
    if (!ok) return;
    socket.emit("clear", { room });
    els.saveStatus.textContent = "儲存中...";
}

function copyShareLink() {
    const url = getShareUrl();
    navigator.clipboard?.writeText(url)
        .then(() => showToast("已複製分享連結"))
        .catch(() => prompt("請手動複製分享連結", url));
}

function updateUndoRedoButtons(nextCanUndo = canUndo, nextCanRedo = canRedo) {
    canUndo = nextCanUndo;
    canRedo = nextCanRedo;
    els.undoBtn.disabled = !canUndo;
    els.redoBtn.disabled = !canRedo;
    els.undoBtn.classList.toggle("disabled", !canUndo);
    els.redoBtn.classList.toggle("disabled", !canRedo);
}

function requestUndo() {
    if (!room) return;
    socket.emit("undo", { room });
}

function requestRedo() {
    if (!room) return;
    socket.emit("redo", { room });
}

function drawShapePreview(point) {
    if (!shapeStart || !isShapeTool()) return;
    previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
    const shape = tool.replace("shape-", "");
    drawShape({
        type: "shape",
        shape,
        x1: shapeStart.x,
        y1: shapeStart.y,
        x2: point.x,
        y2: point.y,
        color: currentColor,
        size: currentSize,
        preview: true,
    }, previewCtx);
}

function emitShape(point) {
    if (!shapeStart || !room) return;
    const dx = Math.abs(point.x - shapeStart.x);
    const dy = Math.abs(point.y - shapeStart.y);
    if (dx < 4 && dy < 4) {
        previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
        return;
    }
    const event = {
        room,
        type: "shape",
        id: uniqueId("shape"),
        shape: tool.replace("shape-", ""),
        x1: shapeStart.x,
        y1: shapeStart.y,
        x2: point.x,
        y2: point.y,
        color: currentColor,
        size: currentSize,
        client_id: CLIENT_ID,
    };
    socket.emit("shape_add", event);
    els.saveStatus.textContent = "儲存中...";
    previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
}

els.joinBtn.addEventListener("click", () => joinRoom(els.joinRoomInput.value));
[els.userNameInput, els.joinRoomInput, els.roomPasswordInput].forEach(input => {
    input.addEventListener("keydown", event => {
        if (event.key === "Enter") joinRoom(els.joinRoomInput.value);
    });
});
els.randomRoomBtn.addEventListener("click", () => {
    els.joinRoomInput.value = randomRoomName();
    els.joinRoomInput.focus();
});

els.leaveBtn.addEventListener("click", leaveRoom);
els.shareBtn.addEventListener("click", copyShareLink);
els.selectBtn.addEventListener("click", () => setTool("select"));
els.penBtn.addEventListener("click", () => setTool("pen"));
els.eraserBtn.addEventListener("click", () => setTool("eraser"));
els.textBtn.addEventListener("click", () => setTool("text"));
els.stickyBtn.addEventListener("click", () => setTool("sticky"));
els.lineBtn.addEventListener("click", () => setTool("shape-line"));
els.rectBtn.addEventListener("click", () => setTool("shape-rect"));
els.ellipseBtn.addEventListener("click", () => setTool("shape-ellipse"));
els.arrowBtn.addEventListener("click", () => setTool("shape-arrow"));
els.undoBtn.addEventListener("click", requestUndo);
els.redoBtn.addEventListener("click", requestRedo);
els.imageBtn.addEventListener("click", () => els.imageInput.click());
els.imageInput.addEventListener("change", event => {
    addImageFile(event.target.files[0]);
    event.target.value = "";
});
els.clearBtn.addEventListener("click", clearBoardRemote);
els.downloadPngBtn.addEventListener("click", () => exportBoard("png"));
els.downloadJpgBtn.addEventListener("click", () => exportBoard("jpg"));
els.exportJsonBtn.addEventListener("click", exportJson);
els.importJsonBtn.addEventListener("click", () => els.importJsonInput.click());
els.importJsonInput.addEventListener("change", event => {
    importJsonFile(event.target.files[0]);
    event.target.value = "";
});
els.gridBtn.addEventListener("click", () => {
    els.boardWrap.classList.toggle("grid-on");
    els.gridBtn.classList.toggle("active", els.boardWrap.classList.contains("grid-on"));
});

els.boardWrap.addEventListener("pointermove", emitCursorMove);
els.boardWrap.addEventListener("pointerleave", () => {
    if (room) socket.emit("cursor_leave", { room });
});

window.addEventListener("keydown", event => {
    if (event.target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        requestUndo();
        return;
    }
    if ((event.ctrlKey || event.metaKey) && (key === "y" || (event.shiftKey && key === "z"))) {
        event.preventDefault();
        requestRedo();
        return;
    }
    if (key === "v" || key === "escape") setTool("select");
    if (key === "p") setTool("pen");
    if (key === "e") setTool("eraser");
    if (key === "t") setTool("text");
    if (key === "n") setTool("sticky");
    if (key === "l") setTool("shape-line");
    if (key === "r") setTool("shape-rect");
    if (key === "o") setTool("shape-ellipse");
    if (key === "a") setTool("shape-arrow");
});

els.colorPicker.addEventListener("input", event => setColor(event.target.value));
document.querySelectorAll(".color-btn").forEach(btn => btn.addEventListener("click", () => setColor(btn.dataset.color)));

els.brushSize.addEventListener("input", event => {
    currentSize = Number(event.target.value);
    els.brushSizeLabel.textContent = `${currentSize} px`;
});
els.fontSize.addEventListener("input", event => {
    currentFontSize = Number(event.target.value);
    els.fontSizeLabel.textContent = `${currentFontSize} px`;
});

els.canvas.addEventListener("pointerdown", event => {
    if (!room) return;
    const point = getCanvasPoint(event);
    if (tool === "text" || tool === "sticky") {
        const textObj = defaultTextObject(point, tool === "sticky" ? "sticky" : "text");
        socket.emit("text_add", textObj);
        els.saveStatus.textContent = "儲存中...";
        return;
    }
    if (tool === "select") {
        drawing = false;
        lastPoint = null;
        shapeStart = null;
        return;
    }
    if (isShapeTool()) {
        shapeStart = point;
        drawing = true;
        els.canvas.setPointerCapture?.(event.pointerId);
        return;
    }
    drawing = true;
    lastPoint = point;
    activeStrokeId = uniqueId("stroke");
    els.canvas.setPointerCapture?.(event.pointerId);
});

els.canvas.addEventListener("pointermove", event => {
    if (!drawing) return;
    event.preventDefault();
    const point = getCanvasPoint(event);
    if (tool === "pen" || tool === "eraser") emitDraw(point);
    if (isShapeTool()) drawShapePreview(point);
});

function stopDrawing(event) {
    if (isShapeTool() && shapeStart) {
        emitShape(getCanvasPoint(event));
    }
    if (activeStrokeId) {
        socket.emit("stroke_end", { room, stroke_id: activeStrokeId });
    }
    drawing = false;
    lastPoint = null;
    activeStrokeId = null;
    shapeStart = null;
    previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
    try { els.canvas.releasePointerCapture?.(event.pointerId); } catch (_) {}
}

els.canvas.addEventListener("pointerup", stopDrawing);
els.canvas.addEventListener("pointercancel", stopDrawing);
els.canvas.addEventListener("pointerleave", event => {
    if (drawing && isShapeTool() && shapeStart) {
        previewCtx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
    }
    if (activeStrokeId) socket.emit("stroke_end", { room, stroke_id: activeStrokeId });
    drawing = false;
    lastPoint = null;
    activeStrokeId = null;
    shapeStart = null;
});

socket.on("connected", data => {
    els.saveStatus.textContent = data?.version ? `已連線 v${data.version}` : "已連線";
});
socket.on("connect_error", () => { els.saveStatus.textContent = "連線失敗，正在重試"; });
socket.on("disconnect", () => { els.saveStatus.textContent = "已離線，等待重連"; });

socket.on("room_state", async data => {
    if (!data || data.room !== room) return;
    els.currentRoom.textContent = room;
    els.currentUser.textContent = userName || sanitizeUserName(els.userNameInput.value);
    els.joinPage.classList.add("hidden");
    els.whiteboardPage.classList.remove("hidden");
    await replayState(data);
    clearRemoteCursors();
    els.roomCount.textContent = data.user_count ?? "1";
    renderUsers(data.users || []);
    els.saveStatus.textContent = data.message || "已載入同步內容";
});

socket.on("room_count", data => {
    if (!data || data.room !== room) return;
    els.roomCount.textContent = data.count;
    if (Array.isArray(data.users)) renderUsers(data.users);
});
socket.on("users_update", data => {
    if (!data || data.room !== room) return;
    els.roomCount.textContent = data.count;
    renderUsers(data.users || []);
});
socket.on("save_status", data => {
    if (!data || data.room !== room) return;
    const time = new Date(data.saved_at || Date.now()).toLocaleTimeString("zh-TW", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    els.saveStatus.textContent = data.saved ? `已自動儲存 ${time}` : `已同步 ${time}`;
    if (typeof data.can_undo === "boolean" || typeof data.can_redo === "boolean") {
        updateUndoRedoButtons(Boolean(data.can_undo), Boolean(data.can_redo));
    }
});

socket.on("draw_event", data => {
    if (!data || data.room !== room) return;
    currentEvents.push(data);
    drawLine(data);
});
socket.on("shape_add", data => {
    if (!data || data.room !== room) return;
    currentEvents.push(data);
    drawShape(data);
});
socket.on("image_add", async data => {
    if (!data || data.room !== room) return;
    currentEvents.push(data);
    await addImageToCanvas(data);
});
socket.on("text_add", data => {
    if (!data || data.room !== room) return;
    createTextBox(data, data.client_id === CLIENT_ID);
});
socket.on("text_update", data => {
    if (!data || data.room !== room) return;
    updateTextBox(data);
});
socket.on("text_delete", data => {
    if (!data || data.room !== room) return;
    deleteTextBox(data.id);
});
socket.on("clear", data => {
    if (!data || data.room !== room) return;
    clearLocalBoard();
    currentEvents = [];
    showToast("畫布已清除，可用 Undo 復原");
});
socket.on("cursor_move", data => updateRemoteCursor(data));
socket.on("cursor_remove", data => {
    if (!data || data.room !== room) return;
    removeRemoteCursor(data.user_id);
});
socket.on("join_error", data => {
    showToast(data?.message || "加入房間失敗");
    els.saveStatus.textContent = "加入失敗";
    room = "";
    els.whiteboardPage.classList.add("hidden");
    els.joinPage.classList.remove("hidden");
});
socket.on("error_message", data => showToast(data?.message || "發生錯誤"));

window.addEventListener("resize", () => textBoxes.forEach(item => applyTextPosition(item.element, item.data)));

initCanvas();
setTool("pen");
setColor(currentColor);
updateUndoRedoButtons(false, false);

const savedUserName = localStorage.getItem("whiteboard:userName");
if (savedUserName) els.userNameInput.value = savedUserName;
const urlRoom = getRoomFromUrl();
const lastRoom = localStorage.getItem("whiteboard:lastRoom");
if (urlRoom) {
    els.joinRoomInput.value = urlRoom;
    showToast("已帶入分享房號，輸入名稱與密碼後即可加入");
} else if (lastRoom) {
    els.joinRoomInput.value = lastRoom;
}
