# 協作白板 v3 專題完整版


## 這版一定會看得到的差異

如果部署成功，首頁會直接出現三個輸入欄位：

```text
你的名稱
房間名稱
房間密碼
```

白板頁面也會顯示：

```text
你：使用者名稱
在線使用者清單
對方滑鼠游標與名稱
v3 密碼協作版
```

如果你看到的還是舊版只有「房間名稱」一個欄位，代表 GitHub 沒有更新到 `templates/index.html`、`static/app.js`、`static/style.css`，或 Render 還沒有重新部署。

這是一個以 Flask + Flask-SocketIO 製作的多人即時協作白板，已拆成正式專案結構，可直接放到 GitHub 並部署到 Render。

## 功能

- 多房間協作
- 即時同步畫筆筆跡
- 橡皮擦
- 滑鼠 / 選取工具：避免誤畫，可操作文字框
- 顏色選擇
- 筆刷粗細調整
- PNG 下載
- JPG 下載
- 圖片上傳同步
- PPT 式文字框同步
- 房間分享連結
- 房間人數顯示
- 自動儲存房間內容
- 最後一位使用者離開後自動刪除房間資料，避免記憶體累積
- GitHub 協作流程
- Render 部署設定

## 專案結構

```text
whiteboard-v2/
├─ server.py
├─ requirements.txt
├─ Procfile
├─ runtime.txt
├─ render.yaml
├─ .gitignore
├─ .env.example
├─ README.md
├─ data/
│  └─ .gitkeep
├─ templates/
│  └─ index.html
└─ static/
   ├─ app.js
   └─ style.css
└─ RENDER_DEPLOY_GUIDE.md
```

## 本機執行

### 1. 建立虛擬環境

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\activate
```

macOS / Linux：

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 2. 安裝套件

```bash
pip install -r requirements.txt
```

### 3. 啟動伺服器

```bash
python server.py
```

打開：

```text
http://127.0.0.1:5001
```

同一台電腦可以開兩個瀏覽器分頁，輸入同一個房間名稱，即可測試即時同步。

## 使用方式

1. 輸入房間名稱。
2. 按下「進入房間」。
3. 同組成員輸入相同房間名稱，或使用「複製分享連結」加入同一房間。
4. 可使用滑鼠 / 選取、畫筆、橡皮擦、圖片上傳與文字框。
5. PNG / JPG 下載會把畫筆、圖片與文字框一起輸出。

### 滑鼠 / 選取工具

工具列新增「🖱️ 滑鼠 / 選取」。切到這個模式時，滑鼠在畫布上不會產生筆跡，適合用來避免誤畫、選取文字框、拖曳文字框或編輯文字內容。也可以使用快捷鍵：

```text
V 或 Esc：滑鼠 / 選取
P：畫筆
E：橡皮擦
T：文字框
```


## 分享連結與進房間畫面

分享連結會長得像：

```text
https://你的網站網址/?room=room-abc123
```

打開分享連結後，系統會先停在「輸入房間名稱」畫面，並自動把房號填入輸入框。使用者仍需要按下「進入房間」才會正式加入白板。

## 不同 Wi-Fi 是否可以使用

可以，但要分成兩種情況：

### 1. 只在同一個 Wi-Fi / 同一個區域網路測試

伺服器電腦執行：

```bash
python server.py
```

其他裝置不要開 `127.0.0.1`，要開伺服器電腦的區域網路 IP，例如：

```text
http://192.168.1.23:5001
```

其中 `192.168.1.23` 要換成執行 server.py 那台電腦的 IPv4 位址。Windows 可用：

```powershell
ipconfig
```

查看 IPv4 Address。若連不上，通常是 Windows 防火牆尚未開放 Python 或 5001 port。

### 2. 不同 Wi-Fi / 不同地點 / 手機行動網路也要連

本機的 `127.0.0.1` 與 `192.168.x.x` 不能直接跨網路使用。建議部署到 Render，取得公開網址，例如：

```text
https://whiteboard-v2.onrender.com
```

只要所有人都開同一個 Render 網址，輸入相同房間名稱，就可以在不同 Wi-Fi 下同步使用。

開發測試也可以用 ngrok 暫時產生公開網址，但正式專題展示建議使用 Render 或其他雲端主機。

## 自動儲存與房間清除說明

伺服器會在房間有人使用時，把房間狀態自動存到：

```text
data/rooms.json
```

內容包含：

- 畫筆事件
- 圖片事件
- 文字框狀態
- 房間更新時間

為了避免白板歷史資料一直累積造成記憶體壓力，本版本採用「空房間自動刪除」策略：

```text
最後一位使用者離開房間或斷線
↓
伺服器刪除該房間的畫筆事件、圖片事件、文字框資料
↓
同步更新 data/rooms.json
```

也就是說，房間內還有人時會保留白板內容；所有人都離開後，該房間資料會自動清除。這種設計比較適合課堂展示、專題展示與臨時協作白板。

注意：如果未來想改成「所有人離開後仍永久保存白板」，可以再改用 Persistent Disk、資料庫或關閉空房間自動刪除策略。

## Render 部署

### 方法一：使用 Dashboard

1. 先把專案推到 GitHub。
2. 到 Render 建立 New Web Service。
3. 連接 GitHub repository。
4. Build Command 設定：

```bash
pip install -r requirements.txt
```

5. Start Command 設定：

```bash
gunicorn -k geventwebsocket.gunicorn.workers.GeventWebSocketWorker -w 1 --bind 0.0.0.0:$PORT server:app
```

6. 新增環境變數：

```text
SECRET_KEY=任意一組長密碼
WHITEBOARD_DATA_FILE=data/rooms.json
MAX_EVENTS_PER_ROOM=20000
MAX_IMAGE_DATA_URL=8000000
```

### 方法二：使用 render.yaml

此專案已附上 `render.yaml`，可以在 Render 建立 Blueprint，讓 Render 依照檔案自動設定 Build Command 與 Start Command。

## GitHub 協作流程

建議使用以下流程，避免多人同時修改主線造成衝突。

### 第一次上傳

```bash
git init
git add .
git commit -m "Initial whiteboard v2 project"
git branch -M main
git remote add origin https://github.com/你的帳號/whiteboard-v2.git
git push -u origin main
```

### 組員開發新功能

```bash
git checkout -b feature/text-tool
# 修改程式
git add .
git commit -m "Add text tool improvement"
git push origin feature/text-tool
```

之後到 GitHub 開 Pull Request，確認沒問題後再合併到 `main`。

### 每次開發前同步最新版

```bash
git checkout main
git pull origin main
git checkout -b feature/你的功能名稱
```

## 重要檔案說明

### server.py

負責：

- 房間管理
- 使用者人數統計
- 畫筆事件同步
- 圖片事件同步
- 文字框同步
- 清除畫布
- 自動儲存
- 回傳歷史房間狀態

### templates/index.html

負責：

- 頁面結構
- 加入房間畫面
- 白板主畫面
- 工具列
- Canvas 與文字圖層

### static/app.js

負責：

- Socket.IO 前端連線
- 畫筆 / 橡皮擦操作
- 圖片讀取與同步
- 文字框新增、拖曳、縮放、刪除與同步
- PNG / JPG 匯出
- 分享連結

### static/style.css

負責：

- 整體版面
- 工具列樣式
- 白板區域
- 文字框 UI
- 響應式設計

## 後續可加強方向

- 加入登入系統
- 每個房間加密碼
- 加入 Undo / Redo
- 加入物件選取與移動圖片
- 使用 Redis / PostgreSQL 儲存資料
- 部署多台伺服器時使用 message queue


## Render Python 版本注意

本專案已加入 `.python-version`，內容為 `3.11.9`。Render 目前預設 Python 可能會使用 3.14.x，會導致 `gevent` 編譯失敗。因此部署時請確認 Deploy Log 顯示：

```text
Using Python version 3.11.9
```

如果仍顯示 3.14.x，請到 Render 的 Environment Variables 新增：

```text
PYTHON_VERSION=3.11.9
```

然後使用 `Manual Deploy -> Clear build cache & deploy` 重新部署。

## v3 新增功能：房間密碼、使用者名稱、多人游標

本版本在原本協作白板 v2 的基礎上，新增三個協作展示功能：

1. **使用者名稱**：進入房間前需輸入暱稱，進入後會顯示在上方狀態列與在線使用者清單。
2. **房間密碼**：第一次建立房間時輸入的密碼會成為該房間密碼；之後其他人進入同一房間時必須輸入相同密碼。若密碼留空，該房間就是開放房間。
3. **多人游標**：同房間使用者移動滑鼠時，其他人會看到對方游標位置與名稱，方便展示即時協作效果。

> 注意：本專案仍採用「所有人離開房間後自動刪除房間資料」的設計，因此房間密碼、文字框、圖片與畫筆紀錄也會在空房間時一起清除。

## 更新已部署 Render 專案

如果你已經部署到 Render，只需要把新版檔案上傳到同一個 GitHub repository，Render 會自動重新部署。

建議更新檔案：

```text
server.py
templates/index.html
static/app.js
static/style.css
README.md
RENDER_DEPLOY_GUIDE.md
```

如果 Render 沒有自動部署，可以到 Render 後台按：

```text
Manual Deploy → Clear build cache & deploy
```

## v4 新增功能：企業展示版

本版本在 v3「房間密碼、使用者名稱、多人游標」的基礎上，新增較接近正式多人協作白板產品的功能：

- **Undo / Redo**：支援回上一步與重做，快捷鍵為 `Ctrl + Z` 與 `Ctrl + Y`。
- **形狀工具**：新增直線、矩形、圓形、箭頭，可用於架構圖、流程圖與課堂說明。
- **便利貼**：新增貼紙式文字物件，適合會議記錄、想法發散與分組討論。
- **JSON 匯出 / 匯入**：可將房間目前白板狀態匯出成 JSON，也可匯入回同一房間並同步給所有人。
- **格線背景**：方便對齊與繪製系統架構圖。
- **WebSocket 同步強化**：畫筆、形狀、文字框、便利貼、圖片、Undo/Redo、多人游標與使用者狀態皆透過 Socket.IO 事件同步。

> 注意：本版本仍維持「所有人離開房間後自動刪除房間資料」的設計，用於避免記憶體與 Render 暫存檔案持續累積。若要做成商用長期保存服務，建議下一階段改接 PostgreSQL / Redis / S3 類型儲存服務。

## v4.1 修正：圖片可移動與縮放

本版修正原本圖片上傳後只能顯示在 Canvas、無法移動的問題。現在圖片會以可操作物件加入白板：

- 切換到「滑鼠 / 選取」工具後，可拖曳圖片移動位置。
- 可拖曳圖片右下角調整圖片大小。
- 可使用圖片上方工具列刪除圖片。
- 圖片位置與大小會透過 Socket.IO 同步給同房間其他使用者。
- PNG / JPG 匯出會包含目前圖片位置。
- JSON 匯出會包含更新後的圖片位置與大小。

對應新增後端事件：

```text
image_update
image_delete
```
