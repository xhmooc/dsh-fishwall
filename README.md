# dsh-fishwall · 删除防护

> 检测到大规模删除就拉闸。
> 用 Windows 自己的文件审计（4663）数删除速率，超阈值 `taskkill` 掉正在删的进程，
> 并把事故（谁、多少次、删了哪些路径）写成一份 JSON 存下来。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。

---

## 为什么会有这个东西

真实的教训：某天中午，一台机器上一个插件在几十秒里把整个用户目录删了——
正在运行的文件因为被占用而幸存，其余全部消失。事后再查：

- 回收站里没有（不是资源管理器删的）
- 卷影副本没有
- USN 日志已回卷
- 进程审计当时没开

**结果是：知道发生过，但说不出是谁。**

`dsh-fishwall` 就是补这个洞的：
**事前留证（审计）、事中止血（拉闸）、事后可复盘（事故记录）。**

---

## 它做什么

```
① 审计开关    启动时确保 auditpol + SACL 就位（幂等，24h 缓存一次）
② 速率监控    每 intervalMs 拉一次 4663，算 windowSec 滑动窗口里的删除次数
③ 拉闸        超过阈值 → 给正在删的那个进程 taskkill /T /F
④ 落档        fishwall-incidents/<时间>.json（进程 / PID / 条数 / 路径样本）
```

只统计 **删除**（SACL 只挂 `Delete` + `DeleteSubdirectoriesAndFiles`），
所以不会因为读文件、写文件而误报——除了 DSH 自己写文件时的临时文件删除，
那部分用独立的、高得多的阈值兜着。

---

## 安装

```bash
dsh plugin --profile <你的 profile> add dsh-fishwall
```

装完**完全重启 DSH**（设置页是网页半边，要重启才会出现）。

需要 **管理员权限**：`auditpol` 和 `Set-Acl` 都要。

---

## 配置

`~/.dsh/fishwall.json`（也可以直接在设置页里改，2 秒内生效）：

```json
{
  "enabled": true,
  "intervalMs": 2000,
  "windowSec": 30,

  "threshold": 300,
  "dshThreshold": 1500,

  "cooldownSec": 300,
  "kill": true,
  "killDsh": true,

  "allow": ["explorer.exe"],
  "autoAudit": true,

  "roots": [
    "C:\\Users\\<你>\\.dsh",
    "C:\\Users\\<你>\\Desktop",
    "C:\\Users\\<你>\\Documents",
    "C:\\Users\\<你>\\Downloads"
  ]
}
```

| 键 | 含义 |
|---|---|
| `threshold` | 外部进程在 `windowSec` 内删这么多 → 拉闸 |
| `dshThreshold` | DSH 自身（插件都在它进程里跑）的阈值，特意更高 |
| `kill` | 关掉 = 只记录不动手（观察模式） |
| `killDsh` | 是否允许杀 DSH 自己。这是唯一能拦住"进程内插件发疯"的手段 |
| `allow` | 白名单进程名（默认放行资源管理器，你自己删东西不算事故） |
| `roots` | 挂审计的目录，也是"删除发生在哪"的判据 |

**永远不会杀的进程**：`System` / `csrss` / `wininit` / `services` / `lsass` / `smss` / `winlogon` / `svchost` / `dwm` / `explorer`。

---

## 维护模式（很重要）

装插件、重装 `node_modules`、清理构建产物之前，先暂停：

```powershell
New-Item "$env:USERPROFILE\.dsh\fishwall.pause" -ItemType File -Force   # 暂停
Remove-Item "$env:USERPROFILE\.dsh\fishwall.pause" -Force               # 恢复
```

或者直接在设置页点「暂停（维护用）」。

否则 `pnpm install` 重建 `node_modules` 时会在几秒内删上千个文件，
进程是 `node.exe` —— 会被自己人当成事故打掉。

---

## 文件

| | |
|---|---|
| 配置 | `~/.dsh/fishwall.json` |
| 日志 | `~/.dsh/fishwall.log` |
| 事故 | `~/.dsh/fishwall-incidents/*.json` |
| 暂停标记 | `~/.dsh/fishwall.pause` |

事故记录长这样：

```json
{
  "at": "2026-10-30T08:55:25.818Z",
  "why": "30s 内 60 次删除（阈值 20）",
  "totalEvents": 60,
  "offenders": [
    { "pid": 21156, "process": "node.exe", "count": 60,
      "sample": ["C:\\...\\g1.txt", "C:\\...\\g0.txt"] }
  ],
  "killed": [{ "pid": 21156, "process": "node.exe" }],
  "dryRun": false
}
```

---

## 局限

- **只在 Windows 上工作**（依赖 4663 事件）。
- 需要管理员权限；没有权限时插件仍会启动，但读不到事件。
- 审计只覆盖 `roots` 里列的目录——别的地方删文件它看不见。
- 阈值是"速率"不是"总量"：慢慢删（低于阈值）不会触发。
- 拉闸是**杀进程**，不是"撤销删除"。已经删掉的东西救不回来，它的价值是**止损 + 留证**。

---

## 许可

MIT
