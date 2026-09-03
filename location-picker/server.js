// 定位选点服务 —— 零依赖（只用 Node 内置模块，含 node:sqlite，需 Node >= 24）
// 支持：高德矢量 / 高德卫星 / 国外 OSM 多地图切换，自动 GCJ-02<->WGS-84 坐标转换
// 搜索显示多个候选（只移动视野）；点地图/拖图钉移动定位点；点“保存定位”才写入
// 点地图自动按地形获取海拔；海拔/水平精度/垂直精度可手动微调
// 可选自带 https（复用 3x-ui 的 acme.sh 证书）
//
// 多人共用：每个 token 一份独立坐标，互不干扰。token 存在 SQLite 里，
// 由管理台（/admin?token=<ADMIN_TOKEN>）随时生成 / 停用 / 删除，改完立即生效。
//
// 启动示例（首次，直接给一个用户 token）：
//   TOKEN=你的密码 PORT=8080 node server.js
//
// 启动示例（带管理台，之后在网页里加人）：
//   TOKEN=你的密码 ADMIN_TOKEN=管理口令 PORT=8080 node server.js
//
// 启动示例（https，复用已有证书）：
//   TOKEN=你的密码 PORT=8443 \
//   CERT=/root/cert/你的域名/fullchain.pem \
//   KEY=/root/cert/你的域名/privkey.pem \
//   node server.js
//
// Shadowrocket 模块 argument 末尾加（管理台里有一键复制）：
//   &configUrl=https://你的域名:8443/loc.json?token=你的密码
//
// 注意：URL 必须带 ?token=<TOKEN>。缺 token → 401 "missing token"；
// token 错 → 403 "bad token"；token 被停用 → /loc.json 返回 enabled:false（恢复真实定位）。

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const admin = require("./admin");

const PORT = process.env.PORT || 8080;
// TOKEN 环境变量现在只负责「首次引导」：启动时把里面的 token 灌进数据库，
// 之后的生成 / 停用 / 删除都在管理台做，改完立即生效，不用重新部署。
// 库里已经有 token 了的话，这个变量留空也没关系。
const ENV_TOKENS = String(process.env.TOKEN || "")
  .split(",")
  .map(function (t) { return t.trim(); })
  .filter(function (t) { return t !== ""; });
// 高德 Web 服务 key。填了就用高德搜地点（0.3 秒，国内数据全），不填完全退回 Nominatim。
// 绝不能硬编码在这里 —— 这是公开仓库，而高德 Web 服务 key 没有域名限制，泄露即被人白嫖配额。
const AMAP_KEY = String(process.env.AMAP_KEY || "").trim();
const CERT = process.env.CERT || "";                   // https 证书 fullchain 路径（留空=http）
const KEY = process.env.KEY || "";                     // https 私钥路径
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "loc.json");
const DATA_DIR = path.dirname(DATA_FILE);
const DATA_BASE = path.basename(DATA_FILE).replace(/\.json$/i, "");

// ---- 数据库：初始化 + 从环境变量/老 JSON 文件迁移 ----
var DB_FILE = "";
try {
  DB_FILE = db.init(DATA_DIR);
  db.migrateFromEnv(ENV_TOKENS, DATA_DIR, DATA_BASE);
  db.startLogFlusher();
  // 归档现在是异步分批的，但仍然不能放在 listen() 之前：库里攒了几十万行时它要跑好一会儿，
  // 顶到 Railway 的 healthcheckTimeout 就会重启 → 重启后又从头跑一遍 → 崩溃循环。
  // 先让服务起来，30 秒后再清。
  function runPrune() {
    db.pruneLogs().catch(function (e) { console.log("清理任务异常：" + e.message); });
  }
  var bootPrune = setTimeout(runPrune, 30000);
  if (bootPrune.unref) bootPrune.unref();
  var pruneTimer = setInterval(runPrune, 6 * 3600 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();
} catch (e) {
  console.error("启动失败：无法打开数据库 " + DATA_DIR + "/app.db —— " + e.message);
  process.exit(1);
}

// 一个 token 都没有，且没配管理口令 = 服务谁也用不了，直接退出而不是空转
if (!db.cachedTokens().length && !admin.enabled()) {
  console.error(
    "启动失败：数据库里没有任何 token，也没设置 ADMIN_TOKEN。\n" +
    "  首次部署请二选一：\n" +
    "    TOKEN=$(openssl rand -hex 24) node server.js        # 直接给一个用户 token\n" +
    "    ADMIN_TOKEN=$(openssl rand -hex 24) node server.js  # 进管理台自己生成"
  );
  process.exit(1);
}

// 管理口令太短等于没有：管理台认证失败不限速也不记录，弱口令就是个敞开的后门
if (admin.enabled() && admin.ADMIN_TOKEN.length < 16) {
  console.error(
    "启动失败：ADMIN_TOKEN 只有 " + admin.ADMIN_TOKEN.length + " 个字符，至少要 16 个。\n" +
    "  生成一个：openssl rand -hex 24"
  );
  process.exit(1);
}

// 管理口令绝不能和某个用户 token 撞上，否则普通用户就成了管理员
if (admin.enabled()) {
  var clash = db.cachedTokens().some(function (t) { return t.token === admin.ADMIN_TOKEN; });
  if (clash) {
    console.error("启动失败：ADMIN_TOKEN 与某个用户 token 相同，请换一个。");
    process.exit(1);
  }
  console.log("管理台已启用：/admin?token=<ADMIN_TOKEN>");
} else {
  console.log("未设置 ADMIN_TOKEN，/admin 路径不存在（返回 404）。");
}

// 常量时间比较，避免通过响应时延逐字节爆破 token
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// last_seen_at 每请求写一次太浪费，60 秒内只落一次
var lastTouch = {};
function touch(tokenId) {
  const now = Date.now();
  if (lastTouch[tokenId] && now - lastTouch[tokenId] < 60000) return;
  lastTouch[tokenId] = now;
  db.touchToken(tokenId, now);
}

// ---- 上游转发：给国内直连不通的第三方 API 兜底 ----
// 浏览器优先直连，失败/超时才回落到这里，所以正常情况下这两个接口很少被调用。
// Nominatim 使用条款要求带可识别的 User-Agent，并把频率压在 1 请求/秒以内。
const USER_AGENT =
  "ios-location-spoofer-picker/1.0 (+https://github.com/mekos2772/ios-location-spoofer)";
const UPSTREAM_TIMEOUT = 5000;      // Railway 在美国且无代理，5 秒是充分上界
const UPSTREAM_MAX_BYTES = 512 * 1024;
var lastGeocodeAt = 0;

// ---- 异步逆地理编码：坐标 -> 人能读懂的地址 ----
// 不放在 /set 的响应路径上：高德 0.11s、Nominatim 1.5s，凭什么让用户等。
// 存坐标立即返回，地址在后台补，回写时靠坐标比对丢弃过期结果（见 db.setAddressIfCoordsMatch）。
function outOfChina(lat, lng) {
  return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
}

// WGS-84 -> GCJ-02。库里存的是 WGS-84（iOS 的 CLLocation 用这个），
// 但高德的接口一律收发 GCJ-02 —— 直接把 WGS 坐标喂给 regeo，解出来是 500 米外的另一条街。
// 和选点页 GCJ 模块里的 wgs2gcj 是同一套公式，那边是给底图显示用的，这边是给高德接口用的。
function wgs2gcj(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  const a = 6378245, ee = 0.00669342162296594323;
  var x = lng - 105, y = lat - 35;
  var dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dLat += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  dLat += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  dLat += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  var dLng = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLng += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  dLng += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  dLng += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  const rad = lat / 180 * Math.PI;
  var m = Math.sin(rad); m = 1 - ee * m * m;
  const sq = Math.sqrt(m);
  return [
    lat + (dLat * 180) / ((a * (1 - ee)) / (m * sq) * Math.PI),
    lng + (dLng * 180) / (a / sq * Math.cos(rad) * Math.PI)
  ];
}

// 高德接口统一入口：坐标转 GCJ-02，参数顺序是「经度,纬度」
function amapRegeo(lat, lng) {
  const g = wgs2gcj(lat, lng);
  return getJson(
    "https://restapi.amap.com/v3/geocode/regeo?extensions=base&location=" +
      encodeURIComponent(g[1].toFixed(6) + "," + g[0].toFixed(6)) +
      "&key=" + encodeURIComponent(AMAP_KEY),
    {}, 5000
  );
}

// 拉一段 JSON，失败一律 resolve(null) —— 补地址是锦上添花，不该让任何人看到报错
function getJson(targetUrl, headers, timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(v) { if (!done) { done = true; resolve(v); } }
    const rq = https.get(targetUrl, { headers: headers || {} }, function (up) {
      if (up.statusCode < 200 || up.statusCode >= 300) { up.resume(); return finish(null); }
      var body = "";
      up.setEncoding("utf8");
      up.on("data", function (c) {
        body += c;
        if (body.length > UPSTREAM_MAX_BYTES) { rq.destroy(); finish(null); }
      });
      up.on("end", function () { try { finish(JSON.parse(body)); } catch (e) { finish(null); } });
    });
    rq.on("error", function () { finish(null); });
    rq.setTimeout(timeoutMs || 6000, function () { rq.destroy(); finish(null); });
  });
}

async function amapAddress(lat, lng) {
  if (!AMAP_KEY) return "";
  const d = await amapRegeo(lat, lng);
  // 高德对国外坐标返回的是 status=1 但 formatted_address 为空字符串，不是报错 —— 得当查不到处理
  if (!d || d.status !== "1" || !d.regeocode) return "";
  const fa = d.regeocode.formatted_address;
  return typeof fa === "string" ? fa.trim() : "";
}

async function osmAddress(lat, lng) {
  const d = await getJson(
    "https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&addressdetails=0" +
      "&lat=" + lat.toFixed(6) + "&lon=" + lng.toFixed(6),
    { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh" }, 8000
  );
  return d && typeof d.display_name === "string" ? d.display_name.trim() : "";
}

// 每个 token 同时只跑一次逆解，防止连点刷爆上游。
// 但排队时必须保留「最后一次」的坐标而不是丢弃它 —— 用户连改两个点时，
// 该被丢的是先发的那次（尤其国外走 Nominatim 要 1.5 秒，很容易后返回），
// 而不是后发的、也就是他真正想要的那个点。
var addrWanted = new Map();           // tokenId -> [lat, lng]，最新意图
var addrRunning = new Set();          // tokenId，正在解的

function resolveAddress(tokenId, lat, lng) {
  addrWanted.set(tokenId, [lat, lng]);
  if (addrRunning.has(tokenId)) return;      // 在跑了，它收尾时会读最新的 addrWanted
  addrRunning.add(tokenId);
  (async function () {
    try {
      for (;;) {
        const want = addrWanted.get(tokenId);
        if (!want) break;
        addrWanted.delete(tokenId);
        var addr = "";
        try {
          if (!outOfChina(want[0], want[1])) addr = await amapAddress(want[0], want[1]);
          // 境外，或者境内但高德没数据（荒郊野岭）时兜底
          if (!addr) addr = await osmAddress(want[0], want[1]);
        } catch (e) { /* 补地址失败不影响任何主流程 */ }
        // 带坐标做条件：解的过程中用户又改了点，这次结果自动作废
        if (addr) {
          try { db.setAddressIfCoordsMatch(tokenId, want[0], want[1], addr); } catch (e) { /* 库出问题时静默 */ }
        }
      }
    } finally {
      addrRunning.delete(tokenId);
    }
  })();
}

function proxyUpstream(targetUrl, res, headers, timeoutMs) {
  var settled = false;
  function fail(code, msg) {
    if (settled) return;
    settled = true;
    send(res, code, "application/json", JSON.stringify({ error: msg }));
  }
  var upReq = https.get(targetUrl, { headers: headers || {} }, function (up) {
    if (up.statusCode < 200 || up.statusCode >= 300) {
      up.resume();
      return fail(502, "upstream " + up.statusCode);
    }
    var body = "";
    up.setEncoding("utf8");
    up.on("data", function (c) {
      body += c;
      if (body.length > UPSTREAM_MAX_BYTES) {
        upReq.destroy();
        fail(502, "upstream response too large");
      }
    });
    up.on("end", function () {
      if (settled) return;
      settled = true;
      send(res, 200, "application/json", body);
    });
  });
  upReq.setTimeout(timeoutMs || UPSTREAM_TIMEOUT, function () {
    upReq.destroy();
    fail(504, "upstream timeout");
  });
  upReq.on("error", function (e) {
    fail(502, "upstream error: " + e.message);
  });
}

function send(res, code, type, body) {
  res.writeHead(code, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

// 区分「没传 token」和「token 传错」：前者 401 引导补 ?token=，后者 403
// 命中返回 token 行（含 id / status），未命中返回 null 并已写好响应
function resolveToken(token, res) {
  if (token == null || token === "") {
    send(res, 401, "application/json", '{"error":"missing token","hint":"add ?token=<TOKEN> to the URL"}');
    return null;
  }
  // 逐个比对，全程走常量时间比较，不因命中位置不同而泄露信息
  var list = db.cachedTokens();
  var matched = null;
  for (var i = 0; i < list.length; i += 1) {
    if (safeEqual(token, list[i].token)) {
      matched = list[i];
    }
  }
  if (!matched) {
    send(res, 403, "application/json", '{"error":"bad token"}');
    return null;
  }
  res._tokenId = matched.id;
  touch(matched.id);
  return matched;
}

// 停用的 token 还能被识别（日志里看得到是谁），但不能操作选点
function requireActive(row, res) {
  if (row.status !== "active") {
    send(res, 403, "application/json", '{"error":"token disabled","hint":"该 token 已被管理员停用"}');
    return false;
  }
  return true;
}

// 只记录业务接口；/health 被 Railway 高频探活，记了全是噪音
const LOGGED_PATHS = {
  "/": 1, "/loc.json": 1, "/set": 1, "/enable": 1, "/geocode": 1, "/elevation": 1, "/regeo": 1
};

// X-Forwarded-For 的语义是「每层代理往尾部追加自己看到的对端地址」，所以
// 最左边那段是客户端自己写进去的，可以随便伪造 —— 取它等于把日志 IP 的控制权交给攻击者：
// 爆破 token 时每次换个假 IP，看板那条「同 IP 多次 403」的告警就永远不会触发。
// 正确做法是从右往左数固定跳数。Railway 前面是一层边缘代理，所以默认 1；
// 裸机直连公网（没有任何代理）请设成 0，只信 socket 地址。
const TRUST_PROXY_HOPS = (function () {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.log("TRUST_PROXY_HOPS 不是合法的非负整数，回落到 1");
    return 1;
  }
  return n;
})();

function clientIp(req) {
  const direct = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (TRUST_PROXY_HOPS === 0) return direct.slice(0, 45);
  const xff = req.headers["x-forwarded-for"];
  if (!xff) return direct.slice(0, 45);
  const parts = String(xff).split(",")
    .map(function (t) { return t.trim(); })
    .filter(function (t) { return t !== ""; });
  // 代理层数比预期少（比如有人绕过代理直连）时，最左那段仍然可能是伪造的，
  // 这种情况下宁可用 socket 地址，也不用一个不可信的值
  if (parts.length < TRUST_PROXY_HOPS) return direct.slice(0, 45);
  return (parts[parts.length - TRUST_PROXY_HOPS] || direct).slice(0, 45);
}

function handler(req, res) {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const token = url.searchParams.get("token");

  // 访问日志：路由只管往 res 上挂 _tokenId / _detail，响应结束后统一落库
  res._tokenId = 0;
  res._detail = "";
  if (LOGGED_PATHS[url.pathname]) {
    res.on("finish", function () {
      db.logRequest({
        ts: Date.now(),
        tokenId: res._tokenId,
        path: url.pathname,
        status: res.statusCode,
        ip: clientIp(req),
        ua: String(req.headers["user-agent"] || "").slice(0, 160),
        detail: res._detail || null
      });
    });
  }

  // ---- 管理台（未设置 ADMIN_TOKEN 时整段不存在，直接落到下面的 404） ----
  if (admin.handle(req, res, url)) return;

  // ---- 健康检查（无需 token，供 Railway / Docker 探活） ----
  if (url.pathname === "/health" && req.method === "GET") {
    // 这个接口不需要 token，所以只能回最少的东西。以前它还返回 admin/tokens/rssMB —— 
    // admin:true 等于直接告诉外面「这里有个后台」，把 /admin 认证失败也回 404 的伪装白做了；
    // tokens 泄露用户数，rssMB 能被用来侧面观察负载。这些都挪进了 /admin/api/info。
    return send(res, 200, "application/json", JSON.stringify({ ok: true }));
  }

  // ---- 地名搜索转发（Nominatim 国内直连不通；浏览器直连失败才会走到这里） ----
  if (url.pathname === "/geocode" && req.method === "GET") {
    var gRow = resolveToken(token, res);
    if (!gRow || !requireActive(gRow, res)) return;
    var q = String(url.searchParams.get("q") || "").trim();
    if (!q) {
      return send(res, 400, "application/json", '{"error":"missing q"}');
    }
    res._detail = q.slice(0, 60);
    // src=amap：走高德 POI 搜索。用 /place/text 而不是 /geocode/geo ——
    // 后者只认规范门牌地址，搜「星巴克」直接 status=0；前者才是高德 App 搜索框背后的东西。
    // city 只传不加 citylimit：它是「优先」而非「限定」，所以地图停在杭州时
    // 搜「星巴克」出杭州的，搜「北京故宫」照样能出北京的（加了 citylimit 就会返回一堆杭州的杂货店）。
    if (String(url.searchParams.get("src") || "") === "amap" && AMAP_KEY) {
      var city = String(url.searchParams.get("city") || "").trim().slice(0, 20);
      return proxyUpstream(
        "https://restapi.amap.com/v3/place/text?offset=10&page=1&extensions=base" +
          "&keywords=" + encodeURIComponent(q) +
          (city ? "&city=" + encodeURIComponent(city) : "") +
          "&key=" + encodeURIComponent(AMAP_KEY),
        res,
        {}
      );
    }
    // 所有人共用服务端一个 IP，不节流容易触发 Nominatim 封禁
    var nowTs = Date.now();
    if (nowTs - lastGeocodeAt < 1000) {
      return send(res, 429, "application/json", '{"error":"rate limited","hint":"Nominatim 限 1 请求/秒，请稍后重试"}');
    }
    lastGeocodeAt = nowTs;
    return proxyUpstream(
      "https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=8&q=" +
        encodeURIComponent(q),
      res,
      { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh" }
    );
  }

  // ---- 海拔转发（open-meteo 免费额度 1 万次/天，政策宽松，不做节流） ----
  // ---- 地图中心所在城市：只给搜索框当 city 参数用，不写库 ----
  if (url.pathname === "/regeo" && req.method === "GET") {
    var rRow = resolveToken(token, res);
    if (!rRow || !requireActive(rRow, res)) return;
    var rLat = Number(url.searchParams.get("lat"));
    var rLng = Number(url.searchParams.get("lng"));
    if (!isFinite(rLat) || !isFinite(rLng) || !AMAP_KEY || outOfChina(rLat, rLng)) {
      return send(res, 200, "application/json", '{"city":""}');
    }
    return amapRegeo(rLat, rLng).then(function (d) {
      var c = "";
      if (d && d.status === "1" && d.regeocode && d.regeocode.addressComponent) {
        const ac = d.regeocode.addressComponent;
        // 直辖市的 city 是空数组，得回落到 province
        c = (typeof ac.city === "string" && ac.city) ? ac.city
          : (typeof ac.province === "string" ? ac.province : "");
      }
      send(res, 200, "application/json", JSON.stringify({ city: c }));
    });
  }

  if (url.pathname === "/elevation" && req.method === "GET") {
    var eRow = resolveToken(token, res);
    if (!eRow || !requireActive(eRow, res)) return;
    var elat = Number(url.searchParams.get("lat"));
    var elng = Number(url.searchParams.get("lng"));
    if (
      !isFinite(elat) || !isFinite(elng) ||
      elat < -90 || elat > 90 || elng < -180 || elng > 180
    ) {
      return send(res, 400, "application/json", '{"error":"bad coords"}');
    }
    return proxyUpstream(
      "https://api.open-meteo.com/v1/elevation?latitude=" + elat + "&longitude=" + elng,
      res,
      { "User-Agent": USER_AGENT }
    );
  }

  // ---- Shadowrocket 读取坐标（存的就是 WGS-84，Apple 需要的格式） ----
  if (url.pathname === "/loc.json" && req.method === "GET") {
    var owner = resolveToken(token, res);
    if (!owner) return;
    var loc = db.readLocation(owner.id);
    // 停用不是拒绝，而是「还你真实定位」：脚本收到 enabled:false 会放行原始响应。
    // 若回 403，脚本反而会回落到模块里写死的坐标（默认是苹果总部），体验上像是坏了。
    if (owner.status !== "active") {
      loc = Object.assign({}, loc, { enabled: false });
      res._detail = "disabled";
    }
    return send(res, 200, "application/json", JSON.stringify(loc));
  }

  // ---- 网页保存（前端已转好 WGS-84 再发过来；海拔/精度可选） ----
  if (url.pathname === "/set" && req.method === "POST") {
    var setOwner = resolveToken(token, res);
    if (!setOwner || !requireActive(setOwner, res)) return;
    let body = "";
    req.on("data", function (c) {
      body += c;
      if (body.length > 1e4) req.destroy();
    });
    req.on("end", function () {
      try {
        const j = JSON.parse(body);
        const la = Number(j.lat);
        const lo = Number(j.lng);
        if (
          !isFinite(la) || !isFinite(lo) ||
          la < -90 || la > 90 || lo < -180 || lo > 180
        ) {
          return send(res, 400, "application/json", '{"error":"bad coords"}');
        }
        const cur = db.readLocation(setOwner.id);
        cur.enabled = true; // 保存一个新位置 = 开启伪造
        cur.latitude = la;
        cur.longitude = lo;
        // 海拔/精度：脚本里都会被 Math.trunc 成整数，这里取整存
        function setInt(key, v) {
          if (v !== undefined && v !== null && v !== "" && isFinite(Number(v))) {
            cur[key] = Math.round(Number(v));
          }
        }
        setInt("altitude", j.altitude);
        setInt("horizontalAccuracy", j.horizontalAccuracy);
        setInt("verticalAccuracy", j.verticalAccuracy);
        const saved = db.writeLocation(setOwner.id, cur);
        resolveAddress(setOwner.id, la, lo);        // 不 await：地址在后台补
        res._detail = la.toFixed(5) + "," + lo.toFixed(5);
        return send(res, 200, "application/json", JSON.stringify(saved));
      } catch (e) {
        return send(res, 400, "application/json", '{"error":"bad json"}');
      }
    });
    return;
  }

  // ---- 一键切换：伪造 / 恢复真实定位 ----
  if (url.pathname === "/enable" && req.method === "POST") {
    var enableOwner = resolveToken(token, res);
    if (!enableOwner || !requireActive(enableOwner, res)) return;
    let body = "";
    req.on("data", function (c) {
      body += c;
      if (body.length > 1e4) req.destroy();
    });
    req.on("end", function () {
      try {
        const j = JSON.parse(body);
        const cur = db.readLocation(enableOwner.id);
        cur.enabled = j.enabled !== false; // false=恢复真实定位（脚本放行）
        db.writeLocation(enableOwner.id, cur);
        res._detail = cur.enabled ? "伪造开" : "恢复真实";
        return send(res, 200, "application/json", JSON.stringify(cur));
      } catch (e) {
        return send(res, 400, "application/json", '{"error":"bad json"}');
      }
    });
    return;
  }

  // ---- 地图网页（与 Worker 版一致，必须带正确 token） ----
  if (url.pathname === "/" && req.method === "GET") {
    var pRow = resolveToken(token, res);
    if (!pRow || !requireActive(pRow, res)) return;
    return send(res, 200, "text/html; charset=utf-8", PAGE);
  }

  return send(res, 404, "text/plain", "not found");
}

// 退出前把内存里没落盘的日志冲掉，并给在途响应一点时间 ——
// 直接 exit 会把正在下载的归档拦腰截断，客户端拿到半个 gzip 文件。
var closing = false;
var httpServer = null;
function shutdown() {
  if (closing) return;             // 连按两次 Ctrl-C 不要重复 close
  closing = true;
  function done() { db.close(); process.exit(0); }
  const t = setTimeout(done, 8000);   // 兜底：赖着不走的连接最多等 8 秒
  if (t.unref) t.unref();
  if (httpServer) { httpServer.close(done); } else { done(); }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ---- 启动：有证书走 https，否则 http ----
function onListenError(err) {
  if (err.code === "EADDRINUSE") {
    console.error("启动失败：端口 " + PORT + " 已被占用，请改用其它空闲端口（修改 PORT 环境变量）。");
  } else if (err.code === "EACCES") {
    console.error("启动失败：没有权限监听端口 " + PORT + "（1024 以下端口需 root 权限）。");
  } else {
    console.error("启动失败：" + err.message);
  }
  process.exit(1);
}

function start() {
  if (CERT && KEY) {
    try {
      const opts = { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) };
      const server = https.createServer(opts, handler);
      httpServer = server;
      server.on("error", onListenError);
      // acme.sh 续期后无需重启：每 12 小时热加载一次证书
      setInterval(function () {
        try {
          server.setSecureContext({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) });
        } catch (e) {
          console.log("cert reload failed: " + e.message);
        }
      }, 12 * 3600 * 1000);
      server.listen(PORT, function () {
        console.log("location picker (https) listening on :" + PORT);
      });
      return;
    } catch (e) {
      console.log("https 启动失败（证书读取失败），回退到 http：" + e.message);
    }
  }
  const server = http.createServer(handler);
  httpServer = server;
  server.on("error", onListenError);
  server.listen(PORT, function () {
    console.log("location picker (http) listening on :" + PORT);
  });
}

start();

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>定位选点</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
  .bar{padding:8px;display:flex;gap:6px;box-sizing:border-box}
  .bar input{flex:1;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:8px}
  .bar button{padding:10px 14px;font-size:16px;border:0;border-radius:8px;background:#007aff;color:#fff}
  .bar button:disabled{opacity:.55}
  .results{margin:0 8px;border:1px solid #e2e2e2;border-radius:8px;max-height:34vh;overflow:auto;display:none}
  .results.show{display:block}
  .rrow{padding:10px 12px;font-size:14px;border-bottom:1px solid #eee;color:#222;display:flex;align-items:center;gap:8px}
  .rrow:last-child{border-bottom:0}
  #results .rrow{display:block}
  #results .rsub{color:#888;font-size:12px;line-height:1.5}
  .rrow:active{background:#f0f6ff}
  .rrow .fname{flex:1;min-width:0}
  .rrow .fdel{padding:6px 10px;font-size:13px;border:0;border-radius:6px;background:#ff3b30;color:#fff;flex-shrink:0}
  #map{height:52vh}
  #info{padding:8px 10px;font-size:13px;line-height:1.4}
  .opts{padding:6px 10px 12px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
  .opts label{font-size:13px;color:#444;display:flex;flex-direction:column}
  .opts input{width:88px;padding:8px;font-size:15px;border:1px solid #ccc;border-radius:6px;margin-top:2px}
  #savebtn{padding:11px 20px;font-size:16px;border:0;border-radius:8px;background:#34c759;color:#fff;font-weight:600}
  #restorebtn{padding:11px 16px;font-size:15px;border:0;border-radius:8px;background:#8e8e93;color:#fff}
  #favadd,#favlistbtn{padding:11px 14px;font-size:15px;border:0;border-radius:8px;background:#5856d6;color:#fff}
  .toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
    background:rgba(0,0,0,.85);color:#fff;padding:10px 16px;border-radius:8px;
    font-size:14px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:9999}
  .toast.show{opacity:1}
</style>
</head>
<body>
<div class="bar">
  <input id="q" placeholder="搜地名，回车列出候选（只预览，不改定位）">
  <button id="locatebtn" disabled>当前位置</button>
  <button id="btn">搜</button>
</div>
<div class="results" id="results"></div>
<div id="map"></div>
<div id="info">加载中…</div>
<div class="opts">
  <label>海拔(米)<input id="alt" type="number" inputmode="numeric"></label>
  <label>水平精度<input id="hacc" type="number" inputmode="numeric"></label>
  <label>垂直精度<input id="vacc" type="number" inputmode="numeric"></label>
  <button id="savebtn">保存定位</button>
  <button id="restorebtn">恢复真实定位</button>
  <button id="favadd">收藏此点</button>
  <button id="favlistbtn">我的收藏</button>
</div>
<div class="results" id="favs"></div>
<div class="toast" id="toast"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var token = new URLSearchParams(location.search).get("token") || "";
var AMAP_ON = ${AMAP_KEY ? "true" : "false"};   // 服务端有没有配 AMAP_KEY，决定搜索走高德还是 Nominatim

// ---------- GCJ-02 <-> WGS-84 坐标转换（中国地图偏移修正） ----------
var GCJ = (function(){
  var PI = Math.PI, a = 6378245.0, ee = 0.00669342162296594323;
  function outOfChina(lat,lng){return (lng<72.004||lng>137.8347)||(lat<0.8293||lat>55.8271);}
  function tLat(x,y){
    var r=-100.0+2.0*x+3.0*y+0.2*y*y+0.1*x*y+0.2*Math.sqrt(Math.abs(x));
    r+=(20.0*Math.sin(6.0*x*PI)+20.0*Math.sin(2.0*x*PI))*2.0/3.0;
    r+=(20.0*Math.sin(y*PI)+40.0*Math.sin(y/3.0*PI))*2.0/3.0;
    r+=(160.0*Math.sin(y/12.0*PI)+320*Math.sin(y*PI/30.0))*2.0/3.0;return r;
  }
  function tLng(x,y){
    var r=300.0+x+2.0*y+0.1*x*x+0.1*x*y+0.1*Math.sqrt(Math.abs(x));
    r+=(20.0*Math.sin(6.0*x*PI)+20.0*Math.sin(2.0*x*PI))*2.0/3.0;
    r+=(20.0*Math.sin(x*PI)+40.0*Math.sin(x/3.0*PI))*2.0/3.0;
    r+=(150.0*Math.sin(x/12.0*PI)+300.0*Math.sin(x/30.0*PI))*2.0/3.0;return r;
  }
  function wgs2gcj(lat,lng){
    if(outOfChina(lat,lng))return [lat,lng];
    var dLat=tLat(lng-105.0,lat-35.0), dLng=tLng(lng-105.0,lat-35.0);
    var radLat=lat/180.0*PI, m=Math.sin(radLat); m=1-ee*m*m; var sm=Math.sqrt(m);
    dLat=(dLat*180.0)/((a*(1-ee))/(m*sm)*PI);
    dLng=(dLng*180.0)/(a/sm*Math.cos(radLat)*PI);
    return [lat+dLat,lng+dLng];
  }
  function gcj2wgs(lat,lng){ // 迭代反解，往返误差 <0.001 米
    if(outOfChina(lat,lng))return [lat,lng];
    var wlat=lat, wlng=lng;
    for(var i=0;i<3;i++){ var g=wgs2gcj(wlat,wlng); wlat+=lat-g[0]; wlng+=lng-g[1]; }
    return [wlat,wlng];
  }
  return {wgs2gcj:wgs2gcj, gcj2wgs:gcj2wgs};
})();

// ---------- 状态 ----------
var map, marker;
var WGS = {lat:0, lng:0};   // 当前“定位点(图钉)”的真值 WGS-84（预览用，未必已保存）
var datum = "gcj";          // 当前底图坐标系：'gcj'(高德) 或 'wgs'(OSM)
var saved = true;           // 图钉当前位置是否已保存到设备
var enabledState = true;    // true=伪造中；false=已恢复真实定位（脚本放行）

function $(id){return document.getElementById(id);}
function toast(t){var e=$("toast");e.textContent=t;e.classList.add("show");setTimeout(function(){e.classList.remove("show");},1800);}
function numOrNull(id){var v=$(id).value.trim();return v===""?null:Number(v);}
function wrapLng(lng){return ((((Number(lng)+180)%360)+360)%360)-180;}

function setLocateBusy(busy){
  var b=$("locatebtn");
  b.disabled=!!busy;
  b.textContent=busy?"定位中…":"当前位置";
}

function geolocationErrorMessage(err){
  if(err&&err.code===1)return "定位权限被拒绝，请在 Safari 设置中允许定位";
  if(err&&err.code===2)return "暂时无法获取当前位置";
  if(err&&err.code===3)return "获取当前位置超时，请到开阔处重试";
  return "获取当前位置失败";
}

var FAV_KEY="lp_favs_v1";
var FAV_MAX=12;
function loadFavs(){
  try{
    var raw=localStorage.getItem(FAV_KEY);
    var a=raw?JSON.parse(raw):[];
    return Array.isArray(a)?a:[];
  }catch(e){return [];}
}
function saveFavs(list){
  try{localStorage.setItem(FAV_KEY,JSON.stringify(list.slice(0,FAV_MAX)));}catch(e){}
}
function applyFavorite(it){
  var lat=Number(it.lat), lng=wrapLng(it.lng);
  if(!Number.isFinite(lat)||!Number.isFinite(lng)){toast("收藏坐标无效");return;}
  WGS={lat:lat,lng:lng};
  saved=false;
  if(it.alt!=null&&it.alt!=="")$("alt").value=it.alt;
  if(it.hacc!=null&&it.hacc!=="")$("hacc").value=it.hacc;
  if(it.vacc!=null&&it.vacc!=="")$("vacc").value=it.vacc;
  var p=dispPos();
  marker.setLatLng(p);
  map.setView(p,15);
  info();
  toast("已加载收藏，确认后保存");
}
function renderFavs(){
  var box=$("favs");
  var list=loadFavs();
  box.innerHTML="";
  if(!list.length){box.classList.remove("show");return;}
  list.forEach(function(it,idx){
    var row=document.createElement("div");
    row.className="rrow";
    var name=document.createElement("span");
    name.className="fname";
    name.textContent=it.name||(Number(it.lat).toFixed(4)+","+Number(it.lng).toFixed(4));
    name.addEventListener("click",function(){
      $("results").classList.remove("show");
      applyFavorite(it);
    });
    var del=document.createElement("button");
    del.className="fdel";
    del.type="button";
    del.textContent="删";
    del.addEventListener("click",function(e){
      e.stopPropagation();
      var next=loadFavs();
      next.splice(idx,1);
      saveFavs(next);
      if(next.length)renderFavs();else{box.innerHTML="";box.classList.remove("show");}
      toast("已删除收藏");
    });
    row.appendChild(name);
    row.appendChild(del);
    box.appendChild(row);
  });
  box.classList.add("show");
}
function addFavorite(){
  if(!Number.isFinite(WGS.lat)||!Number.isFinite(WGS.lng)){toast("当前坐标无效");return;}
  var def=$("q").value.trim()||(WGS.lat.toFixed(4)+","+WGS.lng.toFixed(4));
  var name=window.prompt("收藏名称",def);
  if(name===null)return;
  name=String(name).trim()||def;
  var list=loadFavs().filter(function(it){
    return Math.abs(Number(it.lat)-WGS.lat)>1e-5||Math.abs(Number(it.lng)-WGS.lng)>1e-5;
  });
  list.unshift({
    name:name,
    lat:WGS.lat,
    lng:WGS.lng,
    alt:numOrNull("alt"),
    hacc:numOrNull("hacc"),
    vacc:numOrNull("vacc"),
    ts:Date.now()
  });
  saveFavs(list);
  renderFavs();
  toast("已收藏");
}
function toggleFavs(){
  var box=$("favs");
  if(box.classList.contains("show")){box.classList.remove("show");return;}
  $("results").classList.remove("show");
  if(!loadFavs().length){toast("暂无收藏");return;}
  renderFavs();
}

function info(){
  if(!enabledState){
    $("info").innerHTML = "<b style='color:#ff9500'>已恢复真实定位 · 脚本放行不修改</b>　（关开定位后生效）";
    return;
  }
  var tag = saved ? "已保存 ✓" : "未保存 · 点“保存定位”生效";
  $("info").innerHTML = "<b style='color:"+(saved?"#34c759":"#ff9500")+"'>"+tag+"</b>　WGS-84 "+
    WGS.lat.toFixed(5)+", "+WGS.lng.toFixed(5)+"　海拔 "+($("alt").value||"?")+"m";
}

// 切换按钮外观：伪造中(灰按钮“恢复真实定位”) / 已恢复(橙按钮“重新开启伪造”)
function updateEnabledUI(){
  var b=$("restorebtn");
  if(enabledState){ b.textContent="恢复真实定位"; b.style.background="#8e8e93"; }
  else { b.textContent="● 重新开启伪造"; b.style.background="#ff9500"; }
  info();
}

// 一键切换 伪造/恢复真实
function toggleEnabled(){
  var want = !enabledState;
  fetch("/enable?token="+encodeURIComponent(token),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:want})})
    .then(function(r){
      if(r.ok){ enabledState=want; updateEnabledUI();
        toast(want ? "已开启伪造，记得关开定位生效" : "已恢复真实定位，记得关开定位生效"); }
      else toast("切换失败 "+r.status);
    })
    .catch(function(){ toast("网络错误"); });
}

function dispPos(){return datum==="gcj"?GCJ.wgs2gcj(WGS.lat,WGS.lng):[WGS.lat,WGS.lng];}
function toWgs(lat,lng){lng=wrapLng(lng);return datum==="gcj"?GCJ.gcj2wgs(lat,lng):[lat,lng];}

// 第三方 API（Nominatim / open-meteo）国内直连不通：先试直连，失败再回落到服务端转发。
// 直连正常耗时实测 1.4~2.1 秒，所以超时给到 3.5 秒，避免把慢请求误判成不可达。
// 探测到不通后记一个标记，本次会话后续直接走转发，不用每次干等；
// 标记 60 秒过期，防止一次偶发抖动把整个会话钉死在转发上。
var DIRECT_TIMEOUT=3500, DIRECT_STICKY_MS=60000, directBrokenAt=0;
function directLooksBroken(){
  return directBrokenAt>0 && (Date.now()-directBrokenAt)<DIRECT_STICKY_MS;
}
function upstream(directUrl, proxyPath){
  function viaProxy(){
    return fetch(proxyPath).then(function(r){
      if(!r.ok) throw new Error("proxy "+r.status);
      return r.json();
    });
  }
  if(directLooksBroken()) return viaProxy();
  return new Promise(function(resolve,reject){
    var settled=false;
    var timer=setTimeout(function(){
      if(settled)return;
      settled=true; directBrokenAt=Date.now(); reject(new Error("direct timeout"));
    },DIRECT_TIMEOUT);
    fetch(directUrl).then(function(r){
      if(!r.ok) throw new Error("direct "+r.status);
      return r.json();
    }).then(function(d){
      if(settled)return;
      settled=true; clearTimeout(timer); directBrokenAt=0; resolve(d);
    }).catch(function(e){
      if(settled)return;
      settled=true; clearTimeout(timer); directBrokenAt=Date.now(); reject(e);
    });
  }).catch(viaProxy);
}

// 按地形取海拔（open-meteo 免费高程接口，传 WGS-84）
function fetchElevation(lat,lng){
  lng=wrapLng(lng);
  return upstream(
    "https://api.open-meteo.com/v1/elevation?latitude="+lat+"&longitude="+lng,
    "/elevation?lat="+lat+"&lng="+lng+"&token="+encodeURIComponent(token)
  ).then(function(d){return (d&&d.elevation&&d.elevation.length)?d.elevation[0]:null;})
   .catch(function(){return null;});
}

// 移动定位点(图钉)：只预览，不保存
function movePin(dispLat,dispLng){
  dispLng=wrapLng(dispLng);
  var w=toWgs(dispLat,dispLng);
  WGS={lat:w[0], lng:wrapLng(w[1])};
  saved=false;
  marker.setLatLng([dispLat,dispLng]);
  info();
  fetchElevation(WGS.lat,WGS.lng).then(function(el){ if(el!==null)$("alt").value=Math.round(el); info(); });
}

// 保存定位点到设备（写入 loc.json，Shadowrocket 才会用）
function commit(){
  var payload={lat:WGS.lat, lng:WGS.lng,
    altitude:numOrNull("alt"), horizontalAccuracy:numOrNull("hacc"), verticalAccuracy:numOrNull("vacc")};
  fetch("/set?token="+encodeURIComponent(token),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
    .then(function(r){ if(r.ok){ saved=true; enabledState=true; updateEnabledUI(); toast("已保存 ✓ 记得关开定位生效"); } else { toast("保存失败 "+r.status); } })
    .catch(function(){ toast("网络错误"); });
}

function locateCurrent(){
  if(enabledState){
    toast("请先恢复真实定位并刷新定位服务");
    return;
  }
  if(!navigator.geolocation){
    toast("当前浏览器不支持定位");
    return;
  }

  setLocateBusy(true);
  navigator.geolocation.getCurrentPosition(
    function(pos){
      var lat=Number(pos&&pos.coords&&pos.coords.latitude);
      var lng=wrapLng(pos&&pos.coords&&pos.coords.longitude);
      if(!Number.isFinite(lat)||!Number.isFinite(lng)){
        toast("获取当前位置失败");
        setLocateBusy(false);
        return;
      }

      WGS={lat:lat,lng:lng};
      saved=false;
      var p=dispPos();
      marker.setLatLng(p);
      map.setView(p,16);
      info();
      fetchElevation(WGS.lat,WGS.lng).then(function(el){
        if(el!==null)$("alt").value=Math.round(el);
        info();
      });
      toast("已定位到当前位置，请确认后保存");
      setLocateBusy(false);
    },
    function(err){
      toast(geolocationErrorMessage(err));
      setLocateBusy(false);
    },
    {enableHighAccuracy:true,maximumAge:0,timeout:12000}
  );
}

// 搜索：列出多个候选，点选只移动地图视野（不动定位点、不保存）
//
// 搜索源跟着底图走 —— 高德底图用高德 POI 搜索（0.3 秒，国内数据全），
// 切到「国外 OSM」才用 Nominatim（1.5 秒）。不做「高德查不到自动串 Nominatim」，
// 那样打个错别字就要罚站 6 秒（高德 0.3 + 直连超时 3.5 + 转发 2）。
// 查不到时给一个按钮让用户一键切过去，点一下就好，不用等。
var amapCity = "", amapCityAt = [0, 0];

// 地图中心所在城市。作为 city 参数传给高德（不加 citylimit，所以是「优先」不是「限定」）：
// 停在杭州搜「星巴克」出杭州的，搜「北京故宫」照样出北京的。中心挪远了才重新解一次。
function ensureCity(){
  var c=map.getCenter(), w=toWgs(c.lat,c.lng);
  if(amapCity && Math.abs(w[0]-amapCityAt[0])<0.25 && Math.abs(w[1]-amapCityAt[1])<0.25){
    return Promise.resolve(amapCity);
  }
  return fetch("/regeo?lat="+w[0].toFixed(6)+"&lng="+w[1].toFixed(6)+"&token="+encodeURIComponent(token))
    .then(function(r){ return r.ok?r.json():null; })
    .then(function(d){ amapCity=(d&&d.city)||""; amapCityAt=[w[0],w[1]]; return amapCity; })
    .catch(function(){ return ""; });
}

function renderResults(list, empty){
  var box=$("results"); box.innerHTML="";
  if(!list.length){
    box.classList.remove("show");
    if(empty) empty(); else toast("没找到");
    return;
  }
  list.forEach(function(it){
    var row=document.createElement("div");
    row.className="rrow";
    row.innerHTML='<b>'+escHtml(it.name)+'</b>'+(it.sub?'<br><span class="rsub">'+escHtml(it.sub)+'</span>':'');
    row.addEventListener("click",function(){
      box.classList.remove("show"); box.innerHTML="";
      // it.lat/lng 一律是 WGS-84；显示前按当前底图转
      var p = datum==="gcj"?GCJ.wgs2gcj(it.lat,it.lng):[it.lat,it.lng];
      map.setView(p,16);              // 只移动视野；要设为定位，请在地图上点一下放图钉
      toast("已定位视野，在地图上点一下放置图钉");
    });
    box.appendChild(row);
  });
  box.classList.add("show");
}

function escHtml(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }

function searchAmap(q){
  return ensureCity().then(function(city){
    return fetch("/geocode?src=amap&q="+encodeURIComponent(q)+
                 (city?"&city="+encodeURIComponent(city):"")+
                 "&token="+encodeURIComponent(token))
      .then(function(r){ if(!r.ok) throw new Error("amap "+r.status); return r.json(); });
  }).then(function(d){
    if(!d || d.status!=="1" || !d.pois) return [];
    return d.pois.map(function(p){
      // 高德给的是 GCJ-02，「经度,纬度」顺序。存库和发给 iOS 的必须是 WGS-84，
      // 不转的话定位会偏 500 米左右。
      var xy=String(p.location||"").split(",");
      var g=[+xy[1], +xy[0]];
      if(!isFinite(g[0])||!isFinite(g[1])) return null;
      var w=GCJ.gcj2wgs(g[0],g[1]);
      var ad=(typeof p.address==="string"?p.address:"");
      return {name:p.name||"", sub:((p.cityname||"")+(p.adname||"")+" "+ad).trim(), lat:w[0], lng:w[1]};
    }).filter(Boolean);
  });
}

function searchOsm(q){
  return upstream(
    "https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=8&q="+encodeURIComponent(q),
    "/geocode?q="+encodeURIComponent(q)+"&token="+encodeURIComponent(token)
  ).then(function(a){
    if(!a||!a.length) return [];
    return a.map(function(it){
      var d=String(it.display_name||"");
      return {name:d.split(",")[0], sub:d, lat:+it.lat, lng:+it.lon};
    });
  });
}

function search(){
  var q=$("q").value.trim(); if(!q) return;
  var useAmap = AMAP_ON && datum==="gcj";
  (useAmap?searchAmap(q):searchOsm(q))
    .then(function(list){
      renderResults(list, useAmap?function(){
        // 不自动串 Nominatim，给个一键切换 —— 省掉 3.5 秒的直连超时
        var box=$("results");
        box.innerHTML='<div class="rrow"><b>没找到「'+escHtml(q)+'」</b><br>'+
          '<span class="rsub">要搜国外地点？点这里换用 OSM 搜索</span></div>';
        box.firstChild.addEventListener("click",function(){
          box.innerHTML=""; box.classList.remove("show");
          toast("正在用 OSM 搜索…");
          searchOsm(q).then(function(l){ renderResults(l); }).catch(function(){ toast("搜索失败"); });
        });
        box.classList.add("show");
      }:null);
    })
    .catch(function(){toast("搜索失败");});
}

function load(){
  fetch("/loc.json?token="+encodeURIComponent(token)).then(function(r){return r.json();}).then(function(d){
    WGS={lat:d.latitude, lng:d.longitude};
    saved=true;
    enabledState=(d.enabled!==false);
    $("alt").value=(d.altitude!==undefined?d.altitude:"");
    $("hacc").value=(d.horizontalAccuracy!==undefined?d.horizontalAccuracy:39);
    $("vacc").value=(d.verticalAccuracy!==undefined?d.verticalAccuracy:1000);

    var amapVec=L.tileLayer("https://wprd0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=7",{subdomains:"1234",maxZoom:18,attribution:"高德地图"});
    amapVec.datum="gcj";
    var amapSat=L.layerGroup([
      L.tileLayer("https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",{subdomains:"1234",maxZoom:18}),
      L.tileLayer("https://wprd0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=8",{subdomains:"1234",maxZoom:18})
    ]);
    amapSat.datum="gcj";
    var osm=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"});
    osm.datum="wgs";

    map=L.map("map");
    amapVec.addTo(map); datum="gcj";
    map.setView(dispPos(),13);
    L.control.layers({"高德地图":amapVec,"高德卫星":amapSat,"国外 OSM":osm},null,{collapsed:false}).addTo(map);

    marker=L.marker(dispPos(),{draggable:true}).addTo(map);
    updateEnabledUI();
    setLocateBusy(false);

    map.on("baselayerchange",function(e){datum=e.layer.datum||"wgs"; var p=dispPos(); marker.setLatLng(p); map.setView(p,map.getZoom()); info();});
    map.on("click",function(e){movePin(e.latlng.lat,e.latlng.lng);});
    marker.on("dragend",function(){var p=marker.getLatLng(); movePin(p.lat,p.lng);});
  }).catch(function(){$("info").textContent="加载失败，检查 token 是否正确";});
}

$("btn").addEventListener("click",search);
$("q").addEventListener("keydown",function(e){if(e.key==="Enter")search();});
$("locatebtn").addEventListener("click",locateCurrent);
$("savebtn").addEventListener("click",commit);
$("restorebtn").addEventListener("click",toggleEnabled);
$("favadd").addEventListener("click",addFavorite);
$("favlistbtn").addEventListener("click",toggleFavs);
load();
</script>
</body>
</html>`;
