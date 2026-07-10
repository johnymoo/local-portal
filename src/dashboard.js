function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function isGuardEntry(p) {
  return p.state === "guarded" || p.guardWanted === true;
}
function isRegistrationEntry(p) {
  return p.state.startsWith("registered-");
}
function isUnmanagedEntry(p) {
  return p.state === "occupied-unmanaged" && !p.guardWanted;
}

function renderGuardRows(ports) {
  const rows = ports.filter(isGuardEntry);
  if (rows.length === 0) return `<tr><td colspan="3" class="empty">(none configured)</td></tr>`;
  return rows
    .map((p) => {
      const held = p.state === "guarded";
      const badge = held ? `<span class="badge held">held</span>` : `<span class="badge wanted">wanted</span>`;
      const detail = held
        ? "占位中 · 任何请求返回 409"
        : `被占用${p.process ? ` by ${escapeHtml(p.process.name)} (pid ${p.process.pid})` : "（owner unknown）"} · 每次扫描后重试收回`;
      return `<tr><td>${p.port}</td><td>${badge}</td><td>${detail}</td></tr>`;
    })
    .join("");
}

function renderRegistrationRows(ports) {
  const rows = ports.filter(isRegistrationEntry);
  if (rows.length === 0) return `<tr><td colspan="5" class="empty">(no registrations yet)</td></tr>`;
  return rows
    .map((p) => {
      const r = p.registration;
      const status = p.state.replace("registered-", "");
      return `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${p.port}</td>
        <td><span class="badge ${status}">${status}</span></td>
        <td>${timeAgo(r.registeredAt)}</td>
        <td>${timeAgo(r.lastSeenListeningAt)}</td>
      </tr>`;
    })
    .join("");
}

function renderUnmanagedRows(ports) {
  const rows = ports.filter(isUnmanagedEntry);
  if (rows.length === 0) return `<tr><td colspan="3" class="empty">(none)</td></tr>`;
  return rows
    .map((p) => {
      const proc = p.process ? `${escapeHtml(p.process.name)} (pid ${p.process.pid})` : "owner unknown";
      return `<tr><td>${p.port}</td><td>${escapeHtml((p.addresses || []).join(", "))}</td><td>${proc}</td></tr>`;
    })
    .join("");
}

function computeAllocUsage(ports, allocRange) {
  const used = ports.filter(
    (p) => isRegistrationEntry(p) && p.port >= allocRange.start && p.port <= allocRange.end
  ).length;
  const total = allocRange.end - allocRange.start + 1;
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 1000) / 10) : 0;
  return { used, total, pct };
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { margin-bottom: 0.25rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 1rem; font-size: 0.9rem; opacity: 0.8; margin-bottom: 1rem; }
  .meta dt { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid rgba(128,128,128,0.25); }
  th { font-weight: 600; opacity: 0.7; font-size: 0.8rem; text-transform: uppercase; }
  td.empty { opacity: 0.5; font-style: italic; }
  .badge { display: inline-block; padding: 0.05rem 0.5rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
  .badge.held, .badge.active { background: #d1f5df; color: #116631; }
  .badge.wanted, .badge.stale { background: #ffe8b3; color: #8a5a00; }
  .badge.pending { background: #dbe8ff; color: #1a4fb4; }
  .alloc-bar { background: rgba(128,128,128,0.2); border-radius: 999px; height: 8px; overflow: hidden; margin-top: 0.4rem; }
  .alloc-fill { background: #1a73e8; height: 100%; }
  .alloc-label { font-size: 0.85rem; opacity: 0.7; margin: 0.3rem 0 0; }
  details { margin-top: 1.5rem; }
  summary { cursor: pointer; font-weight: 600; }
  pre { background: rgba(128,128,128,0.12); padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
  button { margin-top: 0.5rem; padding: 0.3rem 0.8rem; border-radius: 6px; border: 1px solid rgba(128,128,128,0.4); background: transparent; cursor: pointer; }
  code { font-family: ui-monospace, monospace; }
`;

// Kept as a single string (no template-literal interpolation) so it can be
// embedded verbatim inside the outer Node template literal below.
const CLIENT_SCRIPT = [
  "function escapeHtml(s) {",
  "  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');",
  "}",
  "function timeAgo(iso) {",
  "  if (!iso) return '—';",
  "  var ms = Date.now() - Date.parse(iso);",
  "  if (!isFinite(ms) || ms < 0) return iso;",
  "  var s = Math.floor(ms / 1000);",
  "  if (s < 60) return s + 's ago';",
  "  var m = Math.floor(s / 60);",
  "  if (m < 60) return m + 'm ago';",
  "  var h = Math.floor(m / 60);",
  "  if (h < 24) return h + 'h ago';",
  "  return Math.floor(h / 24) + 'd ago';",
  "}",
  "function isGuardEntry(p) { return p.state === 'guarded' || p.guardWanted === true; }",
  "function isRegistrationEntry(p) { return p.state.indexOf('registered-') === 0; }",
  "function isUnmanagedEntry(p) { return p.state === 'occupied-unmanaged' && !p.guardWanted; }",
  "function renderGuardRows(ports) {",
  "  var rows = ports.filter(isGuardEntry);",
  "  if (rows.length === 0) return '<tr><td colspan=\"3\" class=\"empty\">(none configured)</td></tr>';",
  "  return rows.map(function (p) {",
  "    var held = p.state === 'guarded';",
  "    var badge = held ? '<span class=\"badge held\">held</span>' : '<span class=\"badge wanted\">wanted</span>';",
  "    var who = p.process ? (' by ' + escapeHtml(p.process.name) + ' (pid ' + p.process.pid + ')') : '（owner unknown）';",
  "    var detail = held ? '占位中 · 任何请求返回 409' : ('被占用' + who + ' · 每次扫描后重试收回');",
  "    return '<tr><td>' + p.port + '</td><td>' + badge + '</td><td>' + detail + '</td></tr>';",
  "  }).join('');",
  "}",
  "function renderRegistrationRows(ports) {",
  "  var rows = ports.filter(isRegistrationEntry);",
  "  if (rows.length === 0) return '<tr><td colspan=\"5\" class=\"empty\">(no registrations yet)</td></tr>';",
  "  return rows.map(function (p) {",
  "    var r = p.registration;",
  "    var status = p.state.replace('registered-', '');",
  "    return '<tr><td>' + escapeHtml(r.name) + '</td><td>' + p.port + '</td><td><span class=\"badge ' + status + '\">' + status + '</span></td><td>' + timeAgo(r.registeredAt) + '</td><td>' + timeAgo(r.lastSeenListeningAt) + '</td></tr>';",
  "  }).join('');",
  "}",
  "function renderUnmanagedRows(ports) {",
  "  var rows = ports.filter(isUnmanagedEntry);",
  "  if (rows.length === 0) return '<tr><td colspan=\"3\" class=\"empty\">(none)</td></tr>';",
  "  return rows.map(function (p) {",
  "    var proc = p.process ? (escapeHtml(p.process.name) + ' (pid ' + p.process.pid + ')') : 'owner unknown';",
  "    return '<tr><td>' + p.port + '</td><td>' + escapeHtml((p.addresses || []).join(', ')) + '</td><td>' + proc + '</td></tr>';",
  "  }).join('');",
  "}",
  "function renderAllocUsage(ports, allocRange) {",
  "  var used = ports.filter(function (p) { return isRegistrationEntry(p) && p.port >= allocRange.start && p.port <= allocRange.end; }).length;",
  "  var total = allocRange.end - allocRange.start + 1;",
  "  var pct = total > 0 ? Math.min(100, Math.round((used / total) * 1000) / 10) : 0;",
  "  document.getElementById('alloc-bar-fill').style.width = pct + '%';",
  "  document.getElementById('alloc-label').textContent = used + ' / ' + total + ' 已用 (' + allocRange.start + '–' + allocRange.end + ')';",
  "}",
  "function refresh() {",
  "  fetch('/api/ports').then(function (res) { return res.json(); }).then(function (data) {",
  "    document.getElementById('guard-table-body').innerHTML = renderGuardRows(data.ports);",
  "    document.getElementById('registrations-table-body').innerHTML = renderRegistrationRows(data.ports);",
  "    document.getElementById('unmanaged-table-body').innerHTML = renderUnmanagedRows(data.ports);",
  "    renderAllocUsage(data.ports, data.allocRange);",
  "    document.getElementById('last-scan').textContent = timeAgo(data.portal.lastScanAt) + ' (' + data.portal.scanSource + ')';",
  "  }).catch(function () { /* keep last known view on transient fetch errors */ });",
  "}",
  "setInterval(refresh, 5000);",
  "refresh();",
  "fetch('/api/agent-guide?format=json').then(function (res) { return res.json(); }).then(function (data) {",
  "  document.getElementById('agent-guide').textContent = data.markdown;",
  "});",
  "document.getElementById('copy-guide').addEventListener('click', function () {",
  "  var text = document.getElementById('agent-guide').textContent;",
  "  navigator.clipboard.writeText(text).then(function () {",
  "    var btn = document.getElementById('copy-guide');",
  "    var original = btn.textContent;",
  "    btn.textContent = 'Copied!';",
  "    setTimeout(function () { btn.textContent = original; }, 1500);",
  "  });",
  "});",
].join("\n");

/** Renders the GET / dashboard: portal info, guard/registration/unmanaged tables, alloc usage, agent-guide. */
export function renderDashboard(view, config, meta) {
  const { apiBase, startedAt, version } = meta;
  const ports = view.ports;
  const lastScan = view.lastScan;
  const allocUsage = computeAllocUsage(ports, config.allocRange);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>local-portal dashboard</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>local-portal</h1>
  <dl class="meta">
    <dt>API</dt><dd><code>${escapeHtml(apiBase)}</code></dd>
    <dt>version</dt><dd>${escapeHtml(version)}</dd>
    <dt>started</dt><dd>${escapeHtml(startedAt)}</dd>
    <dt>last scan</dt><dd id="last-scan">${timeAgo(lastScan?.at)} (${escapeHtml(lastScan?.source ?? "none")})</dd>
  </dl>
</header>

<section>
  <h2>守卫端口 Guarded Ports</h2>
  <table>
    <thead><tr><th>Port</th><th>Status</th><th>Detail</th></tr></thead>
    <tbody id="guard-table-body">${renderGuardRows(ports)}</tbody>
  </table>
</section>

<section>
  <h2>已注册 Registrations</h2>
  <div id="alloc-bar-fill-wrap" class="alloc-bar"><div id="alloc-bar-fill" class="alloc-fill" style="width:${allocUsage.pct}%"></div></div>
  <p id="alloc-label" class="alloc-label">${allocUsage.used} / ${allocUsage.total} 已用 (${config.allocRange.start}–${config.allocRange.end})</p>
  <table>
    <thead><tr><th>Name</th><th>Port</th><th>Status</th><th>Registered</th><th>Last seen</th></tr></thead>
    <tbody id="registrations-table-body">${renderRegistrationRows(ports)}</tbody>
  </table>
</section>

<details>
  <summary>未托管端口 Unmanaged Ports (informational, ${ports.filter(isUnmanagedEntry).length})</summary>
  <table>
    <thead><tr><th>Port</th><th>Addresses</th><th>Process</th></tr></thead>
    <tbody id="unmanaged-table-body">${renderUnmanagedRows(ports)}</tbody>
  </table>
</details>

<details>
  <summary>Agent 接入指南 (粘贴进 CLAUDE.md / AGENTS.md)</summary>
  <pre id="agent-guide">loading…</pre>
  <button id="copy-guide" type="button">Copy</button>
</details>

<script>${CLIENT_SCRIPT}</script>
</body>
</html>
`;
}
