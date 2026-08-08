# AstrBot DevKit In VSCode

> [!WARNING]
>
> 本项目还处于早期测试阶段，虽然已经出现可用版本，但是并没有进行大量实际测试，插件内部的大量逻辑可能会出现问题，在未来我们也会进行大量改进和优化，敬请期待。

> [!WARNING]
>
> 此外，目前该插件为第三方插件，和 AstrBot 项目本身没有严格意义上的关联。当然未来说不定会有呢（逃

让 AstrBot 插件开发更舒适 —— 把「改代码 → push → 服务器装插件 → 看日志」这条链路压进 VS Code，按一下 F5 就能推送、安装、实时观察日志。

## 目录

- [背景](#背景)
- [功能](#功能)
- [快速开始](#快速开始)
- [使用详解](#使用详解)
- [前置条件](#前置条件)
- [配置文件说明](#配置文件说明)
- [launch.json 示例](#launchjson-示例)
- [已知问题与 FAQ](#已知问题与-faq)
- [开发](#开发)
- [安全提示](#安全提示)
- [鸣谢](#鸣谢)

## 背景

在开发 AstrBot 插件的过程中，我们往往需要反复调试——无论是直接在 AstrBot 服务器上验证，还是在本地就能跑通的功能，都得不断调优才能达到预期。但 AstrBot 插件本身强依赖真实生产环境，大多数开发者很难在本地一比一复现出完全一致的线上环境。于是，每次改动都不得不先把代码 `git push`，再到实际环境中安装使用，既打断了开发节奏，又浪费了大量时间。

为了改变这一现状，我们希望把这些环节的耗时压缩到极致，把能简化的操作直接集成进 VSCode，从而带来更流畅的 AstrBot 插件开发体验。

## 功能

- **环境初始化**（命令：`初始化 AstrBot 插件编辑环境`）：创建虚拟环境、安装 `astrbot`、下载 AstrBot-Skill 到 `.claude/skills/`（并软链 `.codex/skills`）、下载 helloworld 模板并 `git init`
- **侧边栏视图**（Activity Bar 的 AstrBot 图标）：
  - 服务器连接状态、自动连接开关
  - 「本地插件」单选列表，决定 F5 推送目标
  - 插件配置编辑（`_conf_schema.json` 规范，校验后推送到服务器）
  - 接收服务器日志开关（独立于调试，实时控制）
- **原生调试**（`type: astrbot`）：
  - F5 / 命令面板「将插件推送至AstrBot服务器并观察」启动
  - 打包插件 zip → 上传安装（同名插件自动先删后装）→ 观察服务器日志
  - 日志经 logleak 插件（SSE）实时写入「AstrBot Server」输出通道
  - 停止后可按 `stopAction` 处理插件（询问禁用 / 直接禁用 / 保留）
- **OpenAPI 插件管理**：插件配置读写、启用 / 禁用、消息推送、服务器插件列表

## 快速开始

1. 打开你的 AstrBot 插件项目（首次打开时扩展会引导创建 `.vscode/astrbot-devkit-config.json`，填入服务器地址 + API Key）
2. 如需本地依赖：命令面板执行 `初始化 AstrBot 插件编辑环境`，自动建虚拟环境、装 `astrbot`、拉模板
3. 侧边栏「本地插件」选中本次推送目标
4. 按 F5（或命令面板搜 `将插件推送至AstrBot服务器并观察`）推送并观察日志
5. 侧边栏「接收服务器日志」开关可随时控制日志接收

## 使用详解

### 侧边栏

打开 Activity Bar 中的 AstrBot 图标，可见两个视图：

- **AstrBot DevKit**：服务器连接状态与自动连接开关、插件配置编辑入口、接收服务器日志开关、向平台推送消息、列出服务器插件等
- **本地插件**：以单选列表形式展示当前工作区管理的插件，选中即设为活跃插件（F5 / Debug 的推送目标）

### 原生调试（`type: astrbot`）

扩展注册了自定义调试类型，F5 时的工作流为：

1. 打包活跃插件的目录为 zip
2. 上传到 AstrBot 服务器并安装（若服务器已有同名插件，自动先删后装）
3. 通过 logleak 插件（SSE）实时拉取服务器日志，写入「AstrBot Server」输出通道
4. 停止调试时，按 `debug.stopAction` 处理插件（`ask` 询问 / `disable` 直接禁用 / `keep` 保留）

### 插件配置编辑

侧边栏「打开插件配置」可编辑当前插件的 `_conf_schema.json`（遵循 AstrBot 插件配置规范），保存时自动校验并推送到服务器。

## 前置条件

- **AstrBot 服务器** v4.18+
  - 日志实时观察功能需 **v4.24+**，并在服务器上安装 [astrbot_plugin_devkit_for_vscode_logleak](https://github.com/17-qxm/astrbot_plugin_devkit_for_vscode_logleak)
- **VS Code** 1.125+
- **环境初始化**（可选）：Python 3.10+、`uv`（可选，未安装则回退到 `python -m venv`）、`git`

## 配置文件说明

工作区配置位于 `.vscode/astrbot-devkit-config.json`，扩展首次启动时会引导创建。完整 JSON Schema 见 [`schemas/astrbot-devkit-config-schemas.json`](schemas/astrbot-devkit-config-schemas.json)，VS Code 会自动据此提供补全与校验。主要字段：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `version` | number | `2` | schema 版本号；v1 配置可由扩展自动迁移 |
| `astrbotServer` | string | `127.0.0.1:6185` | AstrBot 服务器地址，支持 `host:port` 或完整 `http(s)://` URL |
| `astrbotAPIkey` | string | `""` | AstrBot HTTP API 鉴权密钥（后台 → 配置 → 服务器配置 中获取） |
| `autoConnect` | boolean | `true` | 启动时是否自动连接并拉取服务器信息 |
| `debug.stopAction` | string | `"ask"` | 停止调试后如何处理插件：`ask` / `disable` / `keep` |
| `debug.reloadAfterPush` | string | `"ask"` | 推送成功后是否重载插件：`ask` / `always` / `never` |
| `debug.receiveLogs` | boolean | `true` | 是否接收并显示服务器日志（侧边栏开关可实时切换） |
| `debug.reconnectLimit` | number | `5` | 日志流断线后的最大重连次数 |
| `pluginWorkspaces` | array | `[]` | 本工作区管理的插件列表（`dir` / `name` / `version` / `active`） |

最小示例：

```jsonc
{
  "version": 2,
  "astrbotServer": "127.0.0.1:6185",
  "astrbotAPIkey": "your-api-key-here",
  "autoConnect": true,
  "debug": {
    "stopAction": "ask",
    "receiveLogs": true
  },
  "pluginWorkspaces": [
    { "dir": "./astrbot_plugin_hello", "name": "astrbot_plugin_hello", "version": "v1.0.0", "active": true }
  ]
}
```

## launch.json 示例

以下配置可作为 `.vscode/launch.json` 的起点，`pluginName` 会自动取侧边栏选中的活跃插件：

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "astrbot",
      "request": "launch",
      "name": "将插件推送至AstrBot服务器并观察",
      "pluginName": "${command:astrbot-devkit.GetActivePluginName}"
    }
  ]
}
```

## 已知问题与 FAQ

- **连接服务器失败？** 请检查 `astrbotServer` 地址与端口是否可达、`astrbotAPIkey` 是否正确（AstrBot 后台 → 配置 → 服务器配置 中获取）、AstrBot 版本是否 ≥ v4.18。
- **看不到实时日志？** 确认 AstrBot ≥ v4.24，并已在服务器安装 [logleak 插件](https://github.com/17-qxm/astrbot_plugin_devkit_for_vscode_logleak)；同时确认侧边栏「接收服务器日志」开关已开启。
- **同名插件推送报错？** 扩展会自动先删后装，若仍失败请检查服务器该插件是否被锁定或权限不足。
- **日志流频繁断开？** 可适当调大 `debug.reconnectLimit`（默认 5 次）。
- **当前为早期测试版本**，部分边界情况可能未覆盖。遇到问题欢迎在仓库提 issue，并附上日志。

## 开发

```bash
npm install
npm run compile        # 类型检查 + lint + esbuild 打包
npm run watch          # 开发监听
```

按 F5 启动 Extension Development Host 调试扩展本身。

## 安全提示

`.vscode/astrbot-devkit-config.json` 含 API Key（附属于 AstrBot OpenAPI），已被 `.gitignore` 排除，**请勿提交该文件**。

## 鸣谢

- [Soulter](https://github.com/Soulter)：AstrBot 的作者，提供了强大的开源机器人框架，为本项目奠定基础。
- [xunxiing](https://github.com/xunxiing)：AstrBot 插件开发 skill 的作者，为本项目提供了 [AstrBot-Skill](https://github.com/xunxiing/AstrBot-Skill) 和其它帮助。