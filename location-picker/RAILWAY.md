# Location Picker — 部署到 Railway

把 `server.js`（网页地图选点服务）跑在 Railway 上：**免 VPS、自带 HTTPS 域名**，比 Cloudflare Worker 更接近自托管（同一份 Node 代码，本地/Docker/Railway 完全一致）。

部署完成后你会得到两个地址：

| 用途 | 地址 |
|------|------|
| 手机上打开的**地图选点页** | `https://<你的服务>.up.railway.app/?token=<TOKEN>` |
| 模块里填的**远程配置 URL** | `https://<你的服务>.up.railway.app/loc.json?token=<TOKEN>` |
| 你自己用的**管理台** | `https://<你的服务>.up.railway.app/admin?token=<ADMIN_TOKEN>` |

---

## 一、准备两个口令

```bash
openssl rand -hex 24   # TOKEN —— 给使用者的口令
openssl rand -hex 24   # ADMIN_TOKEN —— 只有你自己用的管理台口令
```

**这就是唯一的访问控制，别用弱口令。** 两个必须不一样，否则服务拒绝启动。

只想自己一个人用、不需要后台的话，`ADMIN_TOKEN` 可以不设——那样 `/admin` 路径整个不存在（返回 404），不会被人扫出来。

---

## 二、网页后台部署（推荐）

1. 把本仓库 fork 到自己的 GitHub。
2. 打开 [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → 选中你 fork 的仓库。
3. 进入服务 → **Settings**：
   - **Root Directory** 填 `location-picker`
     （必须填！否则 Railway 在仓库根目录找不到 Dockerfile。填了之后它会自动读取 `location-picker/railway.json`，用 Dockerfile 构建、`/health` 做健康检查。）
   - **Networking → Public Networking → Generate Domain**，得到 `xxx.up.railway.app`
4. **Variables** 标签页新增：

   | 变量 | 值 | 说明 |
   |------|-----|------|
   | `TOKEN` | 第一步生成的第一个随机串 | 首次部署的种子 token。多人共用时用逗号分隔多个。**建好后加人就在管理台点按钮，不用再改这个变量** |
   | `ADMIN_TOKEN` | 第一步生成的第二个随机串 | 管理台口令。不填则没有 `/admin` 页面 |
   | `DATA_FILE` | `/data/loc.json` | 数据目录锚点，数据库落在同目录的 `/data/app.db`（Dockerfile 已内置同样的默认值，保险起见显式填一次） |

   `PORT` **不用填**：Dockerfile 里默认 8080，Railway 也会注入自己的 `PORT`，`server.js` 两种都认。

5. 挂持久卷（**强烈建议**）：服务面板 → 右键 / **+ Create** → **Volume** → 挂载路径填 `/data`。
   不挂卷也能用，但每次重新部署或容器重启，坐标会退回默认的 Apple Park——`/health` 里的 `"persistent": false` 就是在提示这件事。
6. 触发一次 **Deploy**，等状态变绿。

### 验证

```bash
curl https://<你的服务>.up.railway.app/health
# {"ok":true,"persistent":true,"dataFile":"/data/app.db","tokens":1,"admin":true}

curl 'https://<你的服务>.up.railway.app/loc.json?token=<TOKEN>'
# {"enabled":true,"latitude":37.3349,...}
```

`persistent` 为 `false` → 卷没挂上或 `DATA_FILE` 指到了不可写的路径，回第 5 步检查。

---

## 三、CLI 部署（可选）

```bash
npm i -g @railway/cli
railway login
cd location-picker
railway init                       # 新建 project
railway up                         # 用当前目录的 Dockerfile 部署
railway variables --set TOKEN=<用户口令>
railway variables --set ADMIN_TOKEN=<管理口令>
railway domain                     # 生成公开域名
```

Volume 目前仍需在网页后台挂载（挂载路径 `/data`）。

---

## 四、把地址填进代理模块

### Shadowrocket / Surge / Stash

模块 `argument=` **末尾**追加（注意是 `&configUrl=`）：

```
&configUrl=https://<你的服务>.up.railway.app/loc.json?token=<TOKEN>
```

### Loon

设置 → 插件 → iOS Location Spoofer → **远程配置 URL** 填：

```
https://<你的服务>.up.railway.app/loc.json?token=<TOKEN>
```

### 然后

1. iPhone 浏览器打开 `https://<你的服务>.up.railway.app/?token=<TOKEN>`
2. 点地图选点（海拔自动获取）→ **保存定位**
3. 按主 README 的生效步骤刷新：iOS 15~18 关开定位服务；**iOS 26/27 必须重启设备**（`locationd` 缓存）

---

## 五、管理台：加人 / 停用 / 看数据

浏览器打开 `https://<你的服务>.up.railway.app/admin?token=<ADMIN_TOKEN>`，四个页签。

### Token 页签

- **生成 Token**：填个备注名（比如「老王」）→ 点生成 → **模块文本自动复制到剪贴板**，直接微信发给对方即可。新 token 立刻生效，不用重新部署。
- 每个 token 一张卡片，显示当前坐标、最后活跃时间、今日拉取 / 改点 / 错误次数。
- 两个复制按钮：**复制模块**（拼好 token 的完整 `.sgmodule` 文本）和**复制链接**（选点页地址）。里面的域名从当前请求头动态取，以后改服务名也不用改代码。
- **停用**：对方的设备会**恢复真实定位**（`/loc.json` 返回 `enabled:false`，脚本放行原始响应），同时选点页打不开了。想让他彻底用不了就点删除。

> 为什么停用不是直接拒绝？因为脚本拉不到远程配置时会回落到模块 `argument` 里写死的坐标（默认苹果总部），看起来像坏了而不是被停用。

### 看板页签

上排七个 KPI（Token 总数 / 启用 / 停用 / 今日活跃 / 今日拉取 / 今日改点 / 今日错误），下面四张图：

1. **近 7–30 天趋势**——拉取量 = 设备在跑，改点量 = 真人在用，错误量单独一条线
2. **今日 24 小时分布**——大家什么时候在用
3. **Token 活跃排行**——谁在用，谁拿了 token 从来没打开过
4. **错误构成**——403 token 无效 / 429 搜索限流 / 502 上游失败 各占多少

顶部还有一条红色告警：**同一个 IP 在窗口内 403 超过 10 次，直接点名提示「疑似 token 配置错误」**。模块里 token 抄错或多打一个空格是最常见的故障（表现为对方永远定位在苹果总部），这条能一秒定位到人，不用再一步步排查 MITM 和证书。

### 日志页签

按 token、日期范围、仅错误筛选，分页查看。每行记录时间、用户、接口、状态码、IP、详情（改点会记下新坐标）。

### 归档页签

- **存储概况**：数据库大小、日志行数、归档合计、进程内存（Railway 按内存计费，这个数字直接对应你的账单）
- **导出**：选时间范围，下载 `.csv.gz`。流式生成，几十万行也不占内存、也不会卡住其他人的请求
- **归档文件**：按月列出，可下载可删除
- **维护**：手动触发归档清理；「压缩数据库」用来在调小保留期后真正把磁盘还回去

---

## 六、数据存在哪

token、坐标、日志都在 `/data/app.db`（SQLite），归档文件在 `/data/archive/`，随 Volume 持久化。

**日志不会无限涨**：默认保留最近 3 个完整月 + 当月，更早的**先归档成 `/data/archive/logs-YYYY-MM.csv.gz`，成功了才删**。实测 CSV+gzip 约 10.6 字节/行，15 人规模下每月归档文件 0.5~2 MB，归档最多留 24 个月——加起来也就几十 MB。清理任务每 6 小时跑一次，实测一次不到 25 毫秒。

归档文件可以在管理台「归档」页签里下载到手机或电脑，不用进容器捞。

**从旧版本升级不用做任何事**：首次启动会自动把 `TOKEN` 环境变量里的 token 和已有的 `loc.json` / `loc-<hash>.json` 坐标全部导入数据库，老用户无感知。导入后那些 JSON 文件就不再被读写了，留着或删掉都行。

## 七、注意事项

- **口令即安全边界**：任何拿到 URL + TOKEN 的人都能读写你的定位。别把带 token 的链接贴进公开的 Issue / 截图。
- **必须是 Hobby 及以上方案**：Railway 的 Trial 是**一次性** $5 / 30 天；用完或到期后掉到 Free 方案（$1/月额度）。**Free 方案不允许新建 project**——点 New Project 会直接弹 `Upgrade to create a new project`，报错 `Free plan resource provision limit exceeded`。这是「资源配额」闸，跟你还剩多少额度无关，$1/月 只够维持已经建好的资源。想用 Railway 就得升到 Hobby（$5/月，含 $5 用量）。
- **成本预估**：常驻 Node 服务按内存 $0.000231/GB-分钟 计，本服务空载约 50~80MB，月成本大致 $0.3~0.8；SQLite 是进程内的，不额外起服务，日志按 15 人量级一个月也就十几 MB（卷存储 $0.15/GB-月，可忽略）。Hobby 自带的 $5 用量绰绰有余。
- **不想付费**：用同仓库的 [Cloudflare Worker 版](worker/)，功能与本服务完全一致且长期免费。
- **冷启动**：Railway 不会像 Serverless 那样休眠，但重新部署期间有几十秒不可用，期间脚本使用上一次缓存的远程配置。
- **改坐标不用重新部署**：坐标存在卷里，改完在网页上点保存即可。只有改 `server.js` 才需要重新部署。
- **换用户 TOKEN**：在管理台删掉旧的、生成新的即可，不用动 Variables，也不用重新部署。
- **换 ADMIN_TOKEN**：改 Variables → 服务自动重启 → 用新地址进管理台。
- **管理台口令别外传**：拿到它等于能看所有人的 token 和定位。链接里带 token，别贴进公开的 Issue / 截图。
