# dsh-money 开发说明

面向改这份代码的人（包括将来的自己）。用户向的说明见 [README](../README.md)。

## 改哪里

| 想改 | 动哪 | 生效方式 |
|---|---|---|
| 文案、颜色、格式、刷新间隔 | `lib/client.js` | 刷新页面（DSH 按文件字节算 bundle rev） |
| 接口地址、超时、缓存、字段路径 | `lib/index.js` | profile patch 里的 `?v=N` 加一（见下） |
| 挂到别的位置 | `lib/client.js` 里的 `ctx.slots.inject('<slot 名>', …)` | 刷新页面 |
| 手动装的路径 | `$DSH_HOME/profiles/web/cordis.patch.yml` 的那一行 | 立刻（该 profile 是 `patchReload: live`） |

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

覆盖：模块 id / 命名导出 / 席位与 order、注入 CSS（换行规则必须命中真正的行）、三套渲染
（展开态 / 轨道态 / 刷新态「获取余额中」+ spinner + `aria-busy`）、点击防抖（连点只发一个请求，
且带 `?refresh=1`）。

真机验证（带会话的 curl）见 README「装完自检」。

## 已知取舍

- 余额只有快照：官方 `/user/balance` 不返回流水，充值/扣费落在两次观测之间时只能看到净变化。
- 定时刷新用 60 秒（`REFRESH_MS`），比宿主 25 秒缓存长，因此每次定时都真的打到上游；缩短间隔时记得
  同步考虑宿主侧的 `CACHE_MS`。
