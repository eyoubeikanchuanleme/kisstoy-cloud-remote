# KissToy Cloud Remote

通过 KissToy 云服务器远程控制玩具，绕过蓝牙直连限制。

## 原理

```
AI 脚本 → WebSocket → KissToy 云服务器 → 手机 App → 蓝牙 → 玩具
```

KissToy App 本身就是蓝牙桥：手机连着玩具蓝牙的同时，也连着 KissToy 的云服务器。这个脚本直接连云服务器发指令，服务器转发给手机 App，App 再通过蓝牙发给玩具。

不需要 Intiface，不需要电脑有蓝牙，不限距离。

## 安装

```bash
pip install websockets
```

## 获取连接参数

每次重新连接玩具，参数都会变，需要重新获取：

1. 手机打开 KissToy App，蓝牙连上玩具
2. 点"分享遥控"，拿到分享链接
3. 电脑浏览器打开链接，F12 → Network → WS 标签
4. 看 WebSocket 连接 URL 里的 `group=` 参数 → 填入脚本的 `GROUP`
5. 看 binding POST 请求的 body → 填入脚本的 `USER_ID`
6. `DEVICE_ID` 一般不用改，PLY5 是 `"19"`，其他型号抓包看

## 使用

```bash
# 编辑脚本顶部的 GROUP 和 USER_ID
vim kisstoy_cloud_remote.py

# 检查玩具是否在线
python3 kisstoy_cloud_remote.py status

# 吮吸，强度 60%
python3 kisstoy_cloud_remote.py suction 60

# 震动，强度 40%
python3 kisstoy_cloud_remote.py vibrate 40

# 全部停止
python3 kisstoy_cloud_remote.py stop

# 吮吸波浪（大起大落，5 个周期）
python3 kisstoy_cloud_remote.py swave 5

# 吮吸 edging（爬坡-保持-骤降，峰值 80%，4 轮）
python3 kisstoy_cloud_remote.py sedge 80 4

# 交互模式（手动输入指令）
python3 kisstoy_cloud_remote.py interactive
```

## 电机编号

| 编号 | 类型 | 说明 |
|------|------|------|
| 1 | 震动 | vibration motor |
| 3 | 吮吸 | suction motor |
| 5 | 电击 | electric pulse（部分型号） |

强度范围 0-100，按 5 的倍数量化（0, 5, 10, 15 ... 100）。

## 给 AI 用

如果你的 AI 有 shell 权限（Claude Code、本地部署等），直接把这个脚本交给它，让它：

1. 每次开始前问你要当次的分享链接，更新 GROUP 和 USER_ID
2. 用 `status` 确认在线
3. 根据场景调用不同命令控制节奏

AI 没有 shell 权限的话（纯聊天窗口）用不了，需要能执行代码的环境。

## 协议细节

WebSocket 地址：`wss://api.app.knightjenay.cn/websocket-kisstoy?group=GROUP`

查在线：
```json
{"event": "online_status", "data": {"group": "GROUP"}}
```

控制电机：
```json
{"event": "control", "data": {"target": "GROUP", "device_id": "19", "motors": {"3": 60}}}
```

停止：
```json
{"event": "control", "data": {"target": "GROUP", "device_id": "19", "motors": {"1": 0, "3": 0, "5": 0}}}
```

绑定（部分版本需要先调一次）：
```
POST https://api.app.knightjenay.cn/kisstoy/remote-control/binding
Body: {"id": "USER_ID"}
```

## License

MIT
