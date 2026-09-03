// 管理后台接口 —— /admin 与 /admin/api/*
//
// 认证走独立的 ADMIN_TOKEN 环境变量，和用户 token 完全分离。
// 没设置 ADMIN_TOKEN 时，本模块直接「装作不存在」（返回 false，由 server.js 走 404），
// 而不是返回 403 —— 免得对外暴露「这里有个后台」。

const crypto = require("crypto");
const fs = require("fs");
const zlib = require("zlib");
const db = require("./db");
const page = require("./admin-page");

const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function enabled() {
  return ADMIN_TOKEN !== "";
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"       // 别把带 admin token 的 URL 漏给外链
  });
  res.end(body);
}

// 必须收完 Buffer 再整体解码：body += chunk 会对每个 TCP 分片单独 toString("utf8")，
// 一个 3 字节的汉字如果正好跨在分片边界上，两半会各自变成 U+FFFD —— 中文备注无声损坏。
function readBody(req, limit) {
  const max = limit || 1e4;
  return new Promise(function (resolve, reject) {
    const chunks = [];
    var size = 0;
    req.on("data", function (c) {
      size += c.length;
      if (size > max) { req.destroy(); return reject(new Error("body too large")); }
      chunks.push(c);
    });
    req.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

// 模块模板里的域名从请求头动态取，以后换服务名不用改代码
function originOf(req) {
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  return proto + "://" + host;
}

const SCRIPT_URL =
  "https://raw.githubusercontent.com/mekos2772/ios-location-spoofer/main/location-spoofer.js";
const MITM_HOSTS =
  "gs-loc.apple.com, gs-loc-cn.apple.com, gsp-ssl.ls.apple.com, " +
  "bluedot.is.autonavi.com, bluedot.is.autonavi.com.gds.alibabadns.com";
const PATTERN =
  "^https?:\\/\\/(?:gs-loc(?:-cn)?\\.apple\\.com|gsp-ssl\\.ls\\.apple\\.com|" +
  "bluedot\\.is\\.autonavi\\.com(?:\\.gds\\.alibabadns\\.com)?)\\/clls\\/wloc";

function buildModule(origin, token) {
  return [
    "#!name=iOS Location Spoofer",
    "#!desc=拦截 Apple 定位服务器回应的 GPS 坐标，替换成自定义位置。适用于 Shadowrocket。",
    "",
    "[Script]",
    "iOS Location Spoofer = type=http-response,pattern=" + PATTERN +
      ",requires-body=1,binary-body-mode=1,max-size=0,timeout=30,script-path=" + SCRIPT_URL +
      ",argument=mode=response&latitude=37.3349&longitude=-122.00902&horizontalAccuracy=39" +
      "&verticalAccuracy=1000&altitude=530&debug=false&configUrl=" +
      origin + "/loc.json?token=" + token,
    "",
    "[MITM]",
    "hostname = %APPEND% " + MITM_HOSTS,
    ""
  ].join("\n");
}

function buildPickerUrl(origin, token) {
  return origin + "/?token=" + token;
}


// 归档文件原样转发，不读进内存 —— 内存占用与文件大小无关
function streamArchive(res, full, name) {
  var st;
  try { st = fs.statSync(full); } catch (e) { return json(res, 404, { error: "not found" }); }
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Length": st.size,
    "Content-Disposition": 'attachment; filename="' + name + '"',
    "Cache-Control": "no-store"
  });
  const rs = fs.createReadStream(full);
  rs.on("error", function () { res.destroy(); });
  rs.pipe(res);
}

// 按时间范围导出当前表。三件事必须同时做到：
//   1) 用 id 游标分批取，不能 .all() 把整表拉进内存
//   2) 每批之间 setImmediate 让出事件循环 —— 否则同步循环会把服务器整个卡住，
//      导出 50 万行期间所有人的 /loc.json 都得排队
//   3) 走 zlib 流而不是逐批 gzipSync，让 gzip 和 socket 的背压自然传导上来，
//      顺便还能压成单个 gzip 块，压缩率更好
const EXPORT_BATCH = 1000;

function streamExport(res, fromMs, toMs, filename) {
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": 'attachment; filename="' + filename + '"',
    "Cache-Control": "no-store"
  });
  const gz = zlib.createGzip({ level: 6 });
  gz.on("error", function () { res.destroy(); });
  gz.pipe(res);
  res.on("close", function () { gz.destroy(); });

  var afterId = 0;
  var wroteHeader = false;
  function step() {
    if (res.destroyed) return;
    var rows;
    try {
      rows = db.fetchLogBatch(fromMs, toMs, afterId, EXPORT_BATCH);
    } catch (e) {
      return gz.destroy();
    }
    if (!wroteHeader) { gz.write(db.CSV_HEADER); wroteHeader = true; }   // 空区间也给个只有表头的 CSV，
    if (!rows.length) return gz.end();                                    // 否则用户分不清「没数据」和「导出坏了」
    afterId = rows[rows.length - 1].id;
    const text = db.rowsToCsv(rows);
    const last = rows.length < EXPORT_BATCH;
    const ok = gz.write(text);
    if (last) return gz.end();
    if (ok) setImmediate(step); else gz.once("drain", step);
  }
  step();
}

// 返回 true = 本模块已处理该请求；false = 不是管理路由，交回 server.js
function handle(req, res, url) {
  if (!enabled()) return false;
  if (url.pathname !== "/admin" && url.pathname.indexOf("/admin/") !== 0) return false;

  const given = url.searchParams.get("token") || req.headers["x-admin-token"] || "";
  if (!safeEqual(given, ADMIN_TOKEN)) {
    // 认证失败也回 404：不确认这个路径的存在
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return true;
  }

  const origin = originOf(req);

  // ---- 管理页 ----
  if (url.pathname === "/admin" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    });
    res.end(page.PAGE);
    return true;
  }

  // ---- token 列表 ----
  if (url.pathname === "/admin/api/tokens" && req.method === "GET") {
    const today = db.dayKey(Date.now());
    const rawDb = db.raw();
    db.flushLogs();
    const todayHits = {};
    rawDb.prepare("SELECT token_id, loc_hits, set_hits, errors FROM daily WHERE day = ?")
      .all(today)
      .forEach(function (r) { todayHits[r.token_id] = r; });

    const rows = db.listTokens().map(function (t) {
      const loc = db.readLocation(t.id);
      const h = todayHits[t.id] || {};
      return {
        id: t.id,
        token: t.token,
        label: t.label,
        status: t.status,
        createdAt: t.created_at,
        lastSeenAt: t.last_seen_at,
        location: loc,
        todayLoc: h.loc_hits || 0,
        todaySet: h.set_hits || 0,
        todayErr: h.errors || 0,
        moduleText: buildModule(origin, t.token),
        pickerUrl: buildPickerUrl(origin, t.token)
      };
    });
    return json(res, 200, { origin: origin, tokens: rows }), true;
  }

  // ---- 新建 token ----
  if (url.pathname === "/admin/api/tokens" && req.method === "POST") {
    readBody(req).then(function (body) {
      var label = "";
      try { label = String(JSON.parse(body || "{}").label || ""); } catch (e) { label = ""; }
      const t = db.createToken(label.slice(0, 40));
      json(res, 200, {
        id: t.id, token: t.token, label: t.label, status: t.status,
        moduleText: buildModule(origin, t.token),
        pickerUrl: buildPickerUrl(origin, t.token)
      });
    }).catch(function () { json(res, 400, { error: "bad request" }); });
    return true;
  }

  // ---- 改备注 / 停用启用 / 删除 ----
  const m = url.pathname.match(/^\/admin\/api\/tokens\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (req.method === "DELETE") {
      const ok = db.deleteToken(id);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not found" }), true;
    }
    if (req.method === "POST" || req.method === "PATCH") {
      readBody(req).then(function (body) {
        var j = {};
        try { j = JSON.parse(body || "{}"); } catch (e) { return json(res, 400, { error: "bad json" }); }
        const fields = {};
        if (j.label !== undefined) fields.label = String(j.label).slice(0, 40);
        if (j.status !== undefined) fields.status = j.status;
        const ok = db.updateToken(id, fields);
        json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not found" });
      }).catch(function () { json(res, 400, { error: "bad request" }); });
      return true;
    }
  }

  // ---- 看板 ----
  if (url.pathname === "/admin/api/stats" && req.method === "GET") {
    return json(res, 200, db.stats(url.searchParams.get("days"))), true;
  }

  // ---- 日志 ----
  if (url.pathname === "/admin/api/logs" && req.method === "GET") {
    db.flushLogs();
    const out = db.queryLogs({
      tokenId: url.searchParams.get("token_id"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      onlyErrors: url.searchParams.get("errors") === "1",
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset")
    });
    return json(res, 200, out), true;
  }

  // ---- 存储概况（数据库大小 / 行数 / 归档列表） ----
  if (url.pathname === "/admin/api/info" && req.method === "GET") {
    db.flushLogs();
    return json(res, 200, db.info()), true;
  }

  // ---- 下载某个归档文件 ----
  if (url.pathname === "/admin/api/archives/download" && req.method === "GET") {
    const name = url.searchParams.get("f") || "";
    const full = db.archivePathOf(name);
    if (!full) return json(res, 404, { error: "not found" }), true;
    streamArchive(res, full, name);
    return true;
  }

  // ---- 删除某个归档文件 ----
  if (url.pathname === "/admin/api/archives" && req.method === "DELETE") {
    const name = url.searchParams.get("f") || "";
    var ok = false;
    try { ok = db.deleteArchive(name); } catch (e) { ok = false; }
    return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not found" }), true;
  }

  // ---- 手动跑一次归档+清理 ----
  if (url.pathname === "/admin/api/archive/run" && req.method === "POST") {
    db.pruneLogs().then(function (r) {
      json(res, 200, r || { error: "db not ready" });
    }, function (e) {
      json(res, 500, { error: e.message });
    });
    return true;
  }

  // ---- 按时间范围导出当前表 ----
  if (url.pathname === "/admin/api/export" && req.method === "GET") {
    db.flushLogs();
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const fromMs = from ? db.dayStartMs(from) : 0;
    const toMs = to ? db.dayStartMs(to) + 86400000 : Date.now() + 86400000;
    if (!isFinite(fromMs) || !isFinite(toMs) || toMs <= fromMs) {
      return json(res, 400, { error: "bad range" }), true;
    }
    streamExport(res, fromMs, toMs,
      "logs-" + (from || "all") + "_" + (to || "now") + ".csv.gz");
    return true;
  }

  // ---- 收回磁盘空间（重写整个库，慎用） ----
  if (url.pathname === "/admin/api/vacuum" && req.method === "POST") {
    try {
      return json(res, 200, db.vacuum()), true;
    } catch (e) {
      return json(res, 500, { error: e.message }), true;
    }
  }

  return json(res, 404, { error: "not found" }), true;
}

module.exports = {
  enabled: enabled,
  handle: handle,
  buildModule: buildModule,
  ADMIN_TOKEN: ADMIN_TOKEN
};
