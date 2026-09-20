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

- ⏱ **定时 + 手动双通道**：挂载即取一次，之后**每 60 秒静默自动刷新**；点一下余额 = 立刻强制刷新（跳过宿主缓存）。
- ⟳ **刷新可见**：手动刷新时显示**转圈 + 「获取余额中」**，拿到结果（成功或失败）特效立刻消失。
- 🛡 **防抖**：请求在飞时点击一律忽略（连点只会有一个请求）；手动刷新还有 700ms 冷却。
- 📐 **两种形态**：侧栏展开时整行 `余额：¥100.34`；折叠成 56px 轨道时自动变成紧凑金额 `¥100` / `¥1.2k`。
- 🧯 **失败不闪数字**：上游超时/5xx 时沿用上一次成功金额（tooltip 标「余额未刷新」）；从未成功过才显示 `余额：--`，并给出原因。
- 🔑 **密钥不落配置**：只用 DSH 凭据服务里的 `DEEPSEEK_API_KEY`，插件配置文件里不出现任何密钥。
- 🪶 **零依赖、无构建**：宿主半是普通 ESM，浏览器半是手写客户端 bundle；没有 npm 依赖，也没有打包步骤。

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
- profile 的 `patchReload` 是 `live`：宿主半改动**不必重启 DSH**，但**每次改 `lib/index.js` 都要把 `?v=N` 加一**，否则会继续跑 ESM 缓存里的旧代码（详见「开发」一节）；
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

没有配置文件 —— 想要不同行为就改几个常数（改完刷新页面即生效）：

| 想要什么 | 常数 | 位置 | 默认 |
|---|---|---|---|
| 自动刷新间隔 | `REFRESH_MS` | `lib/client.js` | `60000`（60 秒） |
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
  │ 60s 定时 / 点击 ?refresh=1                credentials.resolve(DEEPSEEK_API_KEY)
  └ 渲染「余额：¥xxx」                        fetch api.deepseek.com/user/balance
                                             （25 秒内存缓存 + 在途去重 + 瞬时失败沿用旧值）
```

- **宿主半**（`lib/index.js`）只做取数，并经 **DSH 已鉴权的 `/api` 通道**下发。该通道自带
  Host/Origin 栅栏与浏览器会话鉴权，所以插件不必自己写鉴权、也不会漏掉它。
- **浏览器半**（`lib/client.js`）是**手写的客户端 bundle**（DSH 只要求
  `window.__ModuleLoader__.load({ id, factory })` 这一层 closure 契约，缺 sourcemap 也照跑），
  注册到官方声明的加性席位 `sidebar.footer.action` —— 也就是 `.footArea` 里 `sidebar.settings`
  的正上方。不改 DSH 前端，也不往 React 管理的 DOM 里塞节点。

## 开发

```
dsh-money/
├── package.json        # dsh.bundle.patch + dsh.client（platform / inject / immediately）
├── cordis.patch.yml    # bundle 挂载声明（dsh plugin add 用；手工装时不用它）
├── lib/
│   ├── index.js        # 宿主半：凭据 → 余额接口 → /api/dsh-money
│   └── client.js       # 浏览器半：注入样式 + 席位组件（余额 / 刷新态 / 紧凑态）
├── test/smoke.mjs      # 零依赖契约冒烟测试
└── LICENSE             # MIT
```

```powershell
node test/smoke.mjs     # 契约 / 换行样式 / 三套渲染 / 点击防抖
```

### 改哪里

| 想改 | 动哪 | 生效方式 |
|---|---|---|
| 文案、颜色、格式、刷新间隔 | `lib/client.js` | 刷新页面（DSH 按文件字节算 bundle rev） |
| 接口地址、超时、缓存、字段路径 | `lib/index.js` | **patch 里的 `?v=N` 加一**（见坑 3） |
| 挂到别的位置 | `ctx.slots.inject('<slot 名>', …)` | 刷新页面 |

### 四个容易踩的坑（都踩过）

1. **宿主半绝不能写 `export default`**：DSH Loader 取 `exports.default ?? exports`，一旦有默认导出，
   `inject` / `name` 会被整体丢弃，插件会在没注入任何服务的环境里运行（官方事故复盘 `docs/postmortem/0001`）。
2. **浏览器半必须是 closure 形态**：`window.__ModuleLoader__.load({ id, factory })`，`id` 等于包名，
   返回的 `module.exports` 上是**命名导出** `apply` / `inject`；不要写成 `module.exports = function`。
   `test/smoke.mjs` 就是守这两条的。
3. **改了 `lib/index.js` 必须改 patch 里的 `?v=N`**：profile 的 `patchReload: live` 只保证
   「patch 变了就重新组装」，**不会因为插件自己的 `.js` 变了就重新 import**；不改版本号就会继续跑
   ESM 缓存里的旧代码（实测踩过：新加的分支完全没生效，查了半天才发现是缓存）。
4. **给共用行加样式要穿过一层 `display: contents`**：DSH 的 slot 渲染器会给每个占位者套一层
   `display: contents` 的包装 div（错误边界），所以 `:has(> [data-testid="dsh-money"])` 命中的是那层
   **不生成盒子**的包装层，样式打上去等于没打。本插件改用类名后缀 `[class*="footerActions"]` 命中
   真正的行容器，并用 `:has(> * > [data-testid="dsh-money"])` 作为类名变动时的兜底。

### 与同席位其它插件共存

`sidebar.footer.action` 的官方占用者（如 `ui-cordis`）与第三方 `dsh-bg-new`（「壁纸」按钮）都用
`width: calc(100% + 4px)` 占满整行且不收缩 —— 这是「一行只住一个占满整行的占用者」的写法，两个同时
存在时**排在后面的会被顶出侧栏边缘**（本插件第一版就是这么消失的：按钮 x=268，而侧栏只到 268）。

因此本插件给这条共用的行加了 `flex-wrap: wrap`（**不修改任何其它插件的代码**）：壁纸占它自己那一行，
余额落到下一行，两边都完整可见。不想要这个换行，删掉 `lib/client.js` 里 `CSS_TEXT` 的第一条即可。

### 布局自检（排障用）

`lib/client.js` 顶部有 `const DIAG = false`。改成 `true` 后，浏览器半会在挂载 / 切宽窄 / 窗口变化时把
**这一行的实测布局**（自己与最近 4 层祖先的尺寸、`display`、`flex-wrap`、`overflow`，以及同容器里其它
兄弟按钮的 `flex` / 宽度）回传宿主，落在 `$DSH_HOME/.dsh-money-diag.json`：

```powershell
Get-Content "$env:DSH_HOME\.dsh-money-diag.json" -Raw   # 看 chain[0..3] 与 chain[1].kids
```

「被挤成一个字」「位置跑到侧栏外面」「根本没渲染」这类问题，靠它不用截图就能定位。

## 卸载

```powershell
dsh plugin --profile web remove dsh-money
```

手工装的（方式 D）：删掉 patch 里那两行，刷新页面即可。

## 已知限制

- 只显示 **DeepSeek 官方接口能查到的余额**（`/user/balance`），不提供消费流水。
- 余额是**快照**：接口不返回流水，充值/扣费发生在两次刷新之间时只能看到净变化。
- DSH 处于 developer preview，席位名与 `/api` 通道语义可能随版本变化；插件不生效时先看
  `dsh --profile web --dump-config` 里有没有 `dsh-money`。

## 许可证

[MIT](LICENSE) © 2026 sz1698
