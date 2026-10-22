# 剧本设定器题材封面素材

代码核对：2026-10-22，提交 `9ba5a25`。题材映射在 `packages/shared/src/script/script-theme-catalog.ts`，Top 预设在 `web/src/features/script/ScriptDirectorPanel.tsx`。

请将自己生成的电影感、题材化封面放进这个目录。应用读取下面两组文件，并使用 `topics/neutral.svg` 作为中性占位；文件缺失时不会回退到旧题材 SVG、人物照片或其他题材图片。

## 左右无限滑动与水球：`topics/`

这些文件按题材语义命名，供主题材/融合题材两侧无限滑动、题材小图标和水球使用：

| 文件 | 题材 |
| --- | --- |
| `topics/xianxia.jpg` | 玄幻修仙 |
| `topics/urban.jpg` | 都市现实 |
| `topics/costume-romance.jpg` | 古装言情 |
| `topics/mystery.jpg` | 悬疑推理 |
| `topics/horror.jpg` | 惊悚怪谈 |
| `topics/crime-spy.jpg` | 犯罪谍战 |
| `topics/family.jpg` | 家庭伦理 |
| `topics/apocalypse.jpg` | 末世科幻 |
| `topics/history.jpg` | 历史传奇 |
| `topics/comedy.jpg` | 喜剧 |
| `topics/hero.jpg` | 主旋律 |
| `topics/sports.jpg` | 体育竞技 |
| `topics/heritage.jpg` | 文旅非遗 |

“重生复仇”目前直接复用 `top/top-7.jpg`，未使用独立的 `topics/` 文件。自定义题材可匹配已有展示分类；匹配未完成或没有结果时使用中性占位。展示分类只决定视觉素材，不替换用户填写的题材文本。

## Top 榜与 Top 预设：`top/`

Top 1–8 使用独立的 Top 封面：

`top/top-1.jpg` … `top/top-8.jpg`

Top 8「仙门团宠日常」的 Top 卡片使用：

`top/top-8.jpg`

选中 Top 8 后，主滑轨和水球仍使用玄幻修仙题材封面：

`topics/xianxia.jpg`

`topics/urban.jpg` 当前先使用 Top 2 的同一张封面作为占位。生成专用都市现实滑轨封面后，直接替换这个文件即可，不需要修改代码。

## 生成建议

- 推荐 JPG（sRGB），长宽比 3:4 或 1:1，至少 1200px 的长边；同一组尽量保持一致尺寸。
- 画面应突出题材世界、场景、道具或视觉符号，做成电影概念海报/剧集封面感；避免把人物大头作为唯一主体。
- 文件名必须保持上面的英文小写命名。替换文件后刷新页面即可生效。
