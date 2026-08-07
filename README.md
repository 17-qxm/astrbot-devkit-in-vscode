# AstrBot DevKit In VSCode

让 AstrBot 插件开发在 VS Code 内闭环:环境初始化、插件模板下载、一键推送调试、服务器日志实时观察,尽量不离开编辑器。

## 功能

- **环境初始化**(`初始化 AstrBot 插件编辑环境`):创建虚拟环境、安装 `astrbot`、下载 AstrBot-Skill 到 `.claude/skills/`(并软链 `.codex/skills`)、下载 helloworld 模板并 `git init`
- **侧边栏视图**(Activity Bar 的 AstrBot 图标):
  - 服务器连接状态、自动连接开关
  - 「本地插件」单选列表,决定 F5 推送目标
  - 插件配置编辑(`_conf_schema.json` 规范,校验后推送到服务器)
  - 接收服务器日志开关(独立于调试,实时控制)
- **原生调试**(`type: astrbot`):
  - F5 / 命令面板「将插件推送至AstrBot服务器并观察」启动
  - 打包插件 zip → 上传安装(同名插件自动先删后装)→ 观察服务器日志
  - 日志经 logleak 插件(SSE)实时写入「AstrBot Server」输出通道
  - 停止后可按 `stopAction` 处理插件(询问禁用/直接禁用/保留)
- **OpenAPI 插件管理**:插件配置读写、启用/禁用、消息推送、服务器插件列表

## 使用

1. 打开你的 AstrBot 插件项目,扩展会自动引导创建 `.vscode/astrbot-devkit-config.json`(服务器地址 + API Key)
2. 侧边栏「本地插件」选中推送目标
3. 按 F5(或命令面板搜「将插件推送至AstrBot服务器并观察」)推送调试
4. 侧边栏「接收服务器日志」开关控制日志接收

### 前置条件

- AstrBot 服务器 v4.18+(日志功能需 v4.24+,并安装 [astrbot_plugin_devkit_for_vscode_logleak](https://github.com/17-qxm/astrbot_plugin_devkit_for_vscode_logleak))
- VS Code 1.125+
- 环境初始化:Python 3.10+ / uv(可选)、git

### launch.json 示例

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

## 开发

```bash
npm install
npm run compile        # 类型检查 + lint + esbuild 打包
npm run watch          # 开发监听
```

按 F5 启动 Extension Development Host 调试扩展本身。

## 设计文档

- [design.md](docs/design.md) — 设计文档
- [implementation.md](docs/implementation.md) — 实现清单(精确到文件与函数)

## 安全提示

`.vscode/astrbot-devkit-config.json` 含 API Key,已被 `.gitignore` 排除,**请勿提交该文件**。
