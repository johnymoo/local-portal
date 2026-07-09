/**
 * Single source of truth for all agent-facing guidance text. Guard 409
 * responses, the /api/agent-guide endpoint, and the dashboard all render
 * from here so the wording never drifts out of sync.
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function guardJsonBody(port, apiBase) {
  return {
    ok: false,
    service: "local-portal",
    error: {
      code: "port_guarded",
      message: `Port ${port} is intentionally reserved by local-portal, the port registry for this machine. Nothing is deployed here.`,
    },
    action_required:
      "DO NOT kill the process on this port. It is infrastructure, not a stale dev server. Register your app with the portal to get a dedicated port.",
    how_to_get_a_port: {
      "1_read_the_guide": `curl ${apiBase}/api/agent-guide`,
      "2_see_all_ports": `curl ${apiBase}/api/ports`,
      "3_register": `curl -X POST ${apiBase}/api/register -H 'content-type: application/json' -d '{"name":"<your-app-name>","description":"<what it is>"}'`,
      "4_use_granted_port": "The response contains granted.port. Start your server on that port.",
      "5_release_when_done": `curl -X POST ${apiBase}/api/release -H 'content-type: application/json' -d '{"name":"<your-app-name>","port":<granted>}'`,
    },
    api_base: apiBase,
  };
}

export function guardHtmlBody(port, apiBase) {
  const safeApiBase = escapeHtml(apiBase);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Port ${port} is reserved — local-portal</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  pre { background: #f4f4f4; padding: 0.75rem 1rem; border-radius: 6px; overflow-x: auto; }
  code { font-family: ui-monospace, monospace; }
  .warn { color: #b00020; font-weight: 600; }
  a { color: #0060df; }
</style>
</head>
<body>
<h1>端口 ${port} 已被守卫 / Port ${port} is reserved</h1>
<p class="warn">DO NOT kill the process on this port — it is local-portal infrastructure, not a stale dev server.</p>
<p>This port is intentionally reserved by <strong>local-portal</strong>, the port registry for this machine. Register your app to get a dedicated port instead:</p>
<pre><code>curl ${safeApiBase}/api/agent-guide</code></pre>
<pre><code>curl ${safeApiBase}/api/ports</code></pre>
<pre><code>curl -X POST ${safeApiBase}/api/register \\
  -H 'content-type: application/json' \\
  -d '{"name":"&lt;your-app-name&gt;","description":"&lt;what it is&gt;"}'</code></pre>
<p>Use <code>granted.port</code> from the response as your server's listen port. When done:</p>
<pre><code>curl -X POST ${safeApiBase}/api/release \\
  -H 'content-type: application/json' \\
  -d '{"name":"&lt;your-app-name&gt;","port":&lt;granted&gt;}'</code></pre>
<p><a href="${safeApiBase}/">Open the local-portal dashboard →</a></p>
</body>
</html>
`;
}

export function agentGuideMarkdown(apiBase) {
  return `# Port policy for this machine (端口使用规范 — 部署任何 Web 服务前必读)

This machine runs \`local-portal\`, a port registry at ${apiBase}.
Rules for ALL agents deploying anything that listens on a TCP port:

1. NEVER kill a process just to free its port. Other agents' services run here.
2. BEFORE starting any server, register a port:
   curl -sX POST ${apiBase}/api/register \\
     -H 'content-type: application/json' \\
     -d '{"name":"<app-name>","description":"<one line>"}'
   Use \`granted.port\` from the response. Bind within 5 minutes.
3. Do not hardcode 3000/5173/8080/etc. Those ports are guarded and return 409.
4. If a specific port is required, request it: add "preferredPort": <n> — a 409
   means it is taken; fall back to auto-allocation.
5. If any bind fails with EADDRINUSE, do not retry-kill. Check
   curl ${apiBase}/api/ports/<port> to see who owns it.
6. When your service is permanently stopped, release the port:
   curl -sX POST ${apiBase}/api/release -H 'content-type: application/json' \\
     -d '{"name":"<app-name>","port":<n>}'
7. Full machine port map: curl ${apiBase}/api/ports
`;
}
