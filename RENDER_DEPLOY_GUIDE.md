# Render 部署教學（協作白板 v2）

## 一、先確認專案根目錄

GitHub repository 的根目錄應該要直接看到這些檔案：

```text
server.py
requirements.txt
Procfile
render.yaml
runtime.txt
templates/
static/
```

如果你上傳 GitHub 後看到的是 `whiteboard-v2/server.py`，代表你多包了一層資料夾。Render 的 Root Directory 要填 `whiteboard-v2`，或是把 `whiteboard-v2` 裡面的內容拉到 repository 根目錄。

## 二、手動用 Render Dashboard 部署

1. 到 Render，選擇 **New +**。
2. 選擇 **Web Service**。
3. 連接你的 GitHub repository。
4. Environment / Language 選擇 **Python 3**。
5. Build Command 輸入：

```bash
pip install -r requirements.txt
```

6. Start Command 輸入：

```bash
gunicorn -k geventwebsocket.gunicorn.workers.GeventWebSocketWorker -w 1 --bind 0.0.0.0:$PORT server:app
```

7. Environment Variables 建議設定：

```text
SECRET_KEY=自己輸入一串很長的亂碼
WHITEBOARD_DATA_FILE=data/rooms.json
MAX_EVENTS_PER_ROOM=20000
MAX_IMAGE_DATA_URL=8000000
```

8. 按下 **Create Web Service**，部署完成後會得到 `https://你的服務名稱.onrender.com`。

## 三、使用 render.yaml 部署

本專案已經包含 `render.yaml`，也可以在 Render 使用 Blueprint 部署。設定會自動套用 build command、start command 與環境變數。

## 四、重要提醒：自動儲存與空房間刪除

本版本有自動儲存，但不是永久保存型白板。設計邏輯如下：

```text
房間有人在線上：保留並同步白板內容
最後一位使用者離開或斷線：自動刪除該房間所有資料
```

這樣可以避免 Render 服務長時間運作後，畫筆事件、圖片與文字框資料一直累積，造成記憶體或檔案過大。

Render 免費版仍可用於專題展示。如果未來想做成「白板永久保存」，才需要額外改用 Persistent Disk、PostgreSQL、Redis 或 Key Value 儲存。

## 五、部署後測試

1. 開啟 Render 網址。
2. 輸入房間名稱，例如 `demo01`。
3. 用另一台手機或電腦開同一個網址。
4. 輸入同一個房間名稱。
5. 測試畫筆、橡皮擦、滑鼠 / 選取、文字框、圖片上傳、下載 PNG/JPG。


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

## v3 更新後的測試方式

部署成功後，請依照以下方式測試新增功能：

1. 電腦開啟 Render 網址，例如 `https://whiteboard-v2.onrender.com`。
2. 輸入使用者名稱、房間名稱與房間密碼。
3. 手機使用 4G/5G 開啟同一個網址。
4. 手機輸入另一個使用者名稱、相同房間名稱與相同密碼。
5. 兩邊進入後，應該可以看到：
   - 房間人數增加
   - 在線使用者清單
   - 對方滑鼠游標
   - 畫筆、文字框與圖片同步

如果密碼錯誤，系統會顯示「房間密碼錯誤，請重新輸入」。

## v4 功能部署後測試

部署完成後，請用兩台裝置測試以下功能：

1. 兩台裝置輸入相同房間名稱與密碼。
2. 測試畫筆與橡皮擦是否即時同步。
3. 測試形狀工具：直線、矩形、圓形、箭頭。
4. 測試便利貼與文字框新增、拖曳、縮放與刪除。
5. 測試 `Ctrl + Z` / `Ctrl + Y` 或工具列的 Undo / Redo。
6. 測試 JSON 匯出與匯入。
7. 測試所有人離開房間後，再重新進同一房間時內容是否被清除。
