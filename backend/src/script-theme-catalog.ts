// Presentation metadata only. These categories never constrain or replace a
// creator's free-form genre, nor are they expanded by a model response.
export const scriptThemeCategories = [
  '玄幻修仙', '都市现实', '古装言情', '悬疑推理', '惊悚怪谈', '犯罪谍战',
  '家庭伦理', '末世科幻', '历史传奇', '喜剧', '主旋律', '体育竞技', '文旅非遗', '重生复仇',
] as const
export type ScriptThemeCategory = typeof scriptThemeCategories[number]
export const neutralThemeArtwork = '/topic-art/covers/topics/neutral.svg'
export const scriptThemeArtwork: Record<ScriptThemeCategory, string> = {
  '玄幻修仙': '/topic-art/covers/topics/xianxia.jpg',
  '都市现实': '/topic-art/covers/topics/urban.jpg',
  '古装言情': '/topic-art/covers/topics/costume-romance.jpg',
  '悬疑推理': '/topic-art/covers/topics/mystery.jpg',
  '惊悚怪谈': '/topic-art/covers/topics/horror.jpg',
  '犯罪谍战': '/topic-art/covers/topics/crime-spy.jpg',
  '家庭伦理': '/topic-art/covers/topics/family.jpg',
  '末世科幻': '/topic-art/covers/topics/apocalypse.jpg',
  '历史传奇': '/topic-art/covers/topics/history.jpg',
  '喜剧': '/topic-art/covers/topics/comedy.jpg',
  '主旋律': '/topic-art/covers/topics/hero.jpg',
  '体育竞技': '/topic-art/covers/topics/sports.jpg',
  '文旅非遗': '/topic-art/covers/topics/heritage.jpg',
  '重生复仇': '/topic-art/covers/top/top-7.jpg',
}
export function isScriptThemeCategory(value: string): value is ScriptThemeCategory {
  return (scriptThemeCategories as readonly string[]).includes(value)
}
