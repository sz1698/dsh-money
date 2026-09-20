# dsh-money

> DSH（DeepSeek Harness）Web 插件的余额常驻显示：**侧栏底部、「设置」正上方一行「余额：¥100.34」**。

```
┌──────────────────────────┐
│  … 会话列表 …             │
│                          │
│  🖼 壁纸                  │  ← 别的插件（若有），各占一行互不挤压
│  余额：¥100.34             │  ← 本插件
│  ⚙ 设置                   │  ← DSH 自带
└──────────────────────────┘
```

只做一件事：**查余额、显示余额**。不记账、不估 token、不弹提醒。

## 特性

- ⏱ **定时 + 手动双通道**：挂载即取一次，之后按设定间隔**静默自动刷新（默认 60 秒）**；点一下余额 = 立刻强制刷新（跳过宿主缓存）。
- ⟳ **刷新可见**：手动刷新时显示**转圈 + 「获取余额中」**，拿到结果（成功或失败）特效立刻消失。
- 🛡 **防抖**：请求在飞时点击一律忽略（连点只会有一个请求）；手动刷新还有 700ms 冷却。
- 📐 **两种形态**：侧栏展开时整行 `余额：¥100.34`；折叠成 56px 轨道时自动变成紧凑金额 `¥100` / `¥1.2k`。
- 🎛 **可在设置里调**：自动刷新间隔、小数位数、是否显示「余额：」前缀、是否允许点击强制刷新 ——
  入口是 **设置 → 插件 → 可配置 → 「余额挂件」**，改完即时生效、无需重启。
- 🧯 **失败不闪数字**：上游超时/5xx 时沿用上一次成功金额（tooltip 标「余额未刷新」）；从未成功过才显示 `余额：--`，并给出原因。
- 🔑 **密钥不落配置**：只用 DSH 凭据服务里的 `DEEPSEEK_API_KEY`，插件配置文件里不出现任何密钥。
- 🪶 **无构建步骤**：宿主半是普通 ESM，浏览器半是手写客户端 bundle（DSH 只要求 closure 契约）；
  唯一运行时依赖是 `@deepseek-ai/schemastery`（注册设置项 schema 用，DSH 官方插件同样依赖它）。

## 安装

前提两件事：

1. 有 DSH **web profile**（桌面版或 `dsh web` 都行）；
2. 在 DSH 凭据里配好 **`DEEPSEEK_API_KEY`**（没有它也能装，只是会显示 `余额：--`）。

### 方式 A：从 npm 安装

> ⚠️ **暂时不要执行 `dsh plugin --profile web add dsh-money`**：npm 上的 `dsh-money`
> 是**另一个项目**（作者 `yanhuifair`，v1.1.9，功能相近的"余额 + 费用追踪"），
> 装它会装成别人的插件。本插件目前**尚未发布到 npm**，请用方式 B / C 安装。
>
> 等它以自己独立的包名发布后，这里会给出确切命令；在那之前，
> 也请不要让两个同名包同时存在 —— DSH 按包名去重 loader 源，同名的两个包会直接抛
> `resolves from multiple active Loader sources`。

### 方式 B：从 GitHub 安装

```powershell
dsh plugin --profile web add github:sz1698/dsh-money
```

装完会出现在 DSH 的**插件管理页面**里，之后可直接在页面里更新。
需要代理时先设环境变量再执行：

```powershell
$env:https_proxy="http://<ip>:<port>"; dsh plugin --profile web add github:sz1698/dsh-money
```

### 方式 C：本地源码（`link:`，改完即生效）

```powershell
dsh plugin --profile web add link:D:\path\to\dsh-money
```

`link:` 是软链安装：源目录里改了文件立即生效，但**之后不能移动/重命名该目录**（移动了要重新 add 一次）。
想改成拷贝安装用 `file:`。

### 方式 D：桌面版没有 `dsh` CLI 时（手工一行）

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，追加：

```yaml
- insert:
    - id: dsh-money
      name: 'file:///C:/path/to/dsh-money/lib/index.js?v=1'
```

- 路径必须写成**绝对 `file:///` URL**；
- profile 的 `patchReload` 是 `live`：宿主半改动**不必重启 DSH**，但**每次改 `lib/index.js` 都要把 `?v=N` 加一**，否则会继续跑 ESM 缓存里的旧代码（原因见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)）；
- 浏览器半是新的客户端模块行，**需要刷新一次页面**（F5）才会挂上。

### 装完自检

```powershell
# token 从桌面版日志里取（每次启动/打开页面一行）
$log = "$env:APPDATA\DeepSeek Harness Desktop\host.log"
$tok = (Select-String -Path $log -Pattern 'token=([A-Za-z0-9_\-]+)' | Select-Object -Last 1).Matches[0].Groups[1].Value
$jar = "$env:TEMP\dsh-money-cookies.txt"
curl.exe -s -o NUL -c $jar "http://127.0.0.1:57321/?token=$tok"

# 读余额（?refresh=1 绕过宿主 25 秒缓存）
curl.exe -s -b $jar "http://127.0.0.1:57321/api/dsh-money"
# → {"ok":true,"balance":100.34,"currency":"CNY","updatedAt":"2026-09-20T03:27:42.993Z"}

# 确认客户端模块行已被识别（SSE 首帧是整张 boot graph）
curl.exe -s --max-time 5 -N "http://127.0.0.1:57321/plugins/events" | Select-String 'dsh-money'
```

> 端口按实际 `dsh web` 的地址替换（桌面版复用同一个端口）。
> 不带会话凭据直接 curl 会返回 **401** —— 那是 DSH 的信任栅栏在工作，不是接口坏了。

## 行为一览

| 场景 | 表现 |
|---|---|
| 侧栏展开 | 整行 `余额：¥100.34`，与「设置」行同样的高度 / 圆角 / 悬浮底色 |
| 侧栏折叠（56px 轨道） | 紧凑金额 `¥100` 或 `¥1.2k` |
| **自动刷新** | **每 60 秒一次（静默，不显示特效）**；首次挂载也取一次 |
| **点击刷新** | 立即转圈 + 「获取余额中」+ 底色点亮 + `cursor: progress`；返回后特效消失 |
| **防抖** | 请求在飞时点击忽略；手动刷新 700ms 冷却 |
| 鼠标悬停 | tooltip：完整金额 + 最近更新时间 + 错误原因（若有） |
| 上游超时 / 5xx | 沿用上一次成功金额，tooltip 标「余额未刷新」 |
| 没配密钥 / 返回结构异常 | 首次显示 `余额：…`，拿到错误后显示 `余额：--`，tooltip 给出原因 |

只看一眼就知道在不在刷新（控制台可用）：

```js
document.querySelector('[data-testid="dsh-money"]').dataset.busy   // 非空 = 刷新中
```

## 配置

打开 **设置 → 插件 → 可配置 → 「余额挂件」**（这个卡片就是本插件自己提供的）：

| 设置项 | 可选值 | 默认 | 说明 |
|---|---|---|---|
| 自动刷新间隔 | 10 / 30 / 60 / 120 / 300 / 600 秒 | 60 秒 | 定时静默刷新的周期 |
| 小数位数 | 0–4 位 | 2 位 | 只影响显示，不影响取到的精确值 |
| 显示「余额：」前缀 | 开 / 关 | 开 | 关掉后只显示金额 |
| 允许点击强制刷新 | 开 / 关 | 开 | 关掉后余额行纯只读，不响应点击 |

改动立即生效（宿主持久化，页面即时跟随），无需重启 DSH。

其它常数（想改就得动源码，改完刷新页面即生效）：

| 想要什么 | 常数 | 位置 | 默认 |
|---|---|---|---|
| 手动刷新冷却 | `MANUAL_COOLDOWN_MS` | `lib/client.js` | `700`（毫秒） |
| 币种符号 | `SYMBOL` | `lib/client.js` | `¥ $ € £ ¥` |
| 宿主侧余额缓存 | `CACHE_MS` | `lib/index.js` | `25000`（25 秒） |
| 单次上游超时 | `TIMEOUT_MS` | `lib/index.js` | `8000`（毫秒） |

## 工作原理

```
浏览器（DSH Web 页面）                        宿主（dsh web 进程）
────────────────────────────                 ────────────────────────────
BalanceBadge 挂到 sidebar.footer.action 席位
  │ fetch /api/dsh-money  ◄── 已鉴权通道 ──►  connection.fetch.register
  │ 定时（设置里的间隔）/ 点击 ?refresh=1     credentials.resolve(DEEPSEEK_API_KEY)
  └ 渲染「余额：¥xxx」                        fetch api.deepseek.com/user/balance
                                             （25 秒内存缓存 + 在途去重 + 瞬时失败沿用旧值）

BalanceSettingsCard 挂到 settings.plugin.item
  ▲ 读写同一个 settings 命名空间 dsh-money
  └ 设置 → 插件 → 可配置 里的「余额挂件」卡片  ◄── settings.register('dsh-money', schema)
```

- **宿主半**（`lib/index.js`）只做取数，并经 **DSH 已鉴权的 `/api` 通道**下发。该通道自带
  Host/Origin 栅栏与浏览器会话鉴权，所以插件不必自己写鉴权、也不会漏掉它。
- **浏览器半**（`lib/client.js`）是**手写的客户端 bundle**（DSH 只要求
  `window.__ModuleLoader__.load({ id, factory })` 这一层 closure 契约，缺 sourcemap 也照跑），
  注册到官方声明的加性席位 `sidebar.footer.action` —— 也就是 `.footArea` 里 `sidebar.settings`
  的正上方。不改 DSH 前端，也不往 React 管理的 DOM 里塞节点。
- **设置卡片**：插件在宿主注册 settings 命名空间 `dsh-money`，并在浏览器按**同一个 key**
  往 `settings.plugin.item` 注册卡片 —— 「可配置」页签按命名空间列表渲染卡片，宿主不需要知道
  卡片长什么样。这也是插件出现在「设置 → 插件 → 可配置」里的机制。

## 目录结构

```
dsh-money/
├── package.json        # dsh.bundle.patch + dsh.client（platform / inject / immediately）
├── cordis.patch.yml    # bundle 挂载声明（dsh plugin add 用；手工装时不用它）
├── lib/
│   ├── index.js        # 宿主半：凭据 → 余额接口 → /api/dsh-money
│   └── client.js       # 浏览器半：注入样式 + 余额行 + 设置卡片（两个 slot）
├── test/smoke.mjs      # 零依赖契约冒烟测试
└── LICENSE             # MIT
```

## 卸载

```powershell
dsh plugin --profile web remove dsh-money
```

手工装的（方式 D）：删掉 patch 里那两行，刷新页面即可。插件在设置里的命名空间会随之消失
（用户层残留的 `dsh-money:` 段不影响别的插件）。

## 已知限制

- 只显示 **DeepSeek 官方接口能查到的余额**（`/user/balance`），不提供消费流水。
- 余额是**快照**：接口不返回流水，充值/扣费发生在两次刷新之间时只能看到净变化。
- **与其它同席位插件的关系**：本插件挂在侧栏底部的加性席位 `sidebar.footer.action` 上，
  并让该行允许换行 —— 因此当同一行还住着「壁纸」这类占满整行的按钮时，两者各占一行、
  互不挤压。本插件不修改任何其它插件的代码。
- **包名与 npm 上的同名包冲突**：npm 的 `dsh-money` 是另一个项目（`yanhuifair`，功能相近），
  所以本插件不能（也不该）从 npm 安装，请用 GitHub 或 `link:`。两者若被同时装进同一个 profile，
  DSH 会因「同名包解析到多个活动 Loader 源」而拒绝启动相关插件。
- DSH 处于 developer preview，席位名与 `/api` 通道语义可能随版本变化；插件不生效时先看
  `dsh --profile web --dump-config` 里有没有 `dsh-money`。

## 开发

```powershell
node test/smoke.mjs     # 契约 / 换行样式 / 三套渲染 / 点击防抖
```

改代码时要知道的几件事（DSH 插件的契约与两个实测陷阱、以及一个不开浏览器也能定位布局问题的
自检开关）见 **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**。

## 许可证

[MIT](LICENSE) © 2026 sz1698
