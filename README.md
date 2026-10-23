<div align="center">

# ChatGPT 侧边栏

在浏览器侧边栏里随时用 ChatGPT。选中文字即可提问，也可以带上整页内容，用自定义提示词发问。

[![build](https://github.com/zhoudaxiaa/simple-chatgpt-sidebar/actions/workflows/build.yml/badge.svg)](https://github.com/zhoudaxiaa/simple-chatgpt-sidebar/actions/workflows/build.yml)
[![release](https://img.shields.io/github/v/release/zhoudaxiaa/simple-chatgpt-sidebar?color=10a37f)](https://github.com/zhoudaxiaa/simple-chatgpt-sidebar/releases/latest)

Chrome 116+ · Manifest V3 · 无依赖 · 无构建步骤

</div>

---

## 这是什么

一个 Manifest V3 扩展：把 ChatGPT 官网塞进浏览器原生侧边栏，再把当前网页的**标题、URL、选中文字**按模板拼成 prompt 送进输入框。

代码来自对商店扩展 **Simple ChatGPT Sidebar 1.3.0** 的逆向分析与重写 —— 修掉了原版三处影响可用性的缺陷，补上了中文界面，并把另一个独立的「ChatGPT Session Bridge」扩展合并了进来。

完整的分析过程（架构、链路、11 项缺陷、四次失败改造的死因）作为 [附录](#附simple-chatgpt-sidebar-130-逆向分析) 保留在本文后半部分。

## 安装

### 方式一：下载打包好的 zip（推荐）

到 [Releases](https://github.com/zhoudaxiaa/simple-chatgpt-sidebar/releases/latest) 下载 `simple-chatgpt-sidebar-*.zip`，解压后：

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择解压出来的目录
3. 首次使用需要在侧边栏里登录 ChatGPT

> Chrome 正式版已不允许用 `--load-extension` 命令行加载，必须走上面的界面流程。

### 方式二：从源码加载

```bash
git clone https://github.com/zhoudaxiaa/simple-chatgpt-sidebar.git
```

图标已随仓库提供，克隆后即可直接加载。若图标缺失，用纯 Python 重新生成（无 Pillow 依赖）：

```bash
python tools/make_icons.py
```

## 使用

| 入口 | 操作 |
| --- | --- |
| 工具栏图标 | 打开侧边栏 |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | 打开侧边栏 |
| 选中文字后右键 | 「问 ChatGPT」/「直接发送到 ChatGPT」 |
| 页面右键 | 「就这个页面问 ChatGPT」/「自定义提问…」 |
| 选中文字按 <kbd>Alt</kbd>+<kbd>G</kbd> | 把选中文字送到侧边栏 |

设置页（`chrome://extensions` → 详情 → 扩展程序选项）里可以增删改排序提示词、开关自动发送、配置桌面端同步。

## 功能

- **侧边栏内嵌 ChatGPT** —— 全屏 iframe 直连 `chatgpt.com`，扩展自己几乎没有 UI，只在顶部浮一条绿色 toast
- **两套提示词** —— 页面级 4 条、选中文字级 6 条，全部可在设置页增删改、拖动排序、临时删除后恢复
- **模板占位符** —— `{text}` 注入选中内容，`{title}` / `{url}` 注入页面信息，可关掉自动追加链接
- **自动填词** —— 用 `execCommand('insertText')` 写入 ProseMirror 编辑器，编辑器状态同步，发送按钮会正常点亮
- **自动发送（可选）** —— 先尝试点发送按钮，拿不到再退回合成 Enter
- **站外链接在浏览器标签页打开** —— 对话里点外链不会把面板导航走（侧边栏没有后退键），交给后台 `chrome.tabs.create`，在当前窗口开新标签；站内链接、登录跳转、`mailto:` 与下载仍走原样
- **登录态同步** —— 把 `chatgpt.com` / `openai.com` 的 Cookie 发给本机 Electron 套壳，省掉在桌面端重新登录（默认关闭需手动开）
- **全中文界面** —— 菜单、设置页、弹窗、提示条、默认提示词；已装过英文版的会就地迁移，用户改过的条目不动

## 目录结构

```
simple-chatgpt-sidebar/
├── manifest.json          MV3 清单
├── background.js          SW（ES module）：菜单 / 模板 / 投递 / 同步入口
├── session-bridge.js      登录态桥接：取 Cookie、去重、POST 到本机套壳
├── content.js             只回答 GET_SELECTION，供 Alt+G 命令调用
├── chatgpt-inject.js      注入 ChatGPT：MutationObserver 等待 + insertText
├── sidepanel.html/.js   面板页面：内联样式 + 延后挂载的 ChatGPT iframe + 发送提示 toast
├── options.html/.js/.css  提示词管理 + 桌面端同步配置
├── prompt-input.html/.js  自定义提示词弹窗
├── rules.json             DNR：剥离 XFO / CSP
├── shared/
│   ├── defaults.js        默认提示词唯一来源 + 英文旧数据迁移
│   └── template.js        占位符渲染（纯函数，可测）
├── icons/                 16 / 48 / 128，纯 Python 生成
├── tools/
│   ├── make_icons.py      无依赖 PNG 生成器
│   ├── build_zip.py       白名单打包，固定时间戳，可复现
│   ├── validate.py        清单引用 + DOM id 契约校验
│   └── test_bridge.mjs    桥接端到端测试（真起 http 服务）
├── test_template.mjs      模板渲染 + 迁移 + Cookie 去重单测
└── .github/workflows/
    └── build.yml          校验 → 测试 → 打包 → 发 Release
```

## 开发

```bash
# 静态校验：清单引用是否都存在、页面里的 id 是否都能被脚本取到
python tools/validate.py

# 单元测试：模板渲染 / 英文旧数据迁移 / Cookie 去重（34 例）
node test_template.mjs

# 投递链路：vm 里跑真实注入脚本，验证认领 / 回执 / 失败清理 / TTL / 外链路由（44 例）
node test_delivery.mjs

# 页面身份回退链：content script → activeTab 注入 → Tab 字段（6 例）
node test_page_info.mjs

# 端到端：真起一个 node:http 服务验证桥接请求（10 例）
node tools/test_bridge.mjs

# 打包（默认出 zip）
python tools/build_zip.py --out dist/package.zip

# 只出干净的未打包目录，给 chrome://extensions 加载用
python tools/build_zip.py --unpacked

# 目录和 zip 都要
python tools/build_zip.py --unpacked --with-zip
```

`chrome://extensions` 的「加载已解压的扩展程序」只认**目录**，不接受 zip。直接选仓库根目录也能跑（Chrome 只按 `manifest.json` 的引用加载，测试脚本不会被读），但根目录里有 `dist/`、`tools/`、若干 `test_*.mjs`，眼不见为净的话就用 `--unpacked` 出的 `dist/unpacked/`——它和 zip 的内容逐字节同源，只有白名单里那 20 个文件。

推送到 `main` 会跑完整流水线并把 zip 作为 artifact 上传；打 `v*` 标签会额外发一个 Release 并附上资源包，标签名必须与 `manifest.json` 里的 `version` 一致，不一致流水线直接失败。

发版就三步：改 `manifest.json` 的 `version` → 提交推送 → `git tag v<version> && git push origin v<version>`（标签名必须与 manifest 一致）。

## 已知限制

- **关闭面板会重载 ChatGPT**。`chrome.sidePanel` 没有「隐藏但不销毁」的接口，面板关闭即销毁文档，下次展开重新加载（有缓存，1–2s）。这是浏览器行为，扩展侧无法规避，详见 [08 改造尝试与回退](#08-改造尝试与回退)。
- **侧边栏宽度不可编程**。`chrome.sidePanel` 的 `PanelOptions` 只有 `enabled` / `path` / `tabId`，没有任何宽度相关接口，宽度只能用户手动拖。
- **依赖第三方页面的 DOM 与登录态**。输入框选择器随时可能失效；iframe 内的登录依赖第三方 Cookie，Chrome 的分阶段限制会让「侧边栏里登录不上」成为常见故障；Cloudflare 也可能直接拦截被嵌入的请求。
- **剥离 CSP / X-Frame-Options 是双刃剑**。规则只对 `chatgpt.com` / `openai.com` 的 `sub_frame` 生效，但语义上就是关闭目标站点的防嵌入保护，这类行为在 Chrome 应用商店审核中容易被判定为规避安全机制。

## 免责声明

本项目是对一个第三方扩展的学习性逆向分析与重写，与原作者无关，未获其授权，也不包含原包的任何二进制产物。分析对象为商店版本 `Simple ChatGPT Sidebar 1.3.0.crx`，结论全部来自对解包后源码的静态阅读与本地验证。

「ChatGPT」「OpenAI」是其各自权利人的商标，本项目与之无从属关系。请自行承担使用风险，尤其是登录态同步功能涉及账号凭据。

---

# 附：Simple ChatGPT Sidebar 1.3.0 逆向分析

> 以下为原始分析报告全文，已从 HTML 版转为 Markdown。原 HTML 版含交互式架构图，视觉上更完整。

## 01 它做了什么

本质上它不是一个「ChatGPT 客户端」，而是一个 **上下文搬运工**：把当前网页的标题、URL、选中文字，按模板拼成一段 prompt，送到侧边栏里的 ChatGPT 输入框。

**入口**

- 点工具栏图标（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>）打开侧边栏
- 页面右键 → *Ask ChatGPT about this page*
- 选中文字右键 → *Ask ChatGPT*
- 选中文字按 <kbd>Alt</kbd>+<kbd>G</kbd>

**产出**

侧边栏 = 一个全屏 iframe 直连 `chatgpt.com`，扩展自己几乎没有 UI，只在顶部浮一条绿色 toast 告诉你「已发送」。

**能力边界**

| 能力 | 实现方式 |
| --- | --- |
| 侧边栏内嵌 ChatGPT | iframe + 动态规则剥离 `X-Frame-Options` / `CSP` |
| 页面 / 选中文字两套右键菜单 | 二级 `contextMenus`，菜单项由 storage 里的提示词列表动态生成 |
| 自定义提示词库 | 选项页增删改排序、启用开关、会话级回收站、恢复默认 |
| 自动填词 | 内容脚本监听 storage，把文本写进 ChatGPT 的 contenteditable 编辑器 |
| 自动发送（可选） | 模拟 Enter 键或点击发送按钮 |

## 02 架构：四个执行上下文

扩展代码分布在四个互相隔离的 JS 环境里，它们之间只能靠 `chrome.runtime` 消息和 `chrome.storage` 通信 —— 这一点决定了整个设计的形态。

```
UI 层      右键菜单          侧边栏 sidepanel.html    设置页 options.html     自定义提示词窗
           contextMenus      iframe + toast          CRUD / 排序            prompt-input.html
                │                    ▲                     │                      │
                │ onClicked          │ sidePanel.open()    │ REBUILD_MENUS        │ 提交 prompt
                ▼                    │                     ▼                      ▼
后台层      ┌──────────────────────────────────────────────────────────────────────┐
           │ background.js · Service Worker                                       │
           │ 菜单构建 · 模板渲染 · sidePanel.open() · 投递 paste:<id> → 等回执   │
           │ MV3 下随时会被回收，因此所有状态都放在 chrome.storage，不驻留内存      │
           └──────────────────────────────────────────────────────────────────────┘
                │ tabs.sendMessage                      │ storage.onChanged
                ▼                                       ▼
页面层      content.js                             chatgpt-inject.js
           注入所有普通网页                        注入 chatgpt.com 的每一帧（all_frames）
           只负责返回当前选区文本                  写输入框 · 闪烁反馈 · 可选自动发送

平台层      chrome.storage        chrome.sidePanel      chrome.contextMenus    declarativeNetRequest
           sync: 提示词          需用户手势 open()      重建前必须 removeAll   剥离 XFO / CSP（关键）
           local: 投递
```

**为什么「侧边栏」是 iframe 而不是自建聊天界面**

自建界面意味着要自己对接 API、维护会话、渲染 Markdown —— 作者选择直接嵌入官网，代价是必须绕过 ChatGPT 的防嵌入响应头，并且完全失去对页面内部状态的控制权。这个取舍是整个扩展所有技术难点与脆弱性的根源。

## 03 核心链路：右键 → 输入框

以「选中一段文字 → 右键 → Explain this」为例，这是插件最常用、也最容易出 bug 的路径。

**1. 菜单项被点击** `background.js`

Chrome 把 `info.selectionText` 和 `tab`（含 title / url）交给 `contextMenus.onClicked`。此时仍处于用户手势窗口内，必须立刻调用 `chrome.sidePanel.open()` —— 原版代码在这里有一句很关键的注释，说明为什么不能等 popup 打开后再调用。

**2. 模板渲染** `background.js`

按菜单 id 找到对应提示词，把 `{text}` 替换成选中内容；页面级提示词还会追加 `标题：…` / `链接：…` 两行。`includeUrl` 为 false 时跳过追加，标题或链接缺失的那一行也不会写（否则会发出空标签，纯属浪费一次提问）。

这里有个坑：`contextMenus.onClicked` 给的 `tab` 上 `url` / `title` 默认是空的 —— Chrome 只在扩展拥有 `tabs` 权限、或对该页面有 host 权限时才填。本扩展两者都没有（也不想要那个「读取浏览历史」的权限提示），所以改成向页面里的 `content.js` 要 `document.title` 和 `location.href`，在页面内读这两个值不需要任何权限。

**3. 投递** `chrome.storage.local`

每次投递写一个**独立的** `paste:<id>` 键，而不是共用一个槽位。写入即广播，写入方不需要知道谁在监听、iframe 有没有加载完；独立键让消费方只删自己认领的那一条，两条投递不会互相覆盖，也不存在数组队列的「读-改-写」丢更新。

**4. 消费 + 回执** `chatgpt-inject.js`

只有「父文档是 `chrome-extension://` 且本帧能找到输入框」的 frame 才认领投递。它最多等 20 秒让 ChatGPT 的 SPA 起来，写入后用**空白无关**的比对确认真进了编辑器，然后写 `pendingPasteAck = {id, ok, reason}`，最后删掉自己认领的那个键。超过 30 秒的投递直接丢弃，不会在下次开面板时重放。

**5. 反馈** `sidepanel.js`

面板先弹「正在发送…」，等的是**回执**而不是写入：`ok` 才显示「已填入输入框」，失败给出具体原因，25 秒收不到回执就提示重试。

> **这里踩过的坑：写入成功 ≠ 插入成功**
>
> 早期版本在 `pendingPaste` 一被写入时就弹「已发送到 ChatGPT」，而这时面板可能刚打开、ChatGPT 还在加载。消费端等 3 秒拿不到输入框就 `return`，既不清键也不报错 —— 于是 toast 说成功、输入框是空的。更糟的是那句 `element.textContent.trim() !== text.trim()`：ProseMirror 把 `\n\n` 变成多个段落，`textContent` 拼接后不含换行，多行提示词必然比对失败，于是走进「清空 + 塞一个 `<p>`」的破坏性回退，绕过编辑器 state，下一次 React 渲染就把字擦掉了。
>
> 所以投递变成了两段式：写入只代表「交出去了」，成功与否只由回执说了算。

> **原版在这里有一处竞态**
>
> 原版的 `sidepanel.js` 收到 `selectedText` 后，又会去写 `pendingPaste`，而它自己正是 `selectedText` 的监听者；同时它还会 `postMessage` 给 iframe。结果同一条文本有三条路径抵达输入框，靠「先清空再写入」掩盖了重复，但会覆盖用户已经手打的内容。

## 04 技术拆解

### ① 把 chatgpt.com 塞进 iframe：DNR 剥离响应头

ChatGPT 会返回 `X-Frame-Options: DENY` 与带 `frame-ancestors` 的 CSP，浏览器因此拒绝任何页面嵌入它。`rules.json` 用声明式规则在响应阶段删掉这两个头。

`urlFilter: "||chatgpt.com"` + `resourceTypes: ["sub_frame"]`，对 `X-Frame-Options` 与 `Content-Security-Policy` 执行 `remove`。条件限定 `sub_frame` 是必要的 —— 只影响被嵌入的请求，不影响正常访问。

这套规则由浏览器内核在网络层执行，不需要拦截请求体，也不需要 `webRequest` 阻塞式权限，这是 MV3 时代唯一可行的做法。

### ② 侧边栏的生命周期

`sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` 让点击图标直接开面板，省掉一个 action 监听器。面板页面在关闭时被销毁，所以每次打开 iframe 都会重新加载 ChatGPT —— 这也解释了为什么插件要把待粘贴文本先落到 storage，而不是直接 postMessage。

### ③ 菜单即数据

菜单结构完全由 `chrome.storage.sync` 里的两个数组决定：`pagePrompts` 与 `selectionPrompts`。每次修改都 `removeAll()` 后按顺序重建，因此「排序」功能不需要额外的字段，数组顺序就是菜单顺序。

### ④ 往 contenteditable 里写字的正确姿势

ChatGPT 的输入框是 ProseMirror（React 包一层）。直接 `innerHTML = text` 能看见字，但编辑器内部状态没变，发送按钮仍是灰的。`document.execCommand('insertText', …)` 走的是浏览器编辑管线，会触发 `beforeinput` / `input`（`inputType: insertText`），这正是 ProseMirror 监听的事件，状态才会同步。

> **原版恰好用了错误的那一种**
>
> 原版 `chatgpt-inject.js` 先 `innerHTML = ''` 再 `appendChild(<p>)`，只在最后补发一个 `InputEvent`。在 ProseMirror 上这经常导致「字进去了、发不出去」，或者一输入就被编辑器自身的 state 覆盖回去。这是重建版改动最大的一处。

### ⑤ 自动发送：为什么不点按钮

原版选择合成 `Enter` 的 `keydown`（`keyCode: 13`）。思路是对的 —— ChatGPT 的发送按钮选择器随版本频繁变化，而 Enter 的语义稳定。但它没有处理「React 还没把按钮/状态刷新完」的时序问题，于是固定 `setTimeout(500)`。重建版改为：先等 400ms 尝试点击 `button[data-testid="send-button"]`，拿不到再退回合成 Enter。

### ⑥ 会话级回收站

删除不直接销毁，而是推进一个内存数组 `trash`；关闭设置页即清空。这个设计很讨巧：既给了误删的后悔药，又完全不用考虑 storage 配额与过期清理。代价是关页面就真的找不回来了。

## 05 代码清单

13 个源文件，2766 行。没有构建步骤、没有依赖、没有压缩混淆，属于可直接阅读的「手写风格」代码。

| 文件 | 行数 | 职责 |
| --- | ---: | --- |
| `options.js` | 639 | 设置页全部逻辑：CRUD、排序、开关、回收站、恢复默认 |
| `options.css` | 510 | 设置页样式（暗色、双栏、弹窗、toast） |
| `background.js` | 368 | 菜单构建、模板渲染、点击分发、消息路由 |
| `chatgpt-inject.js` | 262 | 写入 ChatGPT 输入框、闪烁反馈、自动发送 |
| `prompt-input.html` | 195 | 自定义提示词弹窗（内联样式） |
| `sidepanel.js` | 168 | toast 管理、向 iframe 发消息 |
| `options.html` | 155 | 设置页结构（3 个弹窗 + 双栏列表） |
| `styles.css` | 136 | 侧边栏样式 |
| `prompt-input.js` | 113 | 弹窗逻辑、占位符替换 |
| `manifest.json` | 90 | 清单 |
| `content.js` | 51 | 选区读取 + Alt+G 快捷键 |
| `rules.json` | 44 | DNR 规则 2 条 |
| `sidepanel.html` | 35 | 侧边栏结构（iframe + toast） |

另有 `icons/` 三个尺寸、`_metadata/`（Chrome 生成的完整性清单与编译后的 DNR 规则集）。CRX3 结构为 12 字节魔数 + 1309 字节头（RSA 公钥与签名）+ 34827 字节 ZIP 载荷。

## 06 问题清单

以下均基于对源码的逐行阅读，不是猜测。前三条会直接影响可用性，复现版已全部修正。

| 等级 | 位置 | 问题与影响 |
| --- | --- | --- |
| **高** | `chatgpt-inject.js`<br>pasteIntoInput | 用 `innerHTML` 写入 ProseMirror 编辑器，编辑器状态不同步。表现为「字进去了但发送按钮不亮 / 一按就消失」。正确做法是 `execCommand('insertText')`。 |
| **高** | `chatgpt-inject.js`<br>pasteIntoInput 重试 | 找不到输入框时 `setTimeout(…, 500)` 自我递归，**没有上限**。在登录页、错误页或未登录状态下会无限重试，直到页面关闭。 |
| **高** | `sidepanel.js`<br>handleIncomingText | 收到 `selectedText` 后又写 `pendingPaste`，同时再 `postMessage`。一条文本三条投递路径，重复粘贴并覆盖用户已手打内容。 |
| 中 | `content.js`<br>keydown | Alt+G 由内容脚本发消息给 SW，再调 `sidePanel.open()`。用户手势不跨上下文传播，这个调用大概率被拒（"must be called in response to a user gesture"）。应改用 `commands` API，让 SW 自己拿到手势。 |
| 中 | `background.js`<br>菜单 id | 菜单 id 用数组下标（`sel_0` / `page_1`），点击时再按「当前过滤后的数组」取下标。如果用户在菜单已展开时改了设置，下标会错位到另一条提示词。 |
| 中 | `manifest.json` | 缺 `minimum_chrome_version`（`sidePanel` 需要 114，`open()` 需要 116），老版本浏览器上会以「插件坏了」的形式失败而非明确提示。 |
| 中 | `manifest.json`<br>web_accessible_resources | 把 `chatgpt-inject.js` 与 `prompt-input.html` 暴露给 `<all_urls>`，任何网站都能探测到扩展安装（指纹）并读取这些资源。二者都不需要被网页访问。 |
| 低 | `manifest.json` | `clipboardWrite`、`activeTab` 实际未被使用；toast 文案还写着 "Text copied! Press Ctrl+V to paste"，是早期「复制到剪贴板」方案的残留。 |
| 低 | `content.js`<br>GET_SELECTION | 实现了选区查询的消息处理器，但全代码库没有任何地方发送该消息 —— 死代码。 |
| 低 | `background.js` + `options.js` | 默认提示词表在两个文件里各写一遍（且字段不完全一致：一处带 `enabled`，一处不带），改一处忘另一处就会漂移。 |
| 低 | `chatgpt-inject.js`<br>message 监听 | `window.addEventListener('message')` 不校验 `event.origin`，任何能向该帧发消息的上下文都可以触发粘贴。 |

## 07 复现

重建版保持原有的交互与视觉，但把上面标红的架构问题重做了一遍。

### 关键改动对照

| 维度 | 原版 | 重建版 |
| --- | --- | --- |
| 投递通道 | storage + postMessage 双通道，侧边栏回写自己监听的键 | 只有 storage 一个写入口；投递带唯一 id，消费后清除，天然幂等 |
| 写入编辑器 | `innerHTML` + 补发 InputEvent | `execCommand('insertText')` 优先，失败才降级 DOM 方案 |
| 等待输入框 | 无限 `setTimeout` 递归 | `MutationObserver` + 超时返回 null |
| 快捷键 | 内容脚本监听 keydown → 跨上下文调 open() | `commands` 声明 Alt+G，SW 内处理，手势合法 |
| 菜单标识 | 数组下标 | 提示词 id（`sel|chatgpt-explain`） |
| 默认值 | 两处硬编码副本 | `shared/defaults.js` 单一来源，SW 首次安装时落库 |
| 自动发送 | 固定延迟后合成 Enter | 先点发送按钮，再退回 Enter |
| 权限 | 6 项，含未使用的 clipboardWrite / activeTab | 5 项：在原有 4 项基础上新增 `cookies`（登录态桥接需要），仍移除未用权限与 `web_accessible_resources` |
| 桌面端同步 | 不存在，需另装一个扩展 | 并入本扩展：`cookies` 读 `chatgpt.com` / `openai.com`（含子域）→ 去重 → POST 到本机套壳；地址、令牌、是否自动同步都在设置页可改 |
| 侧边栏宿主 | `chrome.sidePanel`，只能开，无关闭接口 | `chrome.sidePanel`；失败时回退到独立窗口，登录态同样正常 |
| 界面语言 | 全英文 | 全中文：菜单、设置页、弹窗、提示条、默认提示词；已装过英文版的会就地迁移（`localizePrompts` 逐字段比对，只替换仍等于英文默认值的字段，用户改过的和自定义条目不动） |
| 图标 | OpenAI 商标图案 | 自绘对话气泡（避免商标问题） |

### 把第二个扩展并进来

原本另有一个只做一件事的小扩展：读浏览器里的 ChatGPT Cookie，POST 给本机跑的 Electron 套壳，省掉在套壳里重新登录一遍。把它并进本扩展后，用户只需要装一个。合并时有三处必须改，否则会互相打架。

**一、工具栏图标冲突。** 原扩展的触发方式是「点图标就同步」，但本扩展的图标已经绑给了 `chrome.action.onClicked` 开侧边栏。一个扩展只能有一个 `onClicked`，所以同步改挂到两处：右键菜单的「同步登录态到桌面端」，以及设置页里的「同步」按钮。

**二、每次唤醒都发请求。** 原扩展在脚本顶层直接 `void collectAndSend()`，看着像「启动时跑一次」，其实 MV3 的 Service Worker 大约每 30 秒就会被回收，下一次事件再把它拉起来，顶层代码就再跑一遍 —— 等于整天反复往本机端口打请求。改成挂在 `onInstalled` 和 `onStartup` 上：只在安装 / 更新 / 浏览器真正启动时同步。

**三、Cookie 归属域。** 只查 `chatgpt.com` 会漏掉 `auth.openai.com` 上的登录态。改成按父域 `chatgpt.com` / `openai.com` 各查一次（`getAll({domain})` 本身包含子域），再按 `domain + name + path` 去重 —— 同名不同 path 的 Cookie 必须都留着，否则会话会残缺。桥接逻辑抽成纯函数放在 `session-bridge.js`，`syncSession()` 永不抛异常，只返回 `{ ok, count, reason }`，由调用方决定怎么提示（徽标 ✓ / 0 / !，或设置页的文字状态）。

### 验证结果

| 检查项 | 结果 |
| --- | --- |
| JS 语法（5 个 ESM + 4 个经典脚本） | 全部通过 `node --check` |
| JSON 合法性（manifest / rules） | 通过 |
| 模板渲染 / 迁移 / 去重单测 | 20 / 20 通过（占位符、includeUrl、空模板、英文旧数据迁移、Cookie 去重） |
| 桥接端到端测试 | 10 / 10 通过（真起 `node:http` 服务，校验请求头、请求体、空 Cookie 短路、401 透出、端口关闭时的失败分支） |
| 清单引用完整性 | 9 个引用全部存在 |
| DOM id 契约 | 3 组页面/脚本，43 个 id 全部可解析 |
| 设置页渲染 | 注入 chrome 桩后无头截图确认：常规设置、桌面端同步、两列提示词列表均正常，开关选中态为绿色 |
| 打包 | 19 个文件 / 34881 字节，CRC 校验通过 |

## 08 改造尝试与回退

中途提过一个需求：页面上加个悬浮按钮，点一下展开 / 收起侧边栏，而且 **不能每次都重载 ChatGPT**。这条需求试了四轮都没能同时满足，最终 **整体回退**：只保留浏览器侧边栏，不加悬浮按钮。下面把四次尝试和各自的死因记下来，避免以后重走。

> **第一道墙：跨站 iframe 拿不到会话 cookie**
>
> cookie 是否随请求发送，取决于 `site-for-cookies` —— 它由**顶层帧**决定。chatgpt.com 的会话 cookie 是 `SameSite=Lax`，被普通网页以 iframe 嵌入时属于跨站请求，浏览器直接不发这个 cookie，于是 iframe 里显示的是未登录落地页。改 Chrome 的第三方 cookie 设置也没用：拦它的是 SameSite，不是第三方 cookie 策略。
>
> 而扩展页面（`chrome-extension://`）对声明了 host 权限的目标站点，会被 Chrome 当作第一方，cookie 正常发送。所以 **面板必须是顶层扩展页面** —— 这条约束直接淘汰了「页面内浮层」。

### 四次尝试

| 方案 | 登录态 | 收起后 | 死因 |
| --- | --- | --- | --- |
| ① 页面内浮层 | 无 | iframe 常驻，无重载 | 被 SameSite 判死：面板必须是顶层扩展页面 |
| ② 浏览器侧边栏 | 正常 | 文档销毁 | 每次展开都重载 ChatGPT；`sidePanel` 只有 `open()`，没有 hide |
| ③ 停靠窗口 + 最小化 | 正常 | 最小化 | 部分 Chrome 构建在最小化时**会卸载渲染器**，恢复即重载 |
| ④ 停靠窗口 + 自检 | 正常 | 移出屏幕 / 最小化 | 能做到不重载，但代价是**一个独立的 OS 窗口**：占任务栏、Alt+Tab 里有一项、点回网页就被压到后面。这不是「侧边栏」，是第二个窗口。 |

### 第四轮为什么还是被否掉

Chrome 没有「隐藏但不销毁」的接口。文档能否存活，等价于承载它的窗口能否存活，而「藏窗口」只有两条路：`minimize`（部分构建会顺手卸载页面）和 `park`（`state:'normal'` + `left:-32000`，Chrome 认为它还在屏幕上，所以不卸载）。

为了让「到底有没有重载」变成可观测的事实，实现里加了两个自检：面板每次加载把 `storage.local.panelBoot.count` +1 并显示 `加载 #N`；收起后 400ms 向面板发 `PING_PANEL` 探活，无人应答就判定被卸载，自动把策略从 `minimize` 改判为 `park`。技术上是成立的 —— 但结论是：**想不重载，就必须常驻一个 OS 窗口**。既然要的是「侧边栏」，这个代价不划算，于是整体回退。

**回退后的形态** —— 也就是当前交付的版本：

- 面板只有一种宿主：`chrome.sidePanel`，原生侧边栏，和浏览器一体
- 三个入口都指向它：工具栏图标、<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>、右键菜单里的「打开侧边栏」
- 页面上**没有任何注入 UI**；`floating.js` 及其设置项已删除
- 停靠窗口、窗口宽度、收起方式、悬浮按钮开关 —— 这些设置项一并移除，设置页回到「常规 + 两列提示词」

代价很明确：**关闭面板会销毁文档，下次展开重新加载 ChatGPT**（有缓存，1–2s）。这是 Chrome 的 `sidePanel` 行为，扩展侧无法规避；接受它，换来的是原生侧边栏的形态。

### 唯一保留的兜底

`chrome://`、应用商店、PDF 阅读器这类页面会拒绝 `sidePanel.open()`。这种情况下回退到打开一个独立窗口加载同一个 `sidepanel.html` —— 它仍然是顶层扩展页面，登录态正常，只是形态变成了窗口。

## 09 风险提示

> **剥离 CSP / X-Frame-Options 是双刃剑**
>
> 这条规则只对 `chatgpt.com` 与 `openai.com` 的 `sub_frame` 生效，影响面被限制得比较窄。但它在语义上就是「关闭目标站点的防嵌入保护」，这类行为在 Chrome 应用商店审核中容易被判定为规避安全机制。若只供自用（加载已解压），不涉及上架问题。

> **可用性依赖第三方页面的 DOM 与登录态**
>
> 输入框选择器（`#prompt-textarea` 等）随时可能失效；iframe 内的登录依赖第三方 Cookie，Chrome 的分阶段限制会让「侧边栏里登录不上」成为常见故障；Cloudflare 也可能直接拦截被嵌入的请求。这是嵌入方案的固有代价，任何实现都绕不过去。

> **登录态桥接是全项目最敏感的一环**
>
> 它把 `chatgpt.com` / `openai.com` 的完整 Cookie 以明文 POST 到 `http://127.0.0.1:32123`。这些 Cookie 等价于账号凭据，拿到即可冒充登录。因此有几点必须守住：地址必须留在回环网段（不要改成局域网 IP 或域名）；`x-bridge-token` 只是「防止别的网页误打误撞」的弱校验，不是加密，本机上任何进程都能监听这个端口并抢答。默认开启自动同步意味着每次浏览器启动都会重发一次，若不需要桌面端，请在设置页把开关关掉 —— 关掉后扩展不会再读 Cookie。

> **关于原包的来源**
>
> 包内 `manifest.json` 含 `update_url` 指向 Chrome 应用商店，`_metadata/verified_contents.json` 结构完整，代码无混淆、无远程加载、无数据外传行为（唯一的网络目标是 chatgpt.com / openai.com）。从静态特征看不像被二次打包的篡改版本，但「看起来正常」不等于可信 —— 凡是能读取全站页面内容的扩展，都应当先审代码再启用。
