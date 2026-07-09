# local-portal

本机开发端口守卫与注册中心。解决多个 AI Agent 在同一台服务器上部署 Web 应用时，反复抢占
3000、8080 等热门端口、甚至互相杀掉对方服务的问题。

## 它做了什么

1. **预先占用**常见开发端口（默认 3000、3001、4200、5000、5173、8000、8080、8888）。
2. 任何请求打到这些端口，都会收到 **409** 响应和明确的引导信息（JSON 或 HTML，取决于
   `Accept` 头），而不是连接失败——Agent 不会误以为端口空闲。
3. 提供**注册 API**：Agent 通过 `POST /api/register` 申请一个专属端口，而不是硬编码常见端口。
4. 自身即**注册中心**：`GET /api/ports` 给出全机端口视图——哪些被守卫、哪些已注册、
   哪些被未托管的进程占用、哪些空闲。

零运行时依赖，只用 Node.js 内置模块（`node:http`、`node:net`、`node:fs` 等），无需
`npm install` 即可运行。

## 快速开始

```bash
node src/main.js
# 或
npm start
```

首次运行会在 `~/.config/local-portal/config.json` 自动创建默认配置。注册数据持久化在
`~/.local/state/local-portal/registry.json`。

停止服务：`Ctrl+C` 或 `kill -TERM <pid>` —— 会优雅释放所有守卫端口并写盘。

## 配置项（`~/.config/local-portal/config.json`）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiPort` | `7777` | API/仪表盘监听端口，启动后不会自动更换（Agent 需要稳定地址） |
| `apiBind` | `127.0.0.1` | API 监听地址，见下方安全说明 |
| `publicApiBase` | `null` | 若设置，guard/guide 中的引导 URL 使用此值而非 `127.0.0.1` |
| `guardPorts` | `[3000,3001,4200,5000,5173,8000,8080,8888]` | 需要守卫的端口列表 |
| `allocRange` | `{start:20000,end:20999}` | 自动分配端口的区间 |
| `scanIntervalSec` | `30` | OS 端口扫描 / 状态调和的周期 |
| `pendingGraceSec` | `300` | 注册后允许多久还没监听（超时转 stale） |
| `staleGraceSec` | `90` | 曾经监听、之后失联多久转 stale（容忍短暂重启） |
| `staleEvictSec` | `86400` | stale 状态保留多久后自动清除（24 小时） |
| `registryPath` | `null` | 覆盖默认注册表文件路径 |
| `logLevel` | `info` | `debug`/`info`/`warn`/`error` |

修改后重启服务生效（无热重载）。

## API 一览

- `GET /api/health` — 存活探针 + 服务签名（用于自检重复实例）
- `GET /api/ports` — 全机端口视图
- `GET /api/ports/:port` — 单端口实时查询
- `POST /api/register` — `{name, description?, preferredPort?, meta?}` 申请端口
- `POST /api/release` — `{name, port}` 释放注册
- `GET /api/agent-guide` — 给 Agent 看的 Markdown 使用指南（`?format=json` 返回 JSON 包裹）
- `GET /` — 仪表盘（浏览器打开即可看到实时状态）

完整的请求/响应细节、错误码和状态机见各模块源码顶部注释与 `src/api.js`。

## 让 Agent 主动遵守（而不是等它撞上 409）

Agent 直接 `bind()` 撞上 `EADDRINUSE` 时，不一定会想到去 curl 这个端口。更好的做法是把
使用规范预先写进 Agent 的全局指令文件：

```bash
curl -s http://127.0.0.1:7777/api/agent-guide >> ~/.claude/CLAUDE.md
# 或写入项目里的 AGENTS.md / CLAUDE.md
```

仪表盘（`http://127.0.0.1:7777/`）里也有一个可展开的「Agent 接入指南」区块，带一键复制。

## `portalctl` CLI

```bash
bin/portalctl status                                  # 查看全机端口状态
bin/portalctl check 3000                               # 查看单个端口
bin/portalctl register my-app --desc "dev server"      # 申请端口（自动分配）
bin/portalctl register my-app --port 20005             # 申请指定端口
bin/portalctl release my-app 20005                      # 释放
bin/portalctl guide                                     # 打印 agent-guide markdown
```

支持 `PORTAL_URL` 环境变量覆盖默认的 `http://127.0.0.1:7777`。

## systemd 部署（用户级服务）

```bash
mkdir -p ~/.config/systemd/user
cp local-portal.service ~/.config/systemd/user/
# 检查/修改 ExecStart 里的 node 绝对路径（nvm 安装的 node 不在 systemd 的 PATH 里）：
which node
systemctl --user daemon-reload
systemctl --user enable --now local-portal
journalctl --user -u local-portal -f
```

用户级 systemd 服务默认只在你登录期间运行，注销后会被杀掉。要让它在开机 / 注销后依然
常驻，需要开启 linger：

```bash
loginctl enable-linger "$USER"
```

服务退出码约定：`0` 正常退出；`1` 配置错误或 apiPort 被外部进程占用（systemd 会重试，
给对方进程腾地方的机会）；`2` 检测到已有 local-portal 实例在跑同一个 apiPort（`RestartPreventExitStatus`
配置为不重启，避免死循环）。

## 安全说明

- API 默认只监听 `127.0.0.1`：它是可写接口（注册/释放）且没有鉴权，只信任本机调用方。
- 如果确实需要让局域网内其他机器访问（比如仪表盘），把 `apiBind` 改成 `0.0.0.0`，并设置
  `publicApiBase` 为局域网可达的地址，同时确保网络本身可信——任何能连到这个端口的人都能
  注册/释放端口。
- 守卫端口永远监听通配地址（`0.0.0.0` + `[::]`），这是守卫机制本身要求的，不可配置。

## 局限性

- **协作机制，不是强制防火墙**：如果某个进程绕过 portal 直接 bind 了一个已注册的端口
  （比如用 `SO_REUSEPORT`），portal 无法阻止，只能在下次扫描时把 `observedProcess` 更新
  成异常的进程名供人工排查。
- **看不到跨用户进程的名字**：`ss -p` 只能看到同一用户的进程信息；其他用户的监听端口会
  显示 `owner unknown`，这不是错误。
- **注册是预约，不是绑定**：`POST /api/register` 返回的端口在你实际 bind 之前，理论上
  可能被第三方抢先占用（概率很低，因为分配前做过 bind 实测）。如果撞上 `EADDRINUSE`，
  查一下 `GET /api/ports/:port` 再重新注册，不要杀进程。
- 依赖 `ss` 命令；如果系统没有 `ss`，会自动回退到解析 `/proc/net/tcp{,6}`（只有端口号，
  没有进程名）；两者都不可用时进入降级模式（仍能守卫和注册，只是看不到未托管端口的全貌）。

## 测试

```bash
npm test
```

零依赖，纯 `node --test`，不需要 root 权限，也不占用固定端口（全部使用临时端口 + 注入
时钟，不依赖真实的 sleep）。
