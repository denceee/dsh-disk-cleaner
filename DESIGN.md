# dsh-disk-cleaner README 视觉系统

Resolved brief:
`type=readme_assets` · `palette=monochrome_dark` · `accent=electric_blue` ·
`typography=system_ui` · `display=same_as_body` · `layout=single_column` ·
`mood=professional_minimal` · `density=compact` ·
`exclude=animations,stock_photos,carousel`

## 品牌覆盖（先读这一节）

`design-brief` 的 `monochrome_dark` / `electric_blue` 是通用默认值。README 必须与
**已发布的产品面板**一致，否则读者点开插件会看到另一个界面。因此保留结构性的
决定（单一强调色、无渐变装饰、等宽元数据、锐利网格），把具体色值替换为产品真实
token：

| 角色 | `design-brief` 默认 | 本项目实际值 | 来源 |
|---|---|---|---|
| 画布 | `#09090B` | `#0A0E15` | 面板深色底 |
| 表面 | `#18181B` | `#121722` | 卡片背景 |
| 线上 | — | `#263044` | 卡片描边 / hairline |
| 正文 | `#FAFAFA` | `#E9EEF9` | 主文字 |
| 次文 | `#A1A1AA` | `#7D8AA3` | 元数据 / 说明 |
| 强调 | `#3B82F6` | `#5B9BFF` | 产品 `#1856FF` 在深底的提亮版 |
| 危险 | — | `#FF6B81` | C 盘告急、失败 |
| 成功 | — | `#34D399` | 清理成功、测试通过 |
| 提醒 | — | `#F5B33C` | 谨慎级清理项 |

强调色只承担三个语义：可操作、已选中、当前步骤。它不用于装饰。

## Visual Theme & Atmosphere

- Mood: `professional_minimal`，偏向“测量仪器”而非“营销页”
- Feel: 冷静、有刻度、每个数字都能追溯到一次真实扫描
- References: 系统监控面板、示波器读数、磁盘工具

## Color Palette & Roles

- Background `#0A0E15` · Surface `#121722` · Hairline `#263044`
- Text primary `#E9EEF9` · Text secondary `#7D8AA3` · Text dim `#A7B4CC`
- Accent `#5B9BFF` · Danger `#FF6B81` · Success `#34D399` · Warn `#F5B33C`

## Typography Rules

- Display: system sans，600–700，hero 52，区块标题 40，卡片标题 22
- Body: system sans，400，19–21
- Mono: `ui-monospace`，400，11–18，用于所有数字、路径、标识
- 中文与拉丁混排一律按渲染宽度校正，不按字符数估

## Component Stylings

- Badges: 20px 高、直角、两段式（label 深底 + value 彩底）、mono 11
- Cards: 表面色 + 1px hairline，radius 12–16
- Rings: 锥形用量环是**母题**，hero 与面板内同构
- 无阴影堆叠，无顶部彩条，无装饰性圆点

## Layout Principles

- viewBox 宽 1200（全宽模块），边缘留白 ≥48
- Hero 左标题 / 右真实面板；`flow` 与 `safety` 共用“竖脊 + 编号节点”语法
- 行距与分段以 8 为单位

## Depth & Elevation

- 仅 hero 允许一层极低强度的强调色径向晕（面板本身有，属写实）
- 其余模块靠 hairline 与留白分层

## Do's and Don'ts

- DO 让每个视觉模块只承担一个职责
- DO 用真实数字（7.2 s / 93.6% / 204 项），且与 README 正文一致
- DON'T 引入调色板外的颜色
- DON'T 使用动画、`foreignObject`、远程字体
- DON'T 把徽章做成营销标语

## Responsive Behavior

- 关键文字 ≥20 SVG 单位（900px 显示约 15px）
- 辅助标签 ≥18（约 13.5px）
- 360px 移动端：结构可保留，细节必须同时存在于正文与 alt

## Agent Prompt Guide

- 新增模块前先问：它删掉后读者会缺什么？答不上来就不加
- 断言数、路由数变化时，重新生成徽章与 hero 元数据行
- Hero 里出现的任何数字，必须能在 README 正文找到出处
