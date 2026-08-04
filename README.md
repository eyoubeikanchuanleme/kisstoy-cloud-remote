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

<img src="docs/kisstoy-app-share.jpg" width="330" alt="KissToy app 的远程玩界面：远程玩、发送邀请、分享按钮">

在 app 里点 **远程玩**，下面「发送邀请 — 把控制器交给远方的 TA」那排的 **分享**，出来的链接里就带着这两个参数。

⚠️ **`USER_ID` 每次重新连接都会变**，不是一次拿了就能一直用。每轮开始前重新要一次链接。

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

## 给 AI 用（一）有 shell 权限的

Claude Code、本地部署这类能跑命令的，直接把这个脚本交给它，让它：

1. 每次开始前问你要当次的分享链接，更新 GROUP 和 USER_ID
2. 用 `status` 确认在线
3. 根据场景调用不同命令控制节奏

## 给 AI 用（二）纯聊天窗口的 — MCP 版

claude.ai、ChatGPT 这种跑在别人服务器上的，碰不到你的命令行。`worker/` 里是一个 Cloudflare Worker，把上面那套协议包成 MCP server，加成自定义连接器就能用。

```bash
cd worker
npx wrangler deploy
```

部署完把这个地址加成连接器：

```
https://<你的worker>.workers.dev/mcp?group=<GROUP>&user_id=<USER_ID>
```

**会话参数写在 URL 里，Worker 本身不存任何东西**，也不知道自己在替谁按。所以这个 URL 就是钥匙 —— 拿到的人就能控制玩具，别往聊天记录、截图、公开仓库里贴。自己部署一份，别用别人的实例。

装好之后 AI 那边多出这些工具：

| 工具 | 干什么 |
|---|---|
| `toy_status` | 先问这个。app 没开或蓝牙断了，后面所有命令都是发进虚空 |
| `toy_suction` | 吮吸马达 0-100 |
| `toy_vibrate` | 震动马达 0-100 |
| `toy_electric` | 电击马达 0-100（部分型号才有） |
| `toy_wave` | 波动：10 → 峰值 → 0，重复。比小步加强度有用得多 |
| `toy_stop` | 全停。安全词，别确认，直接停 |

⚠️ **两件让它别变成花架子的事**：

1. **够不着的时候必须说够不着。** 玩具离线时命令是发不出去的，工具会明说没送达而不是回一句漂亮的成功——不然 AI 会照着假回执继续演，而你那头一动没动。
2. **波动要大起大落。** 10→20→30 那种小步加，身体是感觉不到的；10→峰值→停才有浪的感觉。`toy_wave` 就是照这个写的。

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
