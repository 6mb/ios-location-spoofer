// 管理后台页面 —— 单页四个 tab：Token 管理 / 数据看板 / 访问日志 / 归档
// 图表全部用手写 SVG，不引第三方图表库：省内存、省加载，国内网络也不依赖 CDN。

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>定位服务管理台</title>
<style>
  :root{
    --bg:#f2f2f7; --card:#fff; --line:#e5e5ea; --text:#1c1c1e; --dim:#8e8e93;
    --blue:#007aff; --green:#34c759; --red:#ff3b30; --orange:#ff9500; --purple:#5856d6;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#000; --card:#1c1c1e; --line:#2c2c2e; --text:#f2f2f7; --dim:#8e8e93; }
  }
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px}
  header{position:sticky;top:0;z-index:10;background:var(--bg);
    border-bottom:1px solid var(--line);padding:10px 12px 0}
  h1{margin:0 0 8px;font-size:19px;font-weight:700}
  .tabs{display:flex;gap:4px}
  .tabs button{flex:1;padding:9px 4px;font-size:14px;border:0;border-radius:8px 8px 0 0;
    background:transparent;color:var(--dim);font-weight:600}
  .tabs button.on{color:var(--blue);background:var(--card)}
  main{padding:12px;max-width:900px;margin:0 auto}
  .pane{display:none}.pane.on{display:block}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;
    padding:12px;margin-bottom:10px}
  .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .grow{flex:1;min-width:0}
  .muted{color:var(--dim);font-size:13px}
  .addr{font-size:14px;margin:2px 0 4px;line-height:1.4}
  .card.err{border-color:#ff3b30;color:#ff3b30}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
  .badge{font-size:11px;padding:2px 7px;border-radius:99px;font-weight:600;white-space:nowrap}
  .b-on{background:rgba(52,199,89,.15);color:var(--green)}
  .b-off{background:rgba(142,142,147,.2);color:var(--dim)}
  .b-real{background:rgba(255,149,0,.15);color:var(--orange)}
  button.act{padding:8px 12px;font-size:14px;border:0;border-radius:8px;
    background:var(--blue);color:#fff;font-weight:600}
  button.act.g{background:var(--green)} button.act.r{background:var(--red)}
  button.act.s{background:var(--dim)} button.act.p{background:var(--purple)}
  button.act:disabled{opacity:.5}
  input,select{padding:8px 10px;font-size:15px;border:1px solid var(--line);
    border-radius:8px;background:var(--card);color:var(--text)}
  input[type=date]{font-size:14px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px;margin-bottom:10px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px}
  .kpi .v{font-size:22px;font-weight:700;line-height:1.15}
  .kpi .k{font-size:12px;color:var(--dim);margin-top:2px}
  .kpi.warn .v{color:var(--red)}
  h2{font-size:14px;margin:0 0 8px;color:var(--dim);font-weight:600}
  svg{display:block;width:100%;overflow:visible}
  .legend{display:flex;gap:12px;font-size:12px;color:var(--dim);margin-top:6px;flex-wrap:wrap}
  .legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-weight:600;font-size:12px}
  .wrap{overflow-x:auto}
  .st-ok{color:var(--green)} .st-bad{color:var(--red)}
  .alert{background:rgba(255,59,48,.12);border:1px solid rgba(255,59,48,.3);
    color:var(--red);border-radius:12px;padding:10px 12px;margin-bottom:10px;font-size:13px}
  .toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
    background:rgba(0,0,0,.86);color:#fff;padding:10px 16px;border-radius:9px;
    font-size:14px;opacity:0;transition:opacity .25s;pointer-events:none;z-index:99}
  .toast.show{opacity:1}
</style>
</head>
<body>
<header>
  <h1>定位服务管理台</h1>
  <div class="tabs">
    <button data-t="tokens" class="on">Token</button>
    <button data-t="dash">看板</button>
    <button data-t="logs">日志</button>
    <button data-t="arch">归档</button>
  </div>
</header>
<main>
  <div class="pane on" id="p-tokens">
    <div class="card">
      <div class="row">
        <input id="newlabel" class="grow" placeholder="备注名（如：老王）" maxlength="40">
        <button class="act g" id="newbtn">生成 Token</button>
      </div>
    </div>
    <div id="tokenlist"><div class="muted">加载中…</div></div>
  </div>

  <div class="pane" id="p-dash">
    <div class="row" style="margin-bottom:10px">
      <span class="muted">统计范围</span>
      <select id="days"><option value="7">近 7 天</option><option value="30">近 30 天</option></select>
      <button class="act s" id="refresh">刷新</button>
    </div>
    <div id="dash"><div class="muted">加载中…</div></div>
  </div>

  <div class="pane" id="p-arch">
    <div id="storage"><div class="muted">加载中…</div></div>
    <div class="card">
      <h2>导出当前表</h2>
      <div class="row">
        <input type="date" id="e-from"><span class="muted">→</span><input type="date" id="e-to">
        <button class="act" id="e-go">导出 .csv.gz</button>
      </div>
      <div class="muted" style="margin-top:6px">留空 = 全部。文件流式生成，多大都不占内存。</div>
    </div>
    <div class="card">
      <h2>归档文件</h2>
      <div id="archlist" class="muted">加载中…</div>
    </div>
    <div class="card">
      <h2>维护</h2>
      <div class="row">
        <button class="act s" id="m-run">立即归档并清理</button>
        <button class="act s" id="m-vac">压缩数据库</button>
      </div>
      <div class="muted" style="margin-top:6px">
        清理每 6 小时自动跑一次，这里只是手动触发。<br>
        「压缩数据库」会重写整个库来收回已删除数据占的磁盘，期间服务会短暂卡顿，平时不用点。
      </div>
    </div>
  </div>

  <div class="pane" id="p-logs">
    <div class="card">
      <div class="row">
        <select id="f-token"><option value="">全部 Token</option></select>
        <input type="date" id="f-from"><span class="muted">→</span><input type="date" id="f-to">
        <label class="muted row" style="gap:4px"><input type="checkbox" id="f-err" style="width:auto">仅错误</label>
        <button class="act" id="f-go">查询</button>
      </div>
    </div>
    <div id="logs"><div class="muted">选择条件后查询</div></div>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
var ADMIN = new URLSearchParams(location.search).get("token") || "";
var tokensCache = [];

function $(id){ return document.getElementById(id); }
// 单引号和反引号也要转 —— 当前所有插值点用的都是双引号属性，不转也没事，
// 但这函数是全页公用的，将来谁写成 data-x='...' 就能被 ip / detail 里的内容逃逸出去。
function esc(s){ return String(s==null?"":s).replace(/[&<>"'\x60]/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;","\x60":"&#96;"}[c]; }); }
function toast(t){ var e=$("toast"); e.textContent=t; e.classList.add("show");
  clearTimeout(e._t); e._t=setTimeout(function(){ e.classList.remove("show"); },1800); }

function api(path, opts){
  opts = opts || {};
  var sep = path.indexOf("?") >= 0 ? "&" : "?";
  return fetch(path + sep + "token=" + encodeURIComponent(ADMIN), {
    method: opts.method || "GET",
    headers: opts.body ? {"Content-Type":"application/json"} : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  }).then(function(r){
    if(!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
}

// iOS Safari 的 clipboard API 只在 https + 用户手势下可用；这里都满足，
// 但老版本 Safari 仍可能静默失败，所以保留 textarea + execCommand 兜底。
function copy(text, okMsg){
  function fallback(){
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly","");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch(e){ ok = false; }
    document.body.removeChild(ta);
    toast(ok ? okMsg : "复制失败，请长按手动复制");
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){ toast(okMsg); }, fallback);
  } else { fallback(); }
}

function ago(ts){
  if(!ts) return "从未";
  var s = Math.floor((Date.now() - ts) / 1000);
  if(s < 60) return s + " 秒前";
  if(s < 3600) return Math.floor(s/60) + " 分钟前";
  if(s < 86400) return Math.floor(s/3600) + " 小时前";
  return Math.floor(s/86400) + " 天前";
}
function fmtTime(ts){
  var d = new Date(ts);
  function p(n){ return (n<10?"0":"") + n; }
  return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + " " +
         p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function mask(t){ return t.slice(0,6) + "…" + t.slice(-4); }

// ---------- Tab 1：Token 管理 ----------
function renderTokens(list){
  tokensCache = list;
  var sel = $("f-token");
  sel.innerHTML = '<option value="">全部 Token</option>' +
    list.map(function(t){
      return '<option value="' + t.id + '">' + esc(t.label || mask(t.token)) + '</option>';
    }).join("") + '<option value="0">（无效 / 已删除的 token）</option>';

  if(!list.length){ $("tokenlist").innerHTML = '<div class="muted">还没有 token，点上面生成一个。</div>'; return; }

  $("tokenlist").innerHTML = list.map(function(t){
    var loc = t.location || {};
    var live = t.status === "active";
    var badge = !live ? '<span class="badge b-off">已停用</span>'
      : (loc.enabled ? '<span class="badge b-on">伪造中</span>'
                     : '<span class="badge b-real">真实定位</span>');
    return '<div class="card" data-id="' + t.id + '">' +
      '<div class="row"><div class="grow"><b>' + esc(t.label || "（未命名）") + '</b></div>' + badge + '</div>' +
      '<div class="muted mono" style="margin:6px 0">' + esc(mask(t.token)) + '</div>' +
      (loc.address
        ? '<div class="addr">📍 ' + esc(loc.address) + '</div>'
        : '') +
      '<div class="muted">坐标 ' + Number(loc.latitude).toFixed(5) + ', ' + Number(loc.longitude).toFixed(5) +
        ' · 海拔 ' + loc.altitude + 'm</div>' +
      '<div class="muted">最后活跃 ' + ago(t.lastSeenAt) +
        ' · 今日 拉取 ' + t.todayLoc + ' / 改点 ' + t.todaySet +
        (t.todayErr ? ' / <span class="st-bad">错误 ' + t.todayErr + '</span>' : '') + '</div>' +
      '<div class="row" style="margin-top:10px">' +
        '<button class="act" data-a="mod">复制模块</button>' +
        '<button class="act p" data-a="url">复制链接</button>' +
        '<button class="act s" data-a="label">改备注</button>' +
        '<button class="act s" data-a="toggle">' + (live ? "停用" : "启用") + '</button>' +
        '<button class="act r" data-a="del">删除</button>' +
      '</div></div>';
  }).join("");
}

function loadTokens(){
  return api("/admin/api/tokens").then(function(d){ renderTokens(d.tokens); });
}

$("tokenlist").addEventListener("click", function(ev){
  var btn = ev.target.closest("button[data-a]");
  if(!btn) return;
  var id = Number(btn.closest(".card").dataset.id);
  var t = tokensCache.filter(function(x){ return x.id === id; })[0];
  if(!t) return;
  var a = btn.dataset.a;
  if(a === "mod") return copy(t.moduleText, "模块已复制，去小火箭粘贴");
  if(a === "url") return copy(t.pickerUrl, "选点链接已复制");
  if(a === "label"){
    var v = prompt("备注名", t.label || "");
    if(v === null) return;
    return api("/admin/api/tokens/" + id, {method:"POST", body:{label:v}})
      .then(loadTokens).then(function(){ toast("已保存"); });
  }
  if(a === "toggle"){
    var next = t.status === "active" ? "disabled" : "active";
    if(next === "disabled" && !confirm("停用后，" + (t.label||"该用户") + " 的设备会恢复真实定位，且无法再打开选点页。继续？")) return;
    return api("/admin/api/tokens/" + id, {method:"POST", body:{status:next}})
      .then(loadTokens).then(function(){ toast(next === "disabled" ? "已停用" : "已启用"); });
  }
  if(a === "del"){
    if(!confirm("删除后该 token 立即失效且不可恢复（对方定位会回落到模块里写死的坐标）。确定删除 " + (t.label||mask(t.token)) + "？")) return;
    return api("/admin/api/tokens/" + id, {method:"DELETE"})
      .then(loadTokens).then(function(){ toast("已删除"); });
  }
});

$("newbtn").addEventListener("click", function(){
  var label = $("newlabel").value.trim();
  api("/admin/api/tokens", {method:"POST", body:{label:label}}).then(function(t){
    $("newlabel").value = "";
    return loadTokens().then(function(){ copy(t.moduleText, "已生成并复制模块，直接发给对方"); });
  }).catch(function(e){ toast("生成失败：" + e.message); });
});

// ---------- SVG 图表（手写，不引库） ----------
function svgWrap(h, inner){
  return '<svg viewBox="0 0 320 ' + h + '" preserveAspectRatio="none" height="' + h + '">' + inner + '</svg>';
}
function lineChart(series, labels){
  var W=320, H=120, PAD=4;
  var max = 1;
  series.forEach(function(s){ s.data.forEach(function(v){ if(v>max) max=v; }); });
  var n = labels.length;
  function x(i){ return n<2 ? W/2 : PAD + i*(W-2*PAD)/(n-1); }
  function y(v){ return H - 14 - (v/max)*(H-24); }
  var paths = series.map(function(s){
    var d = s.data.map(function(v,i){ return (i?"L":"M") + x(i).toFixed(1) + " " + y(v).toFixed(1); }).join(" ");
    return '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" ' +
           'stroke-linejoin="round" stroke-linecap="round"/>';
  }).join("");
  var dots = series.map(function(s){
    return s.data.map(function(v,i){
      return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2" fill="' + s.color + '"/>';
    }).join("");
  }).join("");
  var ticks = '<text x="2" y="10" font-size="9" fill="#8e8e93">' + max + '</text>';
  var xl = "";
  if(n){
    xl = '<text x="' + x(0) + '" y="' + (H-2) + '" font-size="9" fill="#8e8e93">' + labels[0].slice(5) + '</text>' +
         '<text x="' + x(n-1) + '" y="' + (H-2) + '" font-size="9" fill="#8e8e93" text-anchor="end">' + labels[n-1].slice(5) + '</text>';
  }
  return '<svg viewBox="0 0 320 ' + H + '" height="' + H + '">' + ticks + paths + dots + xl + '</svg>';
}
function barChart(values){
  var W=320, H=110, n=values.length, max=1;
  values.forEach(function(v){ if(v>max) max=v; });
  var bw = (W-8)/n;
  var bars = values.map(function(v,i){
    var h = (v/max)*(H-24);
    return '<rect x="' + (4+i*bw+0.8).toFixed(1) + '" y="' + (H-14-h).toFixed(1) +
      '" width="' + (bw-1.6).toFixed(1) + '" height="' + Math.max(h,0.5).toFixed(1) +
      '" rx="1.5" fill="#007aff" opacity="' + (v?1:0.25) + '"/>';
  }).join("");
  var lab = [0,6,12,18,23].map(function(i){
    return '<text x="' + (4+i*bw+bw/2).toFixed(1) + '" y="' + (H-2) +
      '" font-size="9" fill="#8e8e93" text-anchor="middle">' + i + '</text>';
  }).join("");
  return '<svg viewBox="0 0 320 ' + H + '" height="' + H + '">' +
    '<text x="2" y="10" font-size="9" fill="#8e8e93">' + max + '</text>' + bars + lab + '</svg>';
}
function hbarChart(items){
  if(!items.length) return '<div class="muted">暂无数据</div>';
  var max = 1;
  items.forEach(function(it){ if(it.value>max) max=it.value; });
  return items.map(function(it){
    var pct = (it.value/max*100).toFixed(1);
    return '<div style="margin-bottom:7px">' +
      '<div class="row" style="font-size:13px"><span class="grow">' + esc(it.name) + '</span>' +
      '<span class="muted">' + it.value + '</span></div>' +
      '<div style="height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:3px">' +
      '<div style="height:100%;width:' + pct + '%;background:var(--blue)"></div></div></div>';
  }).join("");
}
function donutChart(items){
  var total = items.reduce(function(a,b){ return a + b.value; }, 0);
  if(!total) return '<div class="muted">窗口内没有错误 🎉</div>';
  var R=42, C=52, circ=2*Math.PI*R, off=0;
  var arcs = items.map(function(it){
    var frac = it.value/total, len = frac*circ;
    var s = '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" fill="none" stroke="' + it.color +
      '" stroke-width="18" stroke-dasharray="' + len.toFixed(2) + ' ' + (circ-len).toFixed(2) +
      '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 ' + C + ' ' + C + ')"/>';
    off += len;
    return s;
  }).join("");
  var legend = items.map(function(it){
    return '<span><i style="background:' + it.color + '"></i>' + esc(it.name) + ' ' + it.value + '</span>';
  }).join("");
  return '<div class="row" style="gap:16px"><svg width="104" height="104" viewBox="0 0 104 104">' + arcs +
    '<text x="52" y="50" font-size="17" font-weight="700" text-anchor="middle" fill="currentColor">' + total + '</text>' +
    '<text x="52" y="64" font-size="9" text-anchor="middle" fill="#8e8e93">次错误</text>' +
    '</svg><div class="legend" style="flex-direction:column;gap:5px">' + legend + '</div></div>';
}

var ERR_NAME = {
  400:"400 参数错误", 401:"401 缺 token", 403:"403 token 无效/停用",
  429:"429 搜索限流", 502:"502 上游失败", 504:"504 上游超时", 404:"404 路径不存在"
};
var ERR_COLOR = {403:"#ff3b30", 429:"#ff9500", 502:"#5856d6", 504:"#af52de", 401:"#ff2d55", 400:"#8e8e93", 404:"#c7c7cc"};

// ---------- Tab 2：看板 ----------
function loadDash(){
  api("/admin/api/stats?days=" + $("days").value).then(function(s){
    var labels = s.trend.map(function(r){ return r.day; });
    var suspectHtml = "";
    if(s.suspects && s.suspects.length){
      suspectHtml = '<div class="alert"><b>疑似 token 配置错误</b><br>' +
        s.suspects.map(function(x){
          return esc(x.ip) + " 在窗口内出现 " + x.c + " 次 403（最近 " + ago(x.last_ts) +
                 "）——大概率是模块里的 token 抄错或多了空格。";
        }).join("<br>") + '</div>';
    }
    $("dash").innerHTML =
      suspectHtml +
      '<div class="kpis">' +
        kpi(s.tokenTotal, "Token 总数") +
        kpi(s.tokenActive, "启用中") +
        kpi(s.tokenDisabled, "已停用") +
        kpi(s.todayActive, "今日活跃") +
        kpi(s.todayLoc, "今日拉取") +
        kpi(s.todaySet, "今日改点") +
        kpi(s.todayErr, "今日错误", s.todayErr > 0) +
      '</div>' +
      '<div class="card"><h2>近 ' + s.days + ' 天趋势</h2>' +
        lineChart([
          {data: s.trend.map(function(r){ return r.loc; }), color:"#007aff"},
          {data: s.trend.map(function(r){ return r.set; }), color:"#34c759"},
          {data: s.trend.map(function(r){ return r.err; }), color:"#ff3b30"}
        ], labels) +
        '<div class="legend"><span><i style="background:#007aff"></i>拉取坐标</span>' +
        '<span><i style="background:#34c759"></i>改点/切换</span>' +
        '<span><i style="background:#ff3b30"></i>错误</span></div></div>' +
      '<div class="card"><h2>今日 24 小时分布</h2>' + barChart(s.hours) + '</div>' +
      '<div class="card"><h2>Token 活跃排行（近 ' + s.days + ' 天）</h2>' +
        hbarChart(s.top.map(function(t){
          return { name: t.label || (t.token ? mask(t.token) : "#" + t.id), value: t.loc + t["set"] };
        })) + '</div>' +
      '<div class="card"><h2>错误构成（近 ' + s.days + ' 天）</h2>' +
        donutChart(s.errors.map(function(e){
          return { name: ERR_NAME[e.status] || ("HTTP " + e.status),
                   value: e.c, color: ERR_COLOR[e.status] || "#8e8e93" };
        })) + '</div>';
  }).catch(function(e){ $("dash").innerHTML = '<div class="muted">加载失败：' + esc(e.message) + '</div>'; });
}
function kpi(v, k, warn){
  return '<div class="kpi' + (warn ? " warn" : "") + '"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
}

// ---------- Tab 3：日志 ----------
var logOffset = 0;
var LOG_PAGE = 100;
function loadLogs(reset){
  if(reset) logOffset = 0;
  var q = "/admin/api/logs?limit=" + LOG_PAGE + "&offset=" + logOffset;
  var tid = $("f-token").value;
  if(tid !== "") q += "&token_id=" + tid;
  if($("f-from").value) q += "&from=" + $("f-from").value;
  if($("f-to").value) q += "&to=" + $("f-to").value;
  if($("f-err").checked) q += "&errors=1";
  api(q).then(function(d){
    if(!d.rows.length){
      $("logs").innerHTML = '<div class="muted">' + (logOffset ? "没有更多了" : "没有匹配的记录") + '</div>';
      return;
    }
    var rows = d.rows.map(function(r){
      var name = r.label || (r.token_id ? "#" + r.token_id : "—");
      return '<tr><td class="muted" style="white-space:nowrap">' + fmtTime(r.ts) + '</td>' +
        '<td>' + esc(name) + '</td><td class="mono">' + esc(r.path) + '</td>' +
        '<td class="' + (r.status >= 400 ? "st-bad" : "st-ok") + '">' + r.status + '</td>' +
        '<td class="mono">' + esc(r.ip || "") + '</td>' +
        '<td class="muted">' + esc(r.detail || "") + '</td></tr>';
    }).join("");
    var from = logOffset + 1, to = logOffset + d.rows.length;
    var nav = '<div class="row" style="margin-top:10px">' +
      '<button class="act s" id="prev"' + (logOffset ? "" : " disabled") + '>上一页</button>' +
      '<button class="act s" id="next"' + (to < d.total ? "" : " disabled") + '>下一页</button>' +
      '<span class="muted grow" style="text-align:right">' + from + '–' + to + ' / 共 ' + d.total + ' 条</span></div>';
    $("logs").innerHTML = '<div class="card"><div class="wrap"><table>' +
      '<tr><th>时间</th><th>用户</th><th>接口</th><th>状态</th><th>IP</th><th>详情</th></tr>' +
      rows + '</table></div>' + nav + '</div>';
    $("prev").onclick = function(){ logOffset = Math.max(0, logOffset - LOG_PAGE); loadLogs(false); };
    $("next").onclick = function(){ logOffset += LOG_PAGE; loadLogs(false); };
  }).catch(function(e){ $("logs").innerHTML = '<div class="muted">加载失败：' + esc(e.message) + '</div>'; });
}
$("f-go").addEventListener("click", function(){ loadLogs(true); });


// ---------- Tab 4：归档 ----------
function fmtBytes(b){
  if(b < 1024) return b + " B";
  if(b < 1048576) return (b/1024).toFixed(1) + " KB";
  if(b < 1073741824) return (b/1048576).toFixed(1) + " MB";
  return (b/1073741824).toFixed(2) + " GB";
}
function dl(path){
  // Content-Disposition: attachment 会让浏览器直接下载，不会离开当前页
  var a = document.createElement("a");
  a.href = path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(ADMIN);
  a.setAttribute("download", "");
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ document.body.removeChild(a); }, 1000);
}
function loadArch(){
  api("/admin/api/info").then(function(d){
    $("storage").innerHTML =
      '<div class="kpis">' +
        kpi(fmtBytes(d.dbBytes), "数据库") +
        kpi(d.logRows.toLocaleString(), "日志行数") +
        kpi(fmtBytes(d.archiveBytes), "归档合计") +
        kpi(d.archives.length, "归档文件") +
        kpi(fmtBytes(d.rss), "进程内存") +
      '</div>' +
      '<div class="card"><div class="muted">' +
        '保留策略：表内留最近 ' + d.retentionMonths + ' 个完整月 + 当月，超过 ' +
        d.maxRows.toLocaleString() + ' 行时提前归档；归档文件最多留 ' + d.archiveKeepMonths + ' 个月。<br>' +
        '最早日志：' + (d.oldestLog ? fmtTime(d.oldestLog) : "无") +
        ' · schema v' + d.schemaVersion +
        ' · 已运行 ' + Math.round(d.uptimeSec/3600) + ' 小时' +
        ' · 堆内 ' + fmtBytes(d.heapUsed) + '</div></div>' +
      (d.lastPruneError
        ? '<div class="card err">上次自动清理失败：' + esc(d.lastPruneError) +
          '<br><span class="muted">日志一行都没删，下次定时任务会重试。常见原因是磁盘写满。</span></div>'
        : '');

    if(!d.archives.length){
      $("archlist").innerHTML = '<span class="muted">还没有归档文件。日志超出保留期后会自动生成。</span>';
      return;
    }
    $("archlist").innerHTML = d.archives.map(function(a){
      return '<div class="row" style="padding:7px 0;border-bottom:1px solid var(--line)">' +
        '<div class="grow"><b>' + esc(a.month) + '</b> <span class="muted">' + fmtBytes(a.bytes) + '</span></div>' +
        '<button class="act" data-dl="' + esc(a.name) + '">下载</button>' +
        '<button class="act r" data-rm="' + esc(a.name) + '">删除</button></div>';
    }).join("");
  }).catch(function(e){ $("storage").innerHTML = '<div class="muted">加载失败：' + esc(e.message) + '</div>'; });
}
$("archlist").addEventListener("click", function(ev){
  var b = ev.target.closest("button[data-dl],button[data-rm]");
  if(!b) return;
  if(b.dataset.dl){ return dl("/admin/api/archives/download?f=" + encodeURIComponent(b.dataset.dl)); }
  var name = b.dataset.rm;
  if(!confirm("删除归档 " + name + " 后不可恢复，确定？")) return;
  api("/admin/api/archives?f=" + encodeURIComponent(name), {method:"DELETE"})
    .then(loadArch).then(function(){ toast("已删除"); })
    .catch(function(e){ toast("删除失败：" + e.message); });
});
$("e-go").addEventListener("click", function(){
  var q = [];
  if($("e-from").value) q.push("from=" + $("e-from").value);
  if($("e-to").value) q.push("to=" + $("e-to").value);
  dl("/admin/api/export" + (q.length ? "?" + q.join("&") : ""));
  toast("开始下载…");
});
$("m-run").addEventListener("click", function(){
  var b = $("m-run"); b.disabled = true; b.textContent = "处理中…";
  api("/admin/api/archive/run", {method:"POST"}).then(function(r){
    if(r.error){ toast("清理失败：" + r.error); }
    else if(r.busy){ toast("已有清理任务在跑，稍等一下"); }
    else if(r.deletedRows){ toast("归档 " + r.archivedRows + " 行，删除 " + r.deletedRows + " 行"); }
    else { toast("没有需要清理的数据"); }
    return loadArch();
  }).catch(function(e){ toast("失败：" + e.message); })
    .then(function(){ b.disabled = false; b.textContent = "立即归档并清理"; });
});
$("m-vac").addEventListener("click", function(){
  if(!confirm("压缩会重写整个数据库，期间服务短暂不可用。继续？")) return;
  var b = $("m-vac"); b.disabled = true; b.textContent = "压缩中…";
  api("/admin/api/vacuum", {method:"POST"}).then(function(r){
    toast(r.freed > 0 ? ("收回 " + fmtBytes(r.freed)) : "没有可收回的空间");
    return loadArch();
  }).catch(function(e){ toast("失败：" + e.message); })
    .then(function(){ b.disabled = false; b.textContent = "压缩数据库"; });
});

// ---------- tab 切换 ----------
document.querySelectorAll(".tabs button").forEach(function(b){
  b.addEventListener("click", function(){
    document.querySelectorAll(".tabs button").forEach(function(x){ x.classList.remove("on"); });
    document.querySelectorAll(".pane").forEach(function(x){ x.classList.remove("on"); });
    b.classList.add("on");
    $("p-" + b.dataset.t).classList.add("on");
    if(b.dataset.t === "dash") loadDash();
    if(b.dataset.t === "logs" && !$("logs").querySelector("table")) loadLogs(true);
    if(b.dataset.t === "arch") loadArch();
  });
});
$("refresh").addEventListener("click", loadDash);
$("days").addEventListener("change", loadDash);

loadTokens().catch(function(e){
  $("tokenlist").innerHTML = '<div class="muted">加载失败：' + esc(e.message) + '</div>';
});
</script>
</body>
</html>`;

module.exports = { PAGE: PAGE };
