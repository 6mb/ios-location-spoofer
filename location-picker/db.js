// 数据层 —— 基于 Node 内置 node:sqlite（Node 24 起免 flag），不引入任何 npm 依赖
//
// 为什么要有数据库：token 原先存在 TOKEN 环境变量里，改一次要重新部署，
// 而管理后台要能「运行时生成/停用/删除 token」，环境变量做不到。
// 坐标也一并从 loc-<hash>.json 搬进来，顺带获得日志与统计能力。
//
// 首次启动会自动迁移：TOKEN 环境变量里的 token 全部入库，
// 对应的 loc-<hash>.json 逐个读进 locations 表。老用户无感知。

const { DatabaseSync } = require("node:sqlite");
const zlib = require("zlib");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// 与 location-spoofer.js 的 DEFAULT_CONFIG 对齐
const DEFAULT = {
  enabled: true,
  latitude: 37.3349,
  longitude: -122.00902,
  altitude: 530,
  horizontalAccuracy: 39,
  verticalAccuracy: 1000
};

// 环境变量一律走这里：非法值回落到默认并告警，绝不让 NaN 流进来。
// TZ_OFFSET_MIN=Asia/Shanghai 这种写法会让 new Date(NaN).toISOString() 直接抛异常，
// 而异常被 flushLogs 的 catch 吞掉 —— 服务看着一切正常，日志功能其实整个瘫了。
function envNum(name, def) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    console.log("环境变量 " + name + "=\"" + raw + "\" 不是合法数字，回落到 " + def);
    return def;
  }
  return v;
}

// Railway 容器跑在 UTC，但看板是给中国用户看的，按 UTC+8 分天/分小时
const TZ_OFFSET_MIN = envNum("TZ_OFFSET_MIN", 480);
// 保留最近 N 个完整月 + 当月。用「月」而不是「天」，是为了让归档文件的边界
// 和删除边界完全对齐 —— 否则一个月会被切成两半，归档文件对不上账。
const LOG_RETENTION_MONTHS = envNum("LOG_RETENTION_MONTHS", 3);
const LOG_MAX_ROWS = envNum("LOG_MAX_ROWS", 500000);
const ARCHIVE_KEEP_MONTHS = envNum("ARCHIVE_KEEP_MONTHS", 24);
const DAILY_RETENTION_DAYS = envNum("DAILY_RETENTION_DAYS", 400);
const ARCHIVE_BATCH = 1000;          // 归档每批行数：批越小，单次产生的垃圾越少
const ARCHIVE_NAME_RE = /^logs-\d{4}-\d{2}\.csv\.gz$/;   // 下载/删除时防目录穿越

var db = null;
var tokenCache = [];      // [{id, token, label, status}]，用于常量时间比对
var dbReady = false;
var dbError = "";
var ARCHIVE_DIR = "";
var DB_PATH = "";

function localParts(ts) {
  const d = new Date(ts + TZ_OFFSET_MIN * 60000);
  return {
    day: d.toISOString().slice(0, 10),
    hour: d.getUTCHours()
  };
}

function dayKey(ts) {
  return localParts(ts).day;
}

// 把「本地日期字符串」换算回 UTC 毫秒区间，供日志时间筛选用
function dayStartMs(dayStr) {
  return Date.parse(dayStr + "T00:00:00Z") - TZ_OFFSET_MIN * 60000;
}

function monthKey(ts) {
  return dayKey(ts).slice(0, 7);           // YYYY-MM
}

// 某个「本地自然月」对应的 UTC 毫秒区间 [start, end)
function monthRange(mk) {
  const y = Number(mk.slice(0, 4));
  const m = Number(mk.slice(5, 7));
  const start = Date.UTC(y, m - 1, 1) - TZ_OFFSET_MIN * 60000;
  const end = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - TZ_OFFSET_MIN * 60000;
  return { start: start, end: end };
}

// 保留窗口的起点：当月往前推 LOG_RETENTION_MONTHS 个整月的月初
function retentionCutoffMs() {
  const nowLocal = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  const y = nowLocal.getUTCFullYear();
  const m = nowLocal.getUTCMonth();        // 0-based
  return Date.UTC(y, m - LOG_RETENTION_MONTHS, 1) - TZ_OFFSET_MIN * 60000;
}

// ---- schema 版本管理 ----
// 用 PRAGMA user_version 记录已应用到第几版。以后要加字段就往数组尾部追加一个函数，
// 启动时自动补齐 —— 千万别指望 CREATE TABLE IF NOT EXISTS 会去改已存在的表，它是空操作。
const MIGRATIONS = [
  // v1：初始 schema
  function (d) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        token        TEXT    NOT NULL UNIQUE,
        label        TEXT    NOT NULL DEFAULT '',
        status       TEXT    NOT NULL DEFAULT 'active',
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS locations (
        token_id           INTEGER PRIMARY KEY REFERENCES tokens(id) ON DELETE CASCADE,
        enabled            INTEGER NOT NULL DEFAULT 1,
        latitude           REAL    NOT NULL,
        longitude          REAL    NOT NULL,
        altitude           INTEGER NOT NULL,
        horizontalAccuracy INTEGER NOT NULL,
        verticalAccuracy   INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       INTEGER NOT NULL,
        token_id INTEGER NOT NULL DEFAULT 0,
        path     TEXT    NOT NULL,
        status   INTEGER NOT NULL,
        ip       TEXT,
        ua       TEXT,
        detail   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_logs_ts       ON logs(ts);
      CREATE INDEX IF NOT EXISTS idx_logs_token_ts ON logs(token_id, ts);
      CREATE TABLE IF NOT EXISTS daily (
        day      TEXT    NOT NULL,
        token_id INTEGER NOT NULL DEFAULT 0,
        loc_hits INTEGER NOT NULL DEFAULT 0,
        set_hits INTEGER NOT NULL DEFAULT 0,
        errors   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, token_id)
      );
    `);
  },
  // v2：给坐标加一个人能读懂的地址名。只存坐标的话，管理台看到的是
  //     「31.23012, 121.47370」，根本不知道那是哪儿。
  function (d) {
    d.exec("ALTER TABLE locations ADD COLUMN address TEXT NOT NULL DEFAULT ''");
  }
];

function runMigrations() {
  var from = db.prepare("PRAGMA user_version").get().user_version || 0;
  if (from > MIGRATIONS.length) {
    // 回滚到旧镜像时会走到这里：库比代码新，旧 SQL 对着新表跑，行为不可预期
    console.log(
      "⚠️  数据库 schema 是 v" + from + "，而本版代码只到 v" + MIGRATIONS.length +
      " —— 大概率是回滚到了旧版本镜像，请改用与数据库匹配的版本。"
    );
    return from;
  }
  if (from === MIGRATIONS.length) return from;
  for (var i = from; i < MIGRATIONS.length; i += 1) {
    db.exec("BEGIN");
    try {
      MIGRATIONS[i](db);
      db.exec("PRAGMA user_version = " + (i + 1));   // PRAGMA 不支持参数绑定，这里是常量拼接
      db.exec("COMMIT");
    } catch (e) {
      // 不能裸着 ROLLBACK：SQLite 遇到某些错误（磁盘满、I/O 错误）会自动回滚，
      // 这时再显式回滚会抛 "cannot rollback - no transaction is active"，
      // 把真正的原因顶掉，运维在日志里只能看到一条完全误导的信息。
      try { db.exec("ROLLBACK"); } catch (e2) { /* 可能已自动回滚 */ }
      throw new Error("schema 迁移到 v" + (i + 1) + " 失败：" + e.message);
    }
  }
  console.log("schema 已从 v" + from + " 升级到 v" + MIGRATIONS.length);
  return MIGRATIONS.length;
}

function init(dataDir) {
  DB_PATH = path.join(dataDir, "app.db");
  ARCHIVE_DIR = path.join(dataDir, "archive");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    // WAL：读写不互相阻塞；NORMAL：容器崩溃最多丢最后几条日志，换来少一个数量级的 fsync
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations();
    dbReady = true;
    reloadTokens();
  } catch (e) {
    dbError = e.message;
    console.error("数据库初始化失败：" + e.message);
    throw e;
  }
  return DB_PATH;
}

// 预编译语句缓存：node:sqlite 的 prepare() 会分配一个 sqlite3_stmt，
// 每次查询都新建等于把它们攒着不放（导出一次就建上百条）。SQL 文本天然就是缓存键。
var stmtCache = new Map();
function prep(sql) {
  var st = stmtCache.get(sql);
  if (!st) { st = db.prepare(sql); stmtCache.set(sql, st); }
  return st;
}

function reloadTokens() {
  tokenCache = db
    .prepare("SELECT id, token, label, status FROM tokens ORDER BY id")
    .all();
}

// ---- 迁移：环境变量 TOKEN + loc-<hash>.json -> 数据库 ----
function migrateFromEnv(envTokens, dataDir, dataBase) {
  var imported = 0;
  var seeded = 0;
  const now = Date.now();
  const insert = prep(
    "INSERT OR IGNORE INTO tokens (token, label, status, created_at) VALUES (?, ?, 'active', ?)"
  );
  for (var i = 0; i < envTokens.length; i += 1) {
    const t = envTokens[i];
    const r = insert.run(t, "", now);
    if (r.changes > 0) seeded += 1;
  }
  reloadTokens();

  // 老的单 token 文件 loc.json 归给列表里的第一个 token
  const legacy = path.join(dataDir, dataBase + ".json");
  for (var j = 0; j < tokenCache.length; j += 1) {
    const row = tokenCache[j];
    if (getLocationRow(row.id)) continue;      // 已有坐标，不覆盖
    const hash = crypto.createHash("sha256").update(row.token).digest("hex").slice(0, 16);
    var candidates = [path.join(dataDir, dataBase + "-" + hash + ".json")];
    if (j === 0) candidates.push(legacy);
    for (var k = 0; k < candidates.length; k += 1) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidates[k], "utf8"));
        writeLocation(row.id, Object.assign({}, DEFAULT, parsed));
        imported += 1;
        break;
      } catch (e) { /* 文件不存在或损坏，跳过用默认值 */ }
    }
  }
  if (seeded || imported) {
    console.log("已从环境变量迁移 " + seeded + " 个 token，导入 " + imported + " 份历史坐标");
  }
  return { seeded: seeded, imported: imported };
}

// ---- token ----
function listTokens() {
  return db
    .prepare("SELECT id, token, label, status, created_at, last_seen_at FROM tokens ORDER BY id")
    .all();
}

function cachedTokens() {
  return tokenCache;
}

function createToken(label) {
  const token = crypto.randomBytes(24).toString("hex");
  const r = db
    .prepare("INSERT INTO tokens (token, label, status, created_at) VALUES (?, ?, 'active', ?)")
    .run(token, String(label || ""), Date.now());
  reloadTokens();
  return { id: Number(r.lastInsertRowid), token: token, label: String(label || ""), status: "active" };
}

function updateToken(id, fields) {
  const sets = [];
  const args = [];
  if (fields.label !== undefined) { sets.push("label = ?"); args.push(String(fields.label)); }
  if (fields.status !== undefined) {
    sets.push("status = ?");
    args.push(fields.status === "disabled" ? "disabled" : "active");
  }
  if (!sets.length) return false;
  args.push(id);
  const stmt = prep("UPDATE tokens SET " + sets.join(", ") + " WHERE id = ?");
  const r = stmt.run.apply(stmt, args);
  reloadTokens();
  return r.changes > 0;
}

function deleteToken(id) {
  // 坐标随 token 走（ON DELETE CASCADE）；日志和统计都保留，归到 token_id = 0「已删除」名下。
  //
  // 必须先确认真的删掉了才做后面两步 —— 否则 deleteToken(0) 会让第三步把所有匿名请求
  // （口令错误、没带 token）的每日聚合全抹掉，而接口只回一个 404，谁都发现不了。
  db.exec("BEGIN");
  try {
    const r = prep("DELETE FROM tokens WHERE id = ?").run(id);
    if (r.changes === 0) { db.exec("ROLLBACK"); return false; }
    prep("UPDATE logs SET token_id = 0 WHERE token_id = ?").run(id);
    // daily 的主键是 (day, token_id)，同一天可能已经有 token_id=0 的行，得合并而不是改主键
    prep(
      "INSERT INTO daily (day, token_id, loc_hits, set_hits, errors)" +
      " SELECT day, 0, loc_hits, set_hits, errors FROM daily WHERE token_id = ?" +
      " ON CONFLICT(day, token_id) DO UPDATE SET loc_hits = loc_hits + excluded.loc_hits," +
      " set_hits = set_hits + excluded.set_hits, errors = errors + excluded.errors"
    ).run(id);
    prep("DELETE FROM daily WHERE token_id = ?").run(id);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (e2) { /* 可能已自动回滚 */ }
    throw e;
  }
  reloadTokens();
  return true;
}

function touchToken(id, ts) {
  try {
    prep("UPDATE tokens SET last_seen_at = ? WHERE id = ?").run(ts, id);
  } catch (e) { /* 心跳字段，失败不影响主流程 */ }
}

// ---- 坐标 ----
function getLocationRow(tokenId) {
  return prep("SELECT * FROM locations WHERE token_id = ?").get(tokenId);
}

function readLocation(tokenId) {
  const row = getLocationRow(tokenId);
  if (!row) return Object.assign({}, DEFAULT);
  return {
    enabled: !!row.enabled,
    latitude: row.latitude,
    longitude: row.longitude,
    altitude: row.altitude,
    horizontalAccuracy: row.horizontalAccuracy,
    verticalAccuracy: row.verticalAccuracy,
    address: row.address || ""
  };
}

function writeLocation(tokenId, obj) {
  const v = Object.assign({}, DEFAULT, obj);
  // 坐标没变就保留原地址（比如只是切了「伪造开关」）；坐标一变，旧地址立刻作废，
  // 置空等 resolveAddress 异步补上 —— 绝不能让「新坐标 + 旧地址」这种组合出现在管理台。
  const prev = getLocationRow(tokenId);
  const same = prev && prev.latitude === v.latitude && prev.longitude === v.longitude;
  const addr = typeof v.address === "string" ? v.address : (same ? (prev.address || "") : "");
  prep(
    "INSERT INTO locations (token_id, enabled, latitude, longitude, altitude, horizontalAccuracy, verticalAccuracy, address, updated_at)" +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)" +
    " ON CONFLICT(token_id) DO UPDATE SET enabled=excluded.enabled, latitude=excluded.latitude," +
    " longitude=excluded.longitude, altitude=excluded.altitude," +
    " horizontalAccuracy=excluded.horizontalAccuracy, verticalAccuracy=excluded.verticalAccuracy," +
    " address=excluded.address, updated_at=excluded.updated_at"
  ).run(
    tokenId, v.enabled ? 1 : 0, v.latitude, v.longitude,
    Math.round(v.altitude), Math.round(v.horizontalAccuracy), Math.round(v.verticalAccuracy),
    addr, Date.now()
  );
  v.address = addr;
  return v;
}

// 异步逆解的结果回写。条件里带上坐标 —— 用户连点两个点时，先发的请求可能后返回，
// 匹配不上当前坐标就自动作废，不会把新点的地址覆盖成旧点的。不用加锁。
function setAddressIfCoordsMatch(tokenId, lat, lng, address) {
  const r = prep(
    "UPDATE locations SET address = ? WHERE token_id = ? AND latitude = ? AND longitude = ?"
  ).run(String(address || "").slice(0, 200), tokenId, lat, lng);
  return r.changes > 0;
}

// ---- 日志 ----
// /loc.json 会被每台设备反复拉取，一条一次 fsync 太浪费。
// 先攒进内存，每 2 秒一个事务批量落盘；进程退出前再冲一次。
var logBuf = [];
var flushTimer = null;

function logRequest(entry) {
  logBuf.push(entry);
  if (logBuf.length >= 200) flushLogs();
}

function flushLogs() {
  if (!dbReady || !logBuf.length) return;
  const batch = logBuf;
  logBuf = [];
  try {
    const insLog = prep(
      "INSERT INTO logs (ts, token_id, path, status, ip, ua, detail) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const bumpDaily = prep(
      "INSERT INTO daily (day, token_id, loc_hits, set_hits, errors) VALUES (?, ?, ?, ?, ?)" +
      " ON CONFLICT(day, token_id) DO UPDATE SET loc_hits = loc_hits + excluded.loc_hits," +
      " set_hits = set_hits + excluded.set_hits, errors = errors + excluded.errors"
    );
    db.exec("BEGIN");
    for (var i = 0; i < batch.length; i += 1) {
      const e = batch[i];
      insLog.run(e.ts, e.tokenId || 0, e.path, e.status, e.ip || null, e.ua || null, e.detail || null);
      const isErr = e.status >= 400 ? 1 : 0;
      const isLoc = e.path === "/loc.json" && !isErr ? 1 : 0;
      const isSet = (e.path === "/set" || e.path === "/enable") && !isErr ? 1 : 0;
      if (isErr || isLoc || isSet) {
        bumpDaily.run(dayKey(e.ts), e.tokenId || 0, isLoc, isSet, isErr);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch (e2) { /* 事务可能已回滚 */ }
    console.log("写日志失败（不影响主流程）：" + err.message);
  }
}

function startLogFlusher() {
  if (flushTimer) return;
  flushTimer = setInterval(flushLogs, 2000);
  if (flushTimer.unref) flushTimer.unref();
}

// ---- 归档 ----
// CSV 里把 label 一起写进去（反规范化），这样归档文件即使在 token 删掉之后
// 也能独立读懂，不用再回头对着数据库翻 id。
const CSV_HEADER = "ts,time_local,token_id,label,path,status,ip,ua,detail\n";

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const t = String(v);
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function localStamp(ts) {
  return new Date(ts + TZ_OFFSET_MIN * 60000).toISOString().replace("T", " ").slice(0, 19);
}

function archiveFile(mk) {
  return path.join(ARCHIVE_DIR, "logs-" + mk + ".csv.gz");
}

// 取一批日志（id 游标翻页），归档和导出共用
function fetchLogBatch(fromMs, toMs, afterId, limit) {
  return prep(
    "SELECT l.id, l.ts, l.token_id, l.path, l.status, l.ip, l.ua, l.detail, t.label" +
    " FROM logs l LEFT JOIN tokens t ON t.id = l.token_id" +
    " WHERE l.ts >= ? AND l.ts < ? AND l.id > ? ORDER BY l.id LIMIT ?"
  ).all(fromMs, toMs, afterId, limit);
}

function rowsToCsv(rows) {
  var out = "";
  for (var i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    out += [
      r.ts, localStamp(r.ts), r.token_id, csvCell(r.label), csvCell(r.path),
      r.status, csvCell(r.ip), csvCell(r.ua), csvCell(r.detail)
    ].join(",") + "\n";
  }
  return out;
}

// 把 [fromMs, toMs) 的日志压进 logs-<mk>.csv.gz。
// 先写到 .tmp，全部成功才合并进正式文件 —— 中途出错不会在归档里留半截数据。
// 逐批 gzip 并立即落盘，内存上界是「一批」而不是「一个月」。
// gzip 允许多个数据块首尾相接，解压出来仍是一个完整文件，所以追加是安全的。
//
// 必须是异步的：整批取行 + gzip + 写盘全是同步调用，50 万行连着做会把事件循环占死好几秒，
// 期间所有人的 /loc.json 都在排队。每批之间 setImmediate 让一次，和 streamExport 同一个套路。
function archiveRange(fromMs, toMs, mk) {
  const file = archiveFile(mk);
  const tmp = file + ".tmp";
  const needHeader = !fs.existsSync(file);
  var total = 0;
  var fd = null;
  var afterId = 0;
  var first = true;

  function cleanup() {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 忽略 */ } fd = null; }
    try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
  }

  return new Promise(function (resolve, reject) {
    try { fs.unlinkSync(tmp); } catch (e) { /* 上次异常残留，清掉 */ }

    function step() {
      try {
        const rows = fetchLogBatch(fromMs, toMs, afterId, ARCHIVE_BATCH);
        if (rows.length) {
          afterId = rows[rows.length - 1].id;
          var text = rowsToCsv(rows);
          if (first && needHeader) text = CSV_HEADER + text;
          first = false;
          if (fd === null) fd = fs.openSync(tmp, "w");
          fs.writeSync(fd, zlib.gzipSync(Buffer.from(text, "utf8"), { level: 6 }));
          total += rows.length;
          if (rows.length === ARCHIVE_BATCH) return setImmediate(step);   // 还有，让一次再继续
        }
        // 取完了：收尾
        if (fd !== null) { fs.closeSync(fd); fd = null; }
        if (!total) { try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ } return resolve(0); }
        if (needHeader) {
          fs.renameSync(tmp, file);        // 首次：直接改名，零拷贝
        } else {
          appendFile(file, tmp);           // 追加：分块拷贝，不整个读进内存
          fs.unlinkSync(tmp);
        }
        resolve(total);
      } catch (e) {
        cleanup();
        reject(e);
      }
    }
    step();
  });
}

// 分块把 src 追加到 dest，缓冲区固定 1MB，与文件大小无关
function appendFile(dest, src) {
  const buf = Buffer.allocUnsafe(1024 * 1024);
  const rfd = fs.openSync(src, "r");
  const wfd = fs.openSync(dest, "a");
  try {
    for (;;) {
      const n = fs.readSync(rfd, buf, 0, buf.length, null);
      if (n <= 0) break;
      fs.writeSync(wfd, buf, 0, n);
    }
  } finally {
    fs.closeSync(rfd);
    fs.closeSync(wfd);
  }
}

function listArchives() {
  try {
    return fs.readdirSync(ARCHIVE_DIR)
      .filter(function (n) { return ARCHIVE_NAME_RE.test(n); })
      .map(function (n) {
        const st = fs.statSync(path.join(ARCHIVE_DIR, n));
        return { name: n, month: n.slice(5, 12), bytes: st.size, mtime: st.mtimeMs };
      })
      .sort(function (a, b) { return a.month < b.month ? 1 : -1; });
  } catch (e) {
    return [];
  }
}

// 只接受 logs-YYYY-MM.csv.gz 这一种文件名，杜绝 ../ 之类的目录穿越
function archivePathOf(name) {
  if (!ARCHIVE_NAME_RE.test(String(name))) return null;
  const full = path.join(ARCHIVE_DIR, name);
  if (path.dirname(full) !== ARCHIVE_DIR) return null;
  return fs.existsSync(full) ? full : null;
}

function deleteArchive(name) {
  const full = archivePathOf(name);
  if (!full) return false;
  fs.unlinkSync(full);
  return true;
}

function pruneArchives() {
  const list = listArchives();               // 已按月份倒序
  var removed = 0;
  for (var i = ARCHIVE_KEEP_MONTHS; i < list.length; i += 1) {
    try { fs.unlinkSync(path.join(ARCHIVE_DIR, list[i].name)); removed += 1; } catch (e) { /* 忽略 */ }
  }
  return removed;
}

// ---- 清理：先归档，再删除，且只删已归档成功的 ----
// 现在是 async 的（见 archiveRange 的注释），所以必须防重入：
// 定时任务和管理台的「立即归档」按钮可能同时进来，两个并发的归档会写同一个 .tmp。
var pruning = false;
var lastPruneError = "";

async function pruneLogs() {
  if (!dbReady) return null;
  if (pruning) return { busy: true, archivedRows: 0, deletedRows: 0, months: [], days: 0, archivesRemoved: 0 };
  pruning = true;
  const result = { archivedRows: 0, deletedRows: 0, months: [], days: 0, archivesRemoved: 0 };
  try {
    flushLogs();

    // 1) 早于保留窗口的完整月：整月归档 → 整月删除
    const cutoff = retentionCutoffMs();
    for (var guard = 0; guard < 240; guard += 1) {
      const oldest = prep("SELECT MIN(ts) AS t FROM logs").get().t;
      if (oldest == null || oldest >= cutoff) break;
      const mk = monthKey(oldest);
      const r = monthRange(mk);
      const end = Math.min(r.end, cutoff);
      const n = await archiveRange(r.start, end, mk);    // 失败会抛，下面的删除不会执行
      const d = prep("DELETE FROM logs WHERE ts >= ? AND ts < ?").run(r.start, end);
      result.archivedRows += n;
      result.deletedRows += d.changes;
      result.months.push(mk);
      if (d.changes === 0) break;                        // 保险：避免异常情况下空转
    }

    // 2) 行数硬上限：粒度降到「整天」，同样先归档再删，追加进当月的归档文件。
    //    绝不碰当前这一天 —— 否则某天流量异常把表冲爆时，会连几秒钟前刚写的日志一起删掉，
    //    结果是「日志页一条没有，KPI 却显示几十万」，恰好把排查现场毁掉。宁可暂时超上限。
    const todayStart = dayStartMs(dayKey(Date.now()));
    var count = prep("SELECT COUNT(*) AS c FROM logs").get().c;
    for (var g2 = 0; count > LOG_MAX_ROWS && g2 < 400; g2 += 1) {
      const o = prep("SELECT MIN(ts) AS t FROM logs").get().t;
      if (o == null) break;
      const ds = dayStartMs(dayKey(o));
      if (ds >= todayStart) break;
      const de = ds + 86400000;
      const n2 = await archiveRange(ds, de, monthKey(o));
      const d2 = prep("DELETE FROM logs WHERE ts >= ? AND ts < ?").run(ds, de);
      if (d2.changes === 0) break;
      result.archivedRows += n2;
      result.deletedRows += d2.changes;
      result.days += 1;
      count -= d2.changes;
    }

    // 3) daily 预聚合表：它很小，留得比明细久，看板的历史曲线不会因为清明细而断掉
    prep("DELETE FROM daily WHERE day < ?")
      .run(dayKey(Date.now() - DAILY_RETENTION_DAYS * 86400000));

    // 4) 归档目录本身也有上限
    result.archivesRemoved = pruneArchives();

    if (result.deletedRows) {
      console.log(
        "日志清理：归档 " + result.archivedRows + " 行（" +
        (result.months.join(",") || result.days + " 天") + "），删除 " + result.deletedRows + " 行"
      );
    }
    lastPruneError = "";
  } catch (e) {
    // 归档失败时数据一行都没删，下次重试。但必须把错误往上报：
    // 以前这里只 console.log 然后照常返回全 0 的 result，管理台看到 deletedRows=0
    // 就弹「没有需要清理的数据」—— 磁盘写满了你完全看不出来。
    lastPruneError = e.message;
    result.error = e.message;
    console.log("清理日志失败（数据未删除，下次重试）：" + e.message);
  } finally {
    pruning = false;
  }
  return result;
}

// 手动收回磁盘：DELETE 只把页标记为可复用，文件大小不会回落。
// VACUUM 会重写整个库，耗时且期间锁库，所以只做成按钮，不放进定时任务。
function vacuum() {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");   // 先把 WAL 并回主库，否则量的是「主库+WAL」，数字没意义
  const before = dbBytes();
  stmtCache.clear();                            // VACUUM 会重写整个库，缓存的语句丢掉更稳妥
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");   // VACUUM 本身也是写在 WAL 里的，再并一次
  const after = dbBytes();
  return { before: before, after: after, freed: before - after };
}

function dbBytes() {
  var total = 0;
  [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"].forEach(function (f) {
    try { total += fs.statSync(f).size; } catch (e) { /* 文件可能不存在 */ }
  });
  return total;
}

function info() {
  const archives = listArchives();
  const mem = process.memoryUsage();
  return {
    dbFile: DB_PATH,
    dbBytes: dbBytes(),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    uptimeSec: Math.round(process.uptime()),
    schemaVersion: db.prepare("PRAGMA user_version").get().user_version,
    logRows: prep("SELECT COUNT(*) AS c FROM logs").get().c,
    oldestLog: prep("SELECT MIN(ts) AS t FROM logs").get().t,
    dailyRows: prep("SELECT COUNT(*) AS c FROM daily").get().c,
    lastPruneError: lastPruneError,
    retentionMonths: LOG_RETENTION_MONTHS,
    maxRows: LOG_MAX_ROWS,
    archiveKeepMonths: ARCHIVE_KEEP_MONTHS,
    archives: archives,
    archiveBytes: archives.reduce(function (a, b) { return a + b.bytes; }, 0)
  };
}

// 干净关闭：把 WAL 归档回主库，Railway 重新部署（SIGTERM）时不留半截事务
function close() {
  try { flushLogs(); } catch (e) { /* 退出路径，尽力而为 */ }
  stmtCache.clear();
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { /* 同上 */ }
  try { db.close(); } catch (e) { /* 同上 */ }
}

function queryLogs(opts) {
  const where = [];
  const args = [];
  if (opts.tokenId != null && opts.tokenId !== "") { where.push("l.token_id = ?"); args.push(Number(opts.tokenId)); }
  if (opts.from) { where.push("l.ts >= ?"); args.push(dayStartMs(opts.from)); }
  if (opts.to) { where.push("l.ts < ?"); args.push(dayStartMs(opts.to) + 86400000); }
  if (opts.onlyErrors) { where.push("l.status >= 400"); }
  const clause = where.length ? " WHERE " + where.join(" AND ") : "";
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const countStmt = prep("SELECT COUNT(*) AS c FROM logs l" + clause);
  const total = countStmt.get.apply(countStmt, args).c;

  const rowStmt = prep(
    "SELECT l.id, l.ts, l.token_id, l.path, l.status, l.ip, l.ua, l.detail, t.label" +
    " FROM logs l LEFT JOIN tokens t ON t.id = l.token_id" + clause +
    " ORDER BY l.id DESC LIMIT ? OFFSET ?"
  );
  const rows = rowStmt.all.apply(rowStmt, args.concat([limit, offset]));
  return { total: total, rows: rows, limit: limit, offset: offset };
}

// ---- 看板统计 ----
function stats(days) {
  flushLogs();  // 先把内存里的日志落盘，看板才是「刚才那一下」也算数的
  const n = Math.min(Math.max(Number(days) || 7, 1), 90);
  const today = dayKey(Date.now());
  const since = dayKey(Date.now() - (n - 1) * 86400000);
  const sinceMs = dayStartMs(since);

  const tokens = listTokens();
  const active = tokens.filter(function (t) { return t.status === "active"; }).length;

  // 按天趋势（用预聚合表，不扫原始日志）
  const trendRows = prep(
    "SELECT day, SUM(loc_hits) AS loc, SUM(set_hits) AS \"set\", SUM(errors) AS err" +
    " FROM daily WHERE day >= ? GROUP BY day ORDER BY day"
  ).all(since);
  const trendMap = {};
  trendRows.forEach(function (r) { trendMap[r.day] = r; });
  const trend = [];
  for (var i = n - 1; i >= 0; i -= 1) {
    const d = dayKey(Date.now() - i * 86400000);
    const r = trendMap[d] || {};
    trend.push({ day: d, loc: r.loc || 0, set: r["set"] || 0, err: r.err || 0 });
  }

  // 今日 KPI
  const todayRow = prep(
    "SELECT SUM(loc_hits) AS loc, SUM(set_hits) AS \"set\", SUM(errors) AS err," +
    " COUNT(DISTINCT CASE WHEN token_id > 0 THEN token_id END) AS actives" +
    " FROM daily WHERE day = ?"
  ).get(today) || {};

  // 24 小时分布。交给 SQLite 分桶，最多返回 24 行 —— 千万别 .all() 再在 JS 里数：
  // 十几台设备持续拉定位，今天就能有二三十万行，每点一次「刷新」就同步分配那么多对象。
  const hours = new Array(24).fill(0);
  prep(
    "SELECT ((ts + ?) / 3600000) % 24 AS h, COUNT(*) AS c FROM logs" +
    " WHERE ts >= ? AND status < 400 GROUP BY h"
  ).all(TZ_OFFSET_MIN * 60000, dayStartMs(today))
    .forEach(function (r) { hours[Number(r.h)] = Number(r.c); });

  // Token 活跃排行
  const top = prep(
    "SELECT d.token_id AS id, t.label, t.token, SUM(d.loc_hits) AS loc, SUM(d.set_hits) AS \"set\"" +
    " FROM daily d LEFT JOIN tokens t ON t.id = d.token_id" +
    " WHERE d.day >= ? AND d.token_id > 0 GROUP BY d.token_id" +
    " ORDER BY (SUM(d.loc_hits) + SUM(d.set_hits)) DESC LIMIT 10"
  ).all(since);

  // 错误构成
  const errors = prep(
    "SELECT status, COUNT(*) AS c FROM logs WHERE ts >= ? AND status >= 400 GROUP BY status ORDER BY c DESC"
  ).all(sinceMs);

  // 疑似 token 配错：同一 IP 在窗口内 403 次数异常多
  const suspects = prep(
    "SELECT ip, COUNT(*) AS c, MAX(ts) AS last_ts FROM logs" +
    " WHERE ts >= ? AND status = 403 AND ip IS NOT NULL" +
    " GROUP BY ip HAVING c >= 10 ORDER BY c DESC LIMIT 5"
  ).all(sinceMs);

  return {
    days: n,
    tokenTotal: tokens.length,
    tokenActive: active,
    tokenDisabled: tokens.length - active,
    todayActive: todayRow.actives || 0,
    todayLoc: todayRow.loc || 0,
    todaySet: todayRow["set"] || 0,
    todayErr: todayRow.err || 0,
    trend: trend,
    hours: hours,
    top: top,
    errors: errors,
    suspects: suspects
  };
}

module.exports = {
  DEFAULT: DEFAULT,
  TZ_OFFSET_MIN: TZ_OFFSET_MIN,
  LOG_RETENTION_MONTHS: LOG_RETENTION_MONTHS,
  LOG_MAX_ROWS: LOG_MAX_ROWS,
  init: init,
  raw: function () { return db; },
  ready: function () { return dbReady; },
  error: function () { return dbError; },
  dayKey: dayKey,
  localParts: localParts,
  dayStartMs: dayStartMs,
  migrateFromEnv: migrateFromEnv,
  listTokens: listTokens,
  cachedTokens: cachedTokens,
  createToken: createToken,
  updateToken: updateToken,
  deleteToken: deleteToken,
  touchToken: touchToken,
  readLocation: readLocation,
  writeLocation: writeLocation,
  setAddressIfCoordsMatch: setAddressIfCoordsMatch,
  logRequest: logRequest,
  flushLogs: flushLogs,
  startLogFlusher: startLogFlusher,
  pruneLogs: pruneLogs,
  queryLogs: queryLogs,
  stats: stats,
  close: close,
  fetchLogBatch: fetchLogBatch,
  rowsToCsv: rowsToCsv,
  CSV_HEADER: CSV_HEADER,
  ARCHIVE_BATCH: ARCHIVE_BATCH,
  listArchives: listArchives,
  archivePathOf: archivePathOf,
  deleteArchive: deleteArchive,
  vacuum: vacuum,
  info: info
};
