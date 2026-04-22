# Claude Buddy Serial (knottttt fork)

## Fork 说明

这是 `knottttt` 基于官方 `claude-desktop-buddy` fork 后持续迭代的版本。  
本 fork 不再以 Claude Desktop 的 BLE 连接为主路径，而是以 **Windows 下可稳定使用** 为目标，转向 **VS Code + USB Serial** 方案。

## 为什么做这个 fork

- 在我的 Windows 环境中，Claude Desktop 与 Hardware Buddy 的 BLE 连接不稳定，无法长期可靠使用。
- 为了保证可用性，改为通过串口桥接 Claude 活动状态到设备。
- 在这个过程中，保留并增强了原有固件交互体验（ASCII pet、审批交互、状态提示等）。

## 我做了什么

### 1) VS Code 插件桥接（核心）

新增 `vscode-buddy/`，提供：

- 活动轮询：读取 `~/.claude/projects/*.jsonl`
- 状态推送：每 800ms 通过串口发送状态
- 面板控制：在 VS Code Sidebar 直接控制硬件

### 2) 串口硬件控制

面板可直接发送：

- 亮度：`{"set":{"brightness":N}}`，`N=0..4`
- LED：`{"set":{"led":true|false}}`
- 声音：`{"set":{"sound":true|false}}`
- 宠物切换：`{"cmd":"species","idx":N}`，`N=0..17`

### 3) 固件侧可靠性优化

- `species` 严格校验：仅允许 `0..17`（以及 `0xFF` GIF sentinel）
- 非法 `species` 返回失败 ack：
  `{"ack":"species","ok":false,"reason":"idx_out_of_range"}`
- `set` 批量应用时减少 NVS 写入：`led/sound` 仅在值变化时保存，且合并为单次 `settingsSave()`
- 摇晃切换与时钟模式协同优化：时钟界面摇晃可退出到 pet 并显示 dizzy 动画

### 4) 面板反馈策略

- UI 保持乐观更新（点击立即反馈）
- 发送失败或设备拒绝时，面板日志输出 `[control] ...`
- 顶部显示短暂告警，便于定位链路问题

## 快速开始（本 fork）

### 固件

```bash
pio run -t upload
```

### VS Code 插件

```bash
cd vscode-buddy
npm install
npm run compile
```

然后在 Extension Development Host 中打开 `Claude Buddy Serial` 面板并点击 `Start`。  
默认串口：`COM4`，默认波特率：`115200`。

## 当前定位

这是一个以 Windows 可用性为优先的实用 fork，目标是：

- 先稳定可用
- 再逐步完善交互和协议细节
- 持续保持与现有固件体验兼容
