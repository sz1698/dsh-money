# dsh-money 开发说明

面向改这份代码的人（包括将来的自己）。用户向的说明见 [README](../README.md)。

## 改哪里

| 想改 | 动哪 | 生效方式 |
|---|---|---|
| 文案、颜色、格式、刷新间隔 | `lib/client.js` | 刷新页面（DSH 按文件字节算 bundle rev） |
| 接口地址、超时、缓存、字段路径 | `lib/index.js` | profile patch 里的 `?v=N` 加一（见下） |
| 挂到别的位置 | `lib/client.js` 里的 `ctx.slots.inject('<slot 名>', …)` | 刷新页面 |
| 设置项本身（增删字段 / 改范围 / 改默认值） | **两处都要改**：`lib/index.js` 的 `buildSettingsSchema()` + `lib/client.js` 的 `DEFAULT_SETTINGS` 与卡片控件 | 宿主改完要 `?v=N` 加一；卡片改完刷新页面 |
| 手动装的路径 | `$DSH_HOME/profiles/web/cordis.patch.yml` 的那一行 | 立刻（该 profile 是 `patchReload: live`） |

### 设置项为什么是「宿主 schema + 浏览器卡片」两半

DSH 的「设置 → 插件 → 可配置」页签**按 settings 命名空间列表渲染**（`settingsScope.describe()`），
每个命名空间渲染一张由**插件自己**提供的卡片（keyed slot `settings.plugin.item`，key = 命名空间）。
所以：

- 宿主 `ctx.inject(['settings'], sctx => sctx.settings.register(NAMESPACE, schema))` → 出现在那个页签里；
  命名空间必须匹配 `/^[a-z][a-z0-9-]*$/` 且全局唯一（重复注册抛错）。
  用 `ctx.inject` 而不是把 `settings` 写进本插件的 `inject`：settings 缺失时这段保持未激活，
  插件照常取余额，也不会把整个插件拖成 INACTIVE。
- 浏览器 `ctx.settingsScope.bind({ namespace })` 读快照（`getSnapshot` / `subscribe`），
  用 `scope.set(field, value)` 写单个字段；卡片注册到 `settings.plugin.item` 的 key=NAMESPACE。
  余额行与卡片是两个 slot 根，所以设置放在模块级 store 里共享（`createSettingsStore`）。
- `schema` 必须是**真的 schemastery 对象**：settings 服务会调 `schema.toJSON()` 把 schema 下发给卡片、
  调 `schema(value)` 解析取值。因此本插件有一个运行时依赖 `@deepseek-ai/schemastery`
  （`npm install` 后随包声明在 `dependencies`）。
- schema 的 `.default()` 就是"没配过的人"看到的行为；浏览器半在快照到达前先用本地
  `DEFAULT_SETTINGS` 渲染 —— **两份默认值必须逐字段一致**，否则首帧会跳一下。

验证命名空间是否注册成功（不用开浏览器，用 DSH 自己的 RPC）：

```powershell
# 取会话 token 换 cookie（见 README「装完自检」第 1 步），然后：
$rpcId = [guid]::NewGuid().ToString()
$body = @{ type='client-request'; rpcId=$rpcId; method='settings/describe'; payload=@{ args=@{} } } | ConvertTo-Json -Depth 6 -Compress
$bf = "$env:TEMP\rpc.json"; [System.IO.File]::WriteAllText($bf, $body, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -b $jar -H "content-type: application/json" --data-binary "@$bf" "http://127.0.0.1:57321/api/settings/describe" |
  Select-String 'dsh-money'     # 出现在 namespaces 里 = 注册成功
```


## 两个必须遵守的契约

1. **宿主半不能写 `export default`**：DSH Loader 取 `exports.default ?? exports`。一旦有默认导出，
   它拿到的是裸的 apply 函数，同级命名导出 `inject` / `name` 被整体丢弃，插件会在没注入任何服务的
   环境里运行，报 `cannot get property "xxx" without inject`（官方事故复盘 `docs/postmortem/0001`）。
2. **浏览器半必须是 closure 形态**：`window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于
   `package.json` 的 `name`，返回的 `module.exports` 上是**命名导出** `apply` / `inject`；不要写成
   `module.exports = function`。`test/smoke.mjs` 用 React 桩把这两条守住了。

## 三个实测陷阱

### 1. 改了 `lib/index.js` 必须把 patch 里的 `?v=N` 加一

profile 的 `patchReload: live` 只保证「patch 文件变了就重新组装」——**插件自己的 `.js` 变了不会触发
重新 import**，宿主会继续跑 ESM 缓存里的旧代码。表现是「代码明明改了、行为一点没变、也没有报错」。

```yaml
- insert:
    - id: dsh-money
      name: 'file:///C:/project/deepseek-workspace/dsh-money/lib/index.js?v=2'   # 每次改宿主 +1
```

### 2. 给共用的行加样式，要穿过一层 `display: contents`

`sidebar.footer.action` 是被共用的横向 flex row，默认 `flex-wrap: nowrap`；而 DSH 官方占用者
（`ui-cordis`）和第三方 `dsh-bg-new`（「壁纸」按钮）都用 `width: calc(100% + 4px)` 占满整行且
`flex-shrink: 0`。两个这样的项同时存在时，**排在后面的那个会被顶出侧栏右边缘**（实测：按钮落在
`x=268`，而侧栏只到 268，于是完全不可见）。

更麻烦的是：**slot 渲染器会给每个占位者套一层 `display: contents` 的包装 div（错误边界）**，
所以 `:has(> [data-testid="dsh-money"])` 命中的是那层不生成盒子的包装层，`flex-wrap` 打上去等于
没打。必须命中真正的行容器：

```css
[class*="footerActions"] { flex-wrap: wrap }                                        /* 主：类名后缀 */
:has(> [data-testid="dsh-money"]), :has(> * > [data-testid="dsh-money"]) { … }       /* 兜底：隔一层才命中 */
```

配套的还有 `order`：`order: 20` 让余额排在壁纸之后 → 余额落在壁纸的下一行、紧贴「设置」。

### 3. 浏览器半的视觉问题，不开浏览器也能定位

`lib/client.js` 顶部的 `const DIAG = false` 改成 `true`，浏览器半会在挂载 / 切宽窄 / 窗口变化时把
**这一行的实测布局**回传宿主（`?diag=` → `$DSH_HOME/.dsh-money-diag.json`）：

- `chain[0]`：自己（tag / 实测 rect / display / flex / width / overflow）
- `chain[1..3]`：最近三层祖先（含 `flexWrap`、`justifyContent`、`kids` —— 同容器里其它兄弟按钮的
  `flex` 与宽度）

「被挤成一个字」「位置跑到侧栏外」「根本没渲染」都能直接读出来，不需要截图来回确认。发布版默认关闭。

## 自测

```powershell
node test/smoke.mjs
```

覆盖：模块 id / 命名导出 / inject 声明、两个席位的注册参数（`sidebar.footer.action` 的 order、
`settings.plugin.item` 的 key）、注入 CSS（换行规则必须命中真正的行）、三套渲染
（展开态 / 轨道态 / 刷新态「获取余额中」+ spinner + `aria-busy`）、**设置驱动显示**
（关前缀 / 0 位小数 / 关点击）与**卡片写入**（`select` / `checkbox` 的 onChange 真的调到
`settingsStore.set`）、点击防抖（连点只发一个请求，且带 `?refresh=1`）。

真机验证（带会话的 curl 与 `settings/describe`）见 README「装完自检」与本文件上一节。

## 已知取舍

- 余额只有快照：官方 `/user/balance` 不返回流水，充值/扣费落在两次观测之间时只能看到净变化。
- 定时刷新用 60 秒（`REFRESH_MS`），比宿主 25 秒缓存长，因此每次定时都真的打到上游；缩短间隔时记得
  同步考虑宿主侧的 `CACHE_MS`。
