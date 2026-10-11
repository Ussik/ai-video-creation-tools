import { memo, useEffect, useRef, useState } from 'react'
import { ActionIcon, Button, Modal, MultiSelect, SegmentedControl, Select, Switch, TextInput } from '@mantine/core'
import { ArrowUpRight, BookOpen, Check, Download, GitBranch, LoaderCircle, Plus, Puzzle, RefreshCcw, Search, Settings2, Trash2, X } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, json } from './api'
import { recommendedSkills, skillMatches, skillStageOptions } from './skills-api'
import type { DiscoverableSkill, InstalledSkill, SkillDetail, SkillStage } from './skills-api'
import './skills-center.css'
import SkillDefaultSettings from './SkillDefaultSettings'

const errorMessage = (issue: unknown) => issue instanceof Error ? issue.message : String(issue)
const sourceKey = (skill: { repo: string; path: string }) => `${skill.repo}:${skill.path}`

function SkillsCenter({ projectId, projectName }: { projectId?: string; projectName?: string } = {}) {
  const [tab, setTab] = useState('discover'), [source, setSource] = useState('catalog')
  const [query, setQuery] = useState(''), [results, setResults] = useState<DiscoverableSkill[]>(recommendedSkills)
  const [installed, setInstalled] = useState<InstalledSkill[]>([]), [repositories, setRepositories] = useState<Array<{ repo: string }>>([])
  const [repo, setRepo] = useState('zenstory-ai/drama-skills'), [repoInput, setRepoInput] = useState('')
  const [repositoryOpen, setRepositoryOpen] = useState(false), [detail, setDetail] = useState<SkillDetail | null>(null)
  const [file, setFile] = useState(''), [documentMode, setDocumentMode] = useState('document')
  const [stages, setStages] = useState<SkillStage[]>([]), [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(''), [searching, setSearching] = useState(false), [loading, setLoading] = useState(true)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [hasSearched, setHasSearched] = useState(false)
  const [total, setTotal] = useState(0), [offset, setOffset] = useState(0), [updates, setUpdates] = useState<Record<string, boolean>>({})
  const requestSerial = useRef(0)
  const documentRef = useRef<HTMLDivElement>(null)

  async function reload() {
    const [library, sources] = await Promise.all([api<{ skills: InstalledSkill[] }>('/skills'), api<Array<{ repo: string }>>('/skills/repositories')])
    setInstalled(library.skills); setRepositories(sources)
    return library.skills
  }
  useEffect(() => { void reload().catch(issue => setError(errorMessage(issue))).finally(() => setLoading(false)) }, [])
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 3000); return () => window.clearTimeout(timer) }, [notice])
  useEffect(() => () => { requestSerial.current++ }, [])
  useEffect(() => { if (documentRef.current) documentRef.current.scrollTop = 0 }, [file, documentMode])

  async function action(key: string, work: () => Promise<void>) {
    if (busy) return
    setBusy(key); setError('')
    try { await work() } catch (issue) { setError(errorMessage(issue)) } finally { setBusy('') }
  }
  async function search(nextOffset = 0) {
    const serial = ++requestSerial.current
    if (source === 'catalog' && query.trim().length < 2) { setError('请输入至少两个字符，例如 drama、storyboard 或 dialogue'); return }
    setSearching(true); setError('')
    try {
      const response = source === 'catalog'
        ? await api<{ skills: DiscoverableSkill[]; total: number }>(`/skills/search?q=${encodeURIComponent(query.trim())}&offset=${nextOffset}`)
        : await api<{ skills: DiscoverableSkill[] }>(`/skills/repository?repo=${encodeURIComponent(repo.trim())}`)
      if (serial !== requestSerial.current) return
      setResults(current => nextOffset ? [...current, ...response.skills] : response.skills)
      setTotal('total' in response && typeof response.total === 'number' ? response.total : response.skills.length); setOffset(nextOffset); setHasSearched(true)
    } catch (issue) { if (serial === requestSerial.current) setError(errorMessage(issue)) }
    finally { if (serial === requestSerial.current) setSearching(false) }
  }
  function changeSource(value: string) {
    requestSerial.current++; setSearching(false); setSource(value); setHasSearched(false); setResults(recommendedSkills); setError('')
  }
  function displayDetail(value: SkillDetail) {
    setDetail(value); setFile(value.files.find(item => item.path.endsWith('SKILL.md'))?.path || value.files[0]?.path || '')
    setStages(value.stages?.length ? value.stages : value.suggested_stages); setEnabled(value.enabled || false); setDocumentMode('document')
  }
  async function showDetail(skill: DiscoverableSkill | InstalledSkill) {
    await action(`detail:${sourceKey(skill)}`, async () => {
      const local = 'id' in skill ? skill : installed.find(item => skillMatches(item, skill))
      displayDetail(local ? await api<SkillDetail>(`/skills/${local.id}`) : await api<SkillDetail>('/skills/details', json('POST', { repo: skill.repo, path: skill.path })))
    })
  }
  async function install(skill: Pick<DiscoverableSkill, 'repo' | 'path'>) {
    await action(`install:${sourceKey(skill)}`, async () => {
      const value = await api<InstalledSkill>('/skills/install', json('POST', { repo: skill.repo, path: skill.path }))
      await reload(); displayDetail(await api<SkillDetail>(`/skills/${value.id}`))
      setNotice('已安装，选择适用环节并启用后即可使用')
    })
  }
  async function saveBinding() {
    if (!detail?.id) return
    await action('binding', async () => {
      await api(`/skills/${detail.id}`, json('PATCH', { enabled, stages })); await reload(); setDetail(null); setNotice('应用配置已保存')
    })
  }
  async function checkUpdates() {
    await action('updates', async () => {
      const results = await Promise.allSettled(installed.map(skill => api<{ id: string; available: boolean }>(`/skills/${skill.id}/update`)))
      const next: Record<string, boolean> = {}; let failures = 0
      for (const result of results) if (result.status === 'fulfilled') next[result.value.id] = result.value.available; else failures++
      setUpdates(next)
      if (failures) setError(`${failures} 个技能未能检查更新，其余检查已完成`)
      else setNotice(Object.values(next).some(Boolean) ? '有来源仓库更新，可选择更新技能' : '已安装技能均为当前仓库版本')
    })
  }
  const installedFilter = installed.filter(skill => `${skill.name} ${skill.description} ${skill.repo}`.toLowerCase().includes(query.trim().toLowerCase()))
  const content = detail?.files.find(item => item.path === file)?.content || ''
  const body = file.endsWith('SKILL.md') ? content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '') : content
  return <section className="skills-page" aria-label="技能中心">
    <header className="skills-header"><div><span className="skills-eyebrow">创作工具</span><h1>技能中心</h1><p>发现创作技能，应用到剧本、视觉设定与分镜流程。</p></div>
      <Button variant="default" leftSection={<GitBranch size={15} />} onClick={() => setRepositoryOpen(true)}>仓库管理</Button></header>
    <div className="skills-navigation"><SegmentedControl value={tab} onChange={value => { setTab(value); setQuery(''); setError('') }} data={[
      { value: 'discover', label: '发现技能' }, { value: 'installed', label: `已安装 · ${installed.length}` }, { value: 'defaults', label: '默认技能' },
    ]} />{tab === 'installed' && <Button variant="subtle" leftSection={<RefreshCcw size={15} />} disabled={!!busy || !installed.length} onClick={() => void checkUpdates()}>检查更新</Button>}</div>
    {tab !== 'defaults' && <form className="skills-search" onSubmit={event => { event.preventDefault(); if (tab === 'discover') void search() }}>
      {tab === 'discover' && <SegmentedControl aria-label="搜索来源" value={source} onChange={changeSource} data={[{ value: 'catalog', label: 'skills.sh' }, { value: 'repository', label: 'GitHub 仓库' }]} />}
      {tab === 'discover' && source === 'repository' ? <TextInput aria-label="GitHub 仓库" placeholder="owner/repo 或 GitHub 仓库地址" value={repo} onChange={event => setRepo(event.currentTarget.value)} leftSection={<GitBranch size={16} />} />
        : <TextInput aria-label={tab === 'installed' ? '搜索已安装技能' : '搜索技能'} placeholder={tab === 'installed' ? '搜索已安装技能' : '搜索技能，例如 drama、storyboard、dialogue'} value={query} onChange={event => setQuery(event.currentTarget.value)} leftSection={<Search size={16} />} />}
      {tab === 'discover' && <Button type="submit" disabled={searching} leftSection={<Search size={15} />}>搜索技能</Button>}
    </form>}
    {error && <div className="skills-message is-error" role="alert"><span>{error}</span><ActionIcon variant="subtle" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></ActionIcon></div>}
    {notice && <div className="skills-message" role="status"><Check size={15} />{notice}</div>}
    {(searching || busy || loading) && <div className="skills-progress" role="status"><LoaderCircle size={15} className="pc-spin" />{searching ? '正在搜索技能' : loading ? '正在读取技能库' : busy.startsWith('install:') ? '正在下载技能与参考资料' : busy.startsWith('detail:') ? '正在读取技能详情' : busy === 'updates' ? '正在检查来源仓库版本' : '正在处理'}</div>}
    {tab === 'defaults' ? <SkillDefaultSettings projectId={projectId} projectName={projectName} /> : tab === 'discover' ? <>
      <div className="skills-results-heading"><h2>{hasSearched ? '搜索结果' : '适合当前项目'}</h2><span>{hasSearched ? `${results.length} 项${total > results.length ? ` / ${total}` : ''}` : '从视觉设定到分镜视频'}</span></div>
      <div className="skills-grid">{results.map(skill => {
        const local = installed.find(item => skillMatches(item, skill))
        return <article className="skill-card" key={sourceKey(skill)}><div className="skill-card-heading"><Puzzle size={19} /><h3>{skill.name}</h3></div>
          <div className="skill-card-meta"><span>{skill.repo}</span>{skill.installs !== null && <span><Download size={12} />{skill.installs.toLocaleString()} 次安装</span>}</div>
          <p>{skill.description || '打开详情查看技能说明、参考资料与适用环节。'}</p>
          <div className="skill-card-actions"><Button size="xs" variant="subtle" leftSection={<BookOpen size={14} />} disabled={!!busy} onClick={() => void showDetail(skill)}>查看</Button>
            <Button size="xs" variant={local ? 'default' : 'filled'} leftSection={local ? <Settings2 size={14} /> : <Download size={14} />} disabled={!!busy}
              onClick={() => void (local ? showDetail(local) : install(skill))}>{local ? '应用配置' : '安装'}</Button></div></article>
      })}</div>
      {hasSearched && !results.length && !searching && <div className="skills-empty"><Search size={28} /><h3>未找到技能</h3><p>尝试英文关键词，或切换到 GitHub 仓库搜索。</p></div>}
      {source === 'catalog' && hasSearched && results.length < total && <div className="skills-load-more"><Button variant="default" disabled={searching} onClick={() => void search(offset + 24)}>加载更多</Button></div>}
    </> : <div className="skills-installed">{installedFilter.map(skill => <article key={skill.id} className="skill-installed-row">
      <div className="skill-installed-icon"><Puzzle size={20} /></div><div className="skill-installed-summary"><h3>{skill.name}<span className={skill.enabled ? 'is-enabled' : ''}>{skill.enabled ? '已启用' : '未启用'}</span></h3><p>{skill.description}</p>
        <div className="skill-card-meta"><span>{skill.repo}</span><span>版本 {skill.revision.slice(0, 8)}</span><span>{skill.stages.length ? skill.stages.map(value => skillStageOptions.find(item => item.value === value)?.label).join(' · ') : '尚未绑定创作环节'}</span></div></div>
      <div className="skill-installed-actions">{updates[skill.id] && <Button size="xs" variant="default" disabled={!!busy} onClick={() => void action(`update:${skill.id}`, async () => {
        await api(`/skills/${skill.id}/update`, json('POST', {})); await reload(); setUpdates(current => ({ ...current, [skill.id]: false })); setNotice('技能已更新，应用配置已保留')
      })}>更新</Button>}<Button size="xs" variant="default" disabled={!!busy} onClick={() => void showDetail(skill)}>应用配置</Button>
        <ActionIcon variant="subtle" aria-label={`卸载 ${skill.name}`} disabled={!!busy} onClick={() => void action(`remove:${skill.id}`, async () => {
          await api(`/skills/${skill.id}`, json('DELETE', {})); await reload(); setNotice('已卸载技能，已有创作内容保留')
        })}><Trash2 size={15} /></ActionIcon></div>
    </article>)}{!loading && !installedFilter.length && <div className="skills-empty"><Puzzle size={28} /><h3>{installed.length ? '未找到匹配的技能' : '还没有安装技能'}</h3><p>在发现技能中查看并安装，再选择适用创作环节。</p><Button variant="default" onClick={() => setTab('discover')}>发现技能</Button></div>}</div>}

    <Modal opened={!!detail} onClose={() => { if (!busy) setDetail(null) }} centered size="min(1000px, calc(100vw - 40px))" radius={24} title={detail?.name} className="skills-modal" overlayProps={{ backgroundOpacity: 0.65, blur: 3 }}>
      {detail && <><div className="skills-detail-meta"><a href={detail.url} target="_blank" rel="noreferrer">{detail.repo}<ArrowUpRight size={14} /></a><span>版本 {detail.revision.slice(0, 8)}</span>{detail.license && <span>{detail.license}</span>}</div><p className="skills-detail-description">{detail.description}</p>
        <div className="skills-binding"><div className="skills-binding-heading"><h3>应用配置</h3><span>{detail.id ? '已安装到本应用' : '尚未安装'}</span></div>
          <MultiSelect label="适用创作环节" aria-label="适用创作环节" data={skillStageOptions} value={stages} onChange={value => setStages(value as SkillStage[])} disabled={!detail.id || !!busy} placeholder="选择技能参与的创作环节" />
          <div className="skills-binding-footer"><Switch label="允许用于创作" checked={enabled} onChange={event => setEnabled(event.currentTarget.checked)} disabled={!detail.id || !!busy} />
            {detail.id ? <Button size="xs" disabled={!!busy || enabled && !stages.length} onClick={() => void saveBinding()}>保存配置</Button> : <Button size="xs" leftSection={<Download size={14} />} disabled={!!busy} onClick={() => void install(detail)}>安装</Button>}</div>
          <p>允许使用后，该技能成为所选环节的备选。实际使用默认主技能或本次选择，可在“默认技能”中切换；安装新的同类技能不会自动叠加。</p>
          {!!detail.tool_requirements.length && <p className="skills-tool-note">该技能还包含工具或脚本要求；当前接入创作规则，外部工具尚未接入。<span>{detail.tool_requirements.slice(0, 8).join(' · ')}</span></p>}
        </div>
        <div className="skills-document-tools"><Select aria-label="技能文档" value={file} onChange={value => setFile(value || '')} data={detail.files.map(item => ({ value: item.path, label: item.path.split('/').slice(-2).join('/') }))} searchable allowDeselect={false} />
          <SegmentedControl size="xs" value={documentMode} onChange={setDocumentMode} data={[{ value: 'document', label: '文档' }, { value: 'source', label: '原文' }]} /></div>
        <div ref={documentRef} className="skills-document" tabIndex={0} aria-label="技能文档内容">{documentMode === 'source' || !/\.md$/i.test(file) ? <pre>{content}</pre> : <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
          h1: ({ children }) => <h2>{children}</h2>,
          img: ({ alt }) => <span>{alt || '图片参考'}</span>,
          a: ({ href, children }) => {
            let relative: string | null = null
            try { if (href && !/^[a-z]+:/i.test(href)) relative = decodeURIComponent(new URL(href, `https://skill.local/${file}`).pathname.slice(1)) } catch { /* Show malformed links as plain text. */ }
            const resource = relative && detail.files.find(item => item.path === relative)
            return resource ? <Button type="button" className="skills-document-link" onClick={() => setFile(resource.path)} data-workspace-control="" variant="subtle">{children}</Button>
              : <a href={relative ? `https://github.com/${detail.repo}/blob/${detail.revision}/${relative.split('/').map(encodeURIComponent).join('/')}` : href} target="_blank" rel="noreferrer">{children}</a>
          },
        }}>{body}</Markdown>}</div>
        {error && <p className="skills-modal-error" role="alert">{error}</p>}
      </>}
    </Modal>
    <Modal opened={repositoryOpen} onClose={() => setRepositoryOpen(false)} centered size="lg" radius={24} title="仓库管理" className="skills-modal" overlayProps={{ backgroundOpacity: 0.65, blur: 3 }}>
      <p className="skills-detail-description">添加公开 GitHub 技能仓库，方便重复搜索。移除来源会保留已安装技能。</p>
      <form className="skills-repo-add" onSubmit={event => { event.preventDefault(); void action('repository', async () => {
        const response = await api<{ repo: string; skills: DiscoverableSkill[] }>('/skills/repositories', json('POST', { repo: repoInput }));
        await reload(); setRepo(response.repo); setSource('repository'); setTab('discover'); setResults(response.skills); setHasSearched(true); setTotal(response.skills.length); setRepoInput(''); setNotice('仓库已添加')
      }) }}><TextInput aria-label="添加仓库" placeholder="owner/repo 或 GitHub 仓库地址" value={repoInput} onChange={event => setRepoInput(event.currentTarget.value)} /><Button type="submit" variant="default" leftSection={<Plus size={15} />} disabled={!!busy || !repoInput.trim()}>添加</Button></form>
      <div className="skills-repo-list">{repositories.map(item => <div key={item.repo}><Button type="button" onClick={() => { setRepo(item.repo); changeSource('repository'); setTab('discover'); setRepositoryOpen(false) }} data-workspace-control="" variant="subtle"><GitBranch size={15} />{item.repo}</Button>
        <ActionIcon variant="subtle" aria-label={`移除仓库 ${item.repo}`} disabled={!!busy} onClick={() => void action('remove-repository', async () => { await api(`/skills/repositories?repo=${encodeURIComponent(item.repo)}`, json('DELETE', {})); await reload() })}><Trash2 size={15} /></ActionIcon></div>)}</div>
      {busy === 'repository' && <div className="skills-progress" role="status"><LoaderCircle size={15} className="pc-spin" />正在扫描仓库技能</div>}{error && <p className="skills-modal-error" role="alert">{error}</p>}
    </Modal>
  </section>
}

export default memo(SkillsCenter)
