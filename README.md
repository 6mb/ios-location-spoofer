# iOS Location Spoofer

[English](README.en.md) · **中文**

用代理软件的 HTTPS 解密（MITM）功能，把 Apple 定位服务返回的坐标改掉，让 iPhone「以为」自己在世界任何角落——**无需越狱、无需电脑、无需开发者账号**。

> 📖 **新手直接看这篇** → [**小白保姆级图文教程**](使用教程.md)（Shadowrocket 一步步安装、配置、生效，含常见问题排查）

---

## 它是怎么工作的

iPhone 依靠周围的 Wi-Fi 和基站信号，把 BSSID / CellID 列表发给 Apple 的定位服务（`/clls/wloc`），Apple 回一份这些设备的坐标清单，iOS 由此算出自己的位置。

本模块做的事情很简单：**让代理把发给 Apple 的定位请求和返回的坐标全部接管，把坐标统一改成你想要的目标地点**。iPhone 拿到改造后的坐标，算出来的位置就是你指定的地方。

与「模拟定位」App 不同，这种方式在系统层面被视为真实定位，隐蔽性更高；只影响**网络定位（Wi-Fi / 基站）**，不动 GPS 硬件。

### 相比上游研究新增/增强的能力

- **多平台** — 适配 Shadowrocket / Surge / Loon / Quantumult X / Stash 五个代理平台，免编译即导即用
- **蜂窝基站坐标修改** — 不只改 Wi-Fi 热点坐标，还处理 CellTower（字段 22/24）的坐标替换
- **多响应封装兼容 + 原始字节扫描兜底** — 自动识别 Apple 回应的封装格式（ARPC / synthetic / marker / bare）；当测试版系统改变封装导致已知格式解析失败时，直接在响应字节里定位并改写坐标，避免「放行原始数据 → 定位不生效」
- **最小改写** — 只替换坐标（纬度 / 经度 / 精度），海拔、垂直精度、运动状态等字段一律透传 Apple 原值；不新增字段、不丢弃根字段，最大程度避免 iOS 把响应判为非法（否则会直接显示「定位不可用」）
- **iOS 12 兼容构建** — `location-spoofer.js` 使用不含 BigInt 的 int64 实现，兼容旧款设备的 JavaScriptCore

---

## 支持哪些软件

| 软件 | 文件 | 导入方式 |
|------|------|---------|
| Shadowrocket（小火箭） | `ios-location-spoofer.sgmodule` | 配置 → 右上角 + |
| Surge | `ios-location-spoofer-surge.sgmodule` | 首页 → 模块 → 安装新模块 |
| Loon | `ios-location-spoofer.lnplugin` | 设置 → 插件 → 添加插件 |
| Quantumult X | `ios-location-spoofer.snippet` | 设置 → 重写 → 添加 |
| Stash | `ios-location-spoofer.stoverride` | 覆写 → 安装覆写 |
| 老设备 / iOS 12 | `ios-location-spoofer-ios12.sgmodule` | 同 Shadowrocket，见下方「iOS 12 兼容版」 |

> 欢迎实测过的佬友在 Issue 区报结果；不通的地方欢迎直接提 PR——至少写明**哪个软件、哪个版本、什么系统、报错的日志原文**。

---

## 快速开始

1. 在代理软件里打开 **HTTPS 解密 / MITM** 开关
2. 安装并信任 CA 证书（设置 → 通用 → VPN 与设备管理 → 安装 → **证书信任设置 → 启用完全信任**）
3. 导入对应模块并勾选启用
4. 断开重连 VPN，关开一次定位服务
5. 打开地图 App 验证

### 🔺 iOS 26 / 27（含 beta5、beta6）必看

Apple 从 iOS 26 起大幅强化了 `locationd` 的定位**缓存**：系统会把之前的真实定位缓存到内存并长时间复用。**即使脚本已成功改写了 WLOC 响应（日志显示已修改），系统仍可能继续用旧坐标，看起来「没生效」。**

> **解决方法：重启设备。** 重启会清空 `locationd` 内存缓存，重新发起 WLOC 请求时会拿到修改后的坐标。开/关飞行模式、关闭定位服务在 iOS 26+ 上**无法**清除此缓存，必须重启。iOS 15~18 通常关开定位即可生效。

**iOS 26+ 推荐流程（成功率最高）：**

1. 先在模块/选点页设好目标坐标
2. 开飞行模式 → 关闭定位服务 → **重启设备**
3. 关闭飞行模式（Wi-Fi 也关）→ 连上代理（确认 VPN 图标出现）→ 打开定位服务
4. 打开地图验证

### 拦截域名（必须覆盖，否则拦不到请求）

各模块的 `[MITM] hostname` 已包含 Apple 定位/查找服务（`ls.apple.com` GS-PE 池）的完整域名集合，请确保代理的 HTTPS 解密列表里有它们：

```
gs-loc.apple.com
gs-loc-cn.apple.com
gsp-ssl.ls.apple.com
gspe1-ssl.ls.apple.com
gspe19-ssl.ls.apple.com
gspe19-2-ssl.ls.apple.com
gspe35-ssl.ls.apple.com
gspe79-ssl.ls.apple.com
gspe85-ssl.ls.apple.com
gsp64-ssl.ls.apple.com
gsp10-ssl.apple.com
bluedot.is.autonavi.com
bluedot.is.autonavi.com.gds.alibabadns.com
```

> 新系统（如 iOS 27）的定位/查找请求可能落在 `gspe*`、`gsp*` 这些 `ls.apple.com` 主机上，模块已全部覆盖；导入后请确认列表里有 `gspe1-ssl.ls.apple.com`、`gspe35-ssl.ls.apple.com` 等条目，缺的话手动补上（用逗号分隔）。

---

## 常见问题排查

### 定位一直不变？

按这个顺序查：

1. **证书信任设置里的开关有没有真的打开**（最常见原因）
2. 模块是否已导入且启用
3. HTTPS 解密开关是否打开、拦截域名是否齐全（见上方「拦截域名」清单）
4. **是否用对生效步骤**——iOS 26/27 要先**重启设备**；iOS 15~18 多关开几次定位
5. 把模块 `argument=` 里的 `debug=false` 改成 `debug=true`，去代理日志里搜 `Location spoofer`——能看到「patched … wifi/cell」说明拦截和改写都成功了，剩下的就是缓存问题

### 看到 `MITM failed`？

通常是 MITM 主机名匹配或证书信任问题，不是脚本改写失败：

1. 确认 iOS 已在「设置 → 通用 → 关于本机 → 证书信任设置」中对该 CA 开启「完全信任」
2. 确认请求 Host 在模块 `[MITM] hostname` 中（就是上面那 5 个域名）
3. 若日志出现其他 `/clls/wloc` Host，请在 Issue 贴出完整 Host 和路径——避免用 `*.apple.com` / `*.ls.apple.com` 这类过宽通配
4. 仍不行就关掉 QUIC/HTTP3 相关选项后重连 VPN，再关开定位

### Loon 额外说明

1. 导入 `ios-location-spoofer.lnplugin` 后，在 **设置 → 插件** 里打开插件配置页
2. 可直接填**纬度 / 经度**；**地址搜索**由每 15 分钟的定时任务联网解析并缓存（首次请直接填经纬度，或填好地址等一轮 cron）
3. 必须开启 Loon 的 **MITM** 并信任证书
4. 插件含 **Prepare** 请求脚本（设置 `Accept-Encoding: identity`，避免 gzip 引发 `zip decompress error` / 脚本超时）
5. 改坐标后按上面生效步骤操作；调试打开**调试日志**，在 Loon 日志搜 `Location spoofer`

> 日志若出现 `Evaluate script timeout` 或 `zip decompress error:-3`：更新插件并重载 Loon，确认三条脚本（Prepare / Response / Geocode cron）均已启用。

### iOS 12 兼容版

老设备（iOS 12 及更早，JavaScriptCore 不支持 BigInt）请用 `ios-location-spoofer-ios12.sgmodule`。该模块默认指向兼容构建的脚本指针，处理器为老系统做了专门适配；其余使用方式与普通模块一致。

---

## 改坐标

默认目标为 Apple Park（`37.3349, -122.00902`）。在模块参数里修改：

```
latitude=39.9042&longitude=116.4074
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `latitude` | 37.3349 | 目标纬度（始终改写） |
| `longitude` | -122.00902 | 目标经度（始终改写） |
| `address` | （空） | 地址搜索（Loon 插件 UI 填写，联网解析为经纬度，优先于手动经纬度） |
| `horizontalAccuracy` | 39 | 水平精度（米），仅当目标坐标字段里存在精度字段时替换 |
| 海拔 / 垂直精度 / 运动状态等 | — | 不再由脚本改写，一律沿用 Apple 响应里的原值（最小改写，防止 iOS 校验失败） |
| `failOpen` | true | 出错时放行原始数据（避免定位完全不可用） |
| `debug` | false | 调试日志 |

其他细节（怎么查目标地点坐标、海拔等）见[小白教程](使用教程.md)。

---

## 项目文件

```
ios-location-spoofer.sgmodule        # Shadowrocket
ios-location-spoofer-surge.sgmodule  # Surge
ios-location-spoofer.lnplugin        # Loon
ios-location-spoofer.snippet         # Quantumult X
ios-location-spoofer.stoverride      # Stash
ios-location-spoofer-ios12.sgmodule  # iOS 12 兼容版（Shadowrocket）
location-spoofer.js                  # 核心脚本（四平台共用）
location-spoofer-qx.js               # Quantumult X 专用
location-spoofer-config.json         # 配置样板
test-ios12-compat.js                 # iOS 12 兼容回归测试
使用教程.md                          # 小白保姆级图文教程
location-picker/                     # 进阶（可选）：网页地图选点
location-picker/server.js            # Node 自托管版
location-picker/worker/              # Cloudflare Worker 版（免 VPS）
location-picker/cloudflare-webui/    # 网页后台版
```

---

## 进阶：网页地图选点（免手查坐标）

经常换定位、懒得手动查坐标改参数？项目自带 [`location-picker/`](location-picker/) 地图选点工具：**点地图即定位**、海拔自动获取、精度可调，Loon / Shadowrocket 通过 `configUrl` 读取。

| 部署方式 | 目录 | 适合 |
|---------|------|------|
| **Cloudflare Worker — Wrangler CLI**（推荐） | [`location-picker/worker/`](location-picker/worker/) | 免 VPS、自带 HTTPS；熟悉命令行 |
| **Cloudflare Worker — 网页后台** | [`location-picker/cloudflare-webui/`](location-picker/cloudflare-webui/) | 免 VPS、自带 HTTPS；不想装 npm / Wrangler |
| Node 自托管 | [`location-picker/server.js`](location-picker/server.js) | 有自己的 VPS / NAS |
| Docker | [`location-picker/Dockerfile`](location-picker/Dockerfile) | 有 Docker 环境 |

Loon 插件 **远程配置 URL** 示例：

```
https://你的worker.workers.dev/loc.json?token=你的TOKEN
```

### location-picker 服务端配置

`location-picker/server.js` 通过环境变量控制，**`TOKEN` 不设进程会直接退出，不会用弱口令兜底**。

| 变量 | 是否必设 | 默认值 | 说明 |
|------|---------|--------|------|
| `TOKEN` | **必设** | 无 | 访问口令，与模块 `argument=` 末尾 `configUrl` 里的 `token=` 必须一致。建议 `openssl rand -hex 24` 生成 |
| `PORT` | 否 | `8080` | 监听端口；1024 以下需 root |
| `CERT` | 否 | 空 | HTTPS 证书 fullchain 路径；与 `KEY` 同时设置才走 https |
| `KEY` | 否 | 空 | HTTPS 私钥路径；与 `CERT` 同时设置才走 https |

启动示例：

```bash
# http（最简，先跑通流程再用 https）
TOKEN=$(openssl rand -hex 24) PORT=8080 node server.js

# https（复用 acme.sh 证书；续期无需重启，进程每 12 小时自动热加载）
TOKEN=$(openssl rand -hex 24) PORT=8443 \
CERT=/root/cert/example.com/fullchain.pem \
KEY=/root/cert/example.com/privkey.pem \
node server.js
```

数据文件 `loc.json` 自动落在 `server.js` 同目录，记录当前坐标 / 海拔 / 精度；已在 `.gitignore` 中忽略，不会被误提交进仓库。

> ⚠️ **不要把 `TOKEN` 写在命令行历史里**——推荐用 systemd 的 `Environment=` 或 `.env` + `direnv`。

#### Docker

```bash
cd location-picker
echo "TOKEN=$(openssl rand -hex 24)" > .env
docker compose up -d
```

镜像基于 `node:22-alpine`，数据卷挂载到当前目录，设 `restart: unless-stopped`。

---

## 技术说明与机制

- **核心逻辑**：拦截 `/clls/wloc` 响应 → 解析封装（ARPC / synthetic / marker / bare）→ 替换 WiFi（字段 2）与基站（字段 22/24）下的 Location 子消息坐标 → 按原封装封回，iOS 才能正确识别
- **健壮性**：当测试版系统改变响应封装、已知格式解析失败时，脚本自动启用**原始字节扫描兜底**，直接在返回字节中定位坐标子消息并改写，避免放行导致定位不生效
- **定位精度**：`horizontalAccuracy` 可在参数里设置（默认 39，想更接近 GPS 可调小到 5~15）。海拔、垂直精度等不再由脚本改写，沿用 Apple 响应原值，减小被系统识破 / 校验失败的风险
- **仅网络定位**：GPS 信号强时系统可能忽略网络定位结果，Wi-Fi 定位为主的室内场景效果最佳

## 致谢

- 核心研究：[acheong08/ios-location-spoofer](https://github.com/acheong08/ios-location-spoofer)
- 本项目接受 LINUX DO 社区佬友监督与反馈：[LINUX DO](https://linux.do)
