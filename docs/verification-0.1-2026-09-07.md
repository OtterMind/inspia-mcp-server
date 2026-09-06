# 0.1 Discovery Verification

结论：**基础 MCP 链路可用，但 0.1 尚不能作为“验证全部通过”签核。**

本轮验证发现一个确定的 MCP 分页缺陷，以及多组主站检索相关性问题。
此次只新增可复现验证脚本、查询集与报告；没有修改运行时代码、生产配置或数据库，未提交或部署修复。

## 后续本地修复复验

以下原始生产验证记录保留。随后已在本地修复分页，修复尚未部署到生产：

- 新发出的 v2 游标使用 SHA-256 过滤摘要；旧 v1 游标保持原有签名、过滤条件和到期时间校验。
- 输入、输出、编码、解码共用长度约束；上游游标超过 2,048 字符时返回明确的 `UPSTREAM_CURSOR_UNSUPPORTED`，不返回不可用游标或假装已无下一页。
- 新增 11 项回归测试，覆盖 360/500 字中文、500 字 ASCII、emoji、特殊字符、旧游标兼容、长度边界和两代客户端连续三页。
- 本地 lint、typecheck、27 项测试、build 通过，真实上游 5 工具冒烟通过。
- 修复版 `http://127.0.0.1:8789/mcp` 的边界检查为 **7/7 通过**。原来 6,750 字符的游标缩短为 **2,466**；连续三页返回 9 个不同 ID，无重复。
- 同时测试 500 字中文查询：若真实上游游标超限，会得到明确错误，未宣称主站已支持该长度的分页。
- 复验原始记录：`.validation/2026-09-06T16-28-22-274Z/boundaries.json`。

搜索质量问题按后续接口修复处理，本次未改动。生产 `2c01ea2` 仍保留原缺陷，以上通过结果仅对应本地修复版。

## 范围与证据

- 生产端点：`https://inspia.ai/mcp`；服务为 `active`，重启次数 0。
- 采样时生产源版本为 `2c01ea2`，服务器与本地修复前的 `discovery.ts`、`cursor.ts` SHA-256 相同。
- 样本采集：2026-09-06 15:55–15:59 UTC，报告整理于 2026-09-07 Asia/Shanghai。
- 24 条固定查询：22 条语义检索、1 条精确标题、1 条无意义字符串探测。
- 检查 72 条结果（61 个不同 ID），读取 22 个不同 ID 的完整详情。
- 原始结果保存在 Git 忽略的 `.validation/2026-09-06T15-55-29-961Z/report.json`。
- 边界结果保存在 `.validation/2026-09-06T15-59-53-650Z/boundaries.json`。
- 查询定义：`evals/discovery-cases.json`；文本人工评阅：`evals/discovery-review-2026-09-07.json`。

## 通过的部分

| 检查 | 结果 |
| --- | --- |
| lint / typecheck / build | 通过 |
| 现有自动化测试 | 16/16 通过 |
| 公网 5 个工具与新旧 SDK 协议冒烟 | 通过 |
| 普通查询响应 | 24/24 成功，均为 hybrid，未报告降级 |
| 媒介、显式分类、重复 ID、归因和尺寸检查 | 本轮样本未发现接口契约错误 |
| 精确标题查询 | `Minimalist Vintage Travel Poster` 首条命中已知 ID |
| 普通签名游标、变更过滤条件拒绝 | 通过 |
| 非法 limit、过长 query、未知参数、非法 cursor、模型/媒介冲突、缺失详情 | 6/6 正确拒绝 |

这 24 次串行查询的耗时：中位数 611 ms，P95 1,044 ms，范围 309–1,140 ms。
这是一次可能包含缓存命中的短采样，不是压测、长期 SLA 或所有用户的性能结论。

## P2：合法长中文查询产生无法使用的游标

触发输入：`query = "极简产品摄影".repeat(60)`，长度 360 字符，`mediaType=image`，`limit=3`。

1. query 长度未超过允许的 500，首屏成功返回 3 条结果。
2. 返回的 nextCursor 长度为 6,750。
3. 原样携带该游标请求下一页，返回 `cursor: Too big: expected string to have <=6000 characters`。

已分别通过 Codex 原生 MCP 与官方 SDK v2 公网客户端复现。
`bun run test:boundaries` 当前为 **6 通过、1 失败，退出码 1**；失败不能忽略。

根因位置：

- `src/discovery.ts:164` 将 URL 编码后的完整过滤字符串作为签名载荷。
- `src/cursor.ts:18` 再将过滤字符串与上游游标一并做 Base64URL 编码，缺少编码后的长度约束。
- `src/schemas.ts` 和 `src/cursor.ts:26` 又拒绝长度大于 6,000 的游标。
- 另有上游 2,048 字符游标约束，需要一起考虑，不能只提高 MCP 外层上限。

建议修复：将过滤签名改为固定长度摘要，明确完整输入/上游/外层游标的长度预算；保持 HMAC、过期与跨过滤条件校验，增加中文、ASCII、特殊字符和极限长度的往返测试。修复范围先限于 MCP 适配层；若上游无法表示合法查询的游标，应返回明确错误而非发放不可用游标。

## P2：主站搜索存在明显不相关结果

| 查询 | 实际证据 | 判断 |
| --- | --- | --- |
| minimalist product photography | 第 2 条 House Sketch，完整提示词是人物在居家工作室 | 不是产品摄影 |
| pink skincare bottle studio photography | 首条是男性棚拍人像，未出现护肤品瓶子主体 | 主体不匹配 |
| 极简客厅室内摄影 | 首条 House Sketch；其次也为人物内容 | 场景/主体不匹配 |
| cinematic rainy street tracking shot | 首条为奇幻末日预告片 | 非雨街跟拍 |

对照相同参数的主站 `GET /api/prompts`：产品摄影查询的三个 ID 及顺序与 MCP 完全相同。
House Sketch 的提示词文本也与主站一致，SHA-256：
`f9e592505990fe53198dd4b90e4bb33d0828ce2be98b6b77915413e86c24d0ab`。

因此这些不相关结果来自主站数据/检索链路，MCP 没有重排或改写它们。
House Sketch 还存在 `subcategory=portraits-fashion`、`subjects=[products-food]` 的不一致信号。
目前没有直接检查数据库的 search_text、embedding 内容和索引命中，不能进一步断言是向量错位、具体排序权重或某次导入造成。

22 条语义查询首条结果的助手文本评阅：7 条明确相关、9 条部分相关、6 条不相关。
评阅依据是完整提示词文本；不是人类双重标注、图像评测或 Top-3 precision。
每条评分绑定已读的 promptId，并在评阅 JSON 中附理由，不应把它作为后续变化结果的自动评分。

无意义 query `zz_inspia_no_match_8eaf7610_kqzpv` 仍返回 3 条正常 hybrid 结果。
这不是协议错误，但表明当前接口没有向用户表达低相关性/无法匹配的状态，应纳入检索质量改进。

## 后续修复顺序

1. 修复 MCP 的长查询分页，保证 `test:boundaries` 全部通过，再发布补丁版本。
2. 只读核查主站失败样本的标题、原文、分类、search_text 与 embedding 归属，定位数据与排序原因。
3. 以相同 24 条查询重跑，补人类相关性标注和视觉检查后再判断检索改进效果。
4. 完成后再收尾公开推广；OAuth 与图片生成保持后续范围。

## 复现

```sh
bun run check
MCP_SMOKE_URL=https://inspia.ai/mcp bun run test:live
MCP_SMOKE_URL=https://inspia.ai/mcp bun run test:discovery
MCP_SMOKE_URL=https://inspia.ai/mcp bun run test:boundaries
```

两个新验证命令主动访问公开 MCP，并节流执行。默认单元测试与 CI 不访问生产，
也不会因为本轮已知生产缺陷被悄悄放宽断言。原始公共提示词结果不会进入 Git。
