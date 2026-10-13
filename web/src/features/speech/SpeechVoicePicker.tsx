import { useState } from 'react'
import { Button, CloseButton, Combobox, InputBase, Loader, ScrollArea, SegmentedControl, useCombobox } from '@mantine/core'
import { Check, Pause, Play, Search } from 'lucide-react'
import { speechStandardVoice, speechStandardVoices, speechVoiceMatches } from '@video-studio/shared/media/speech-voices'
import type { SpeechVoicePreview } from './use-speech-voice-preview'

const groups = ['中文与多语种', '外语'] as const
type Props = { id: string; speaker: string; index: number; disabled: boolean; onChange: (speaker: string) => void; preview: SpeechVoicePreview }

export default function SpeechVoicePicker({ id, speaker, index, disabled, onChange, preview }: Props) {
  const [search, setSearch] = useState(''), [gender, setGender] = useState('all')
  const combobox = useCombobox({
    onDropdownOpen: () => { combobox.updateSelectedOptionIndex('active'); combobox.focusSearchInput() },
    onDropdownClose: source => { combobox.resetSelectedOption(); setSearch(''); if (source === 'keyboard') combobox.focusTarget() },
  })
  const matches = speechStandardVoices.filter(item => (gender === 'all' || item.gender === gender) && speechVoiceMatches(item, search))
  const voice = speechStandardVoice(speaker)
  const active = preview.key === id && preview.speaker === speaker
  const loading = active && preview.status === 'loading', playing = active && preview.status === 'playing'
  const label = loading ? '取消加载' : playing ? '停止试听' : '试听'
  return <div className="speech-voice-picker">
    <div className="speech-voice-picker-controls">
      <Combobox store={combobox} zIndex={450} onOptionSubmit={value => {
        if (!disabled) onChange(String(value))
        combobox.closeDropdown(); combobox.focusTarget()
      }}>
        <Combobox.Target targetType="button" withExpandedAttribute>
          <InputBase label="标准音色" aria-label={`标准音色 ${index + 1}`} value={voice?.name || ''} readOnly pointer disabled={disabled}
            placeholder="选择音色" classNames={{ input: 'app-select-input', section: 'app-select-section' }}
            rightSection={<Combobox.Chevron />} rightSectionPointerEvents="none" onClick={() => combobox.toggleDropdown()} />
        </Combobox.Target>
        <Combobox.Dropdown className="speech-voice-dropdown">
          <Combobox.Header className="speech-voice-filters">
            <Combobox.Search aria-label={`搜索音色 ${index + 1}`} placeholder="搜索名称、语种、场景或 ID" value={search}
              leftSection={<Search size={14} />} rightSectionPointerEvents="auto" onChange={event => { setSearch(event.currentTarget.value); combobox.resetSelectedOption() }}
              rightSection={search ? <CloseButton size="sm" aria-label="清空音色搜索" onMouseDown={event => event.preventDefault()}
                onClick={() => { setSearch(''); combobox.resetSelectedOption(); combobox.focusSearchInput() }} /> : null} />
            <SegmentedControl size="xs" fullWidth aria-label="音色性别" value={gender} data={[{ value: 'all', label: '全部' }, { value: '男', label: '男声' }, { value: '女', label: '女声' }]}
              onChange={value => { setGender(value); combobox.resetSelectedOption() }} />
          </Combobox.Header>
          <ScrollArea.Autosize mah={260} type="auto" scrollbarSize={5}>
            <Combobox.Options aria-label="标准音色">
              {groups.map(group => {
                const items = matches.filter(item => item.group === group)
                return items.length > 0 && <Combobox.Group key={group} label={group}>{items.map(item => <Combobox.Option key={item.speaker} value={item.speaker}
                  active={item.speaker === speaker} data-checked={item.speaker === speaker || undefined}>
                  <div className={`speech-voice-option${item.speaker === speaker ? ' is-selected' : ''}`}><span>{item.name}<small>{item.gender}声</small></span>
                    <small>{item.language.replace(/\n/g, ' · ')} · {item.scenes}</small></div>
                  {item.speaker === speaker && <Check size={14} className="speech-voice-check" />}
                </Combobox.Option>)}</Combobox.Group>
              })}
              {!matches.length && <Combobox.Empty>没有匹配的音色，请调整搜索或分类</Combobox.Empty>}
            </Combobox.Options>
          </ScrollArea.Autosize>
        </Combobox.Dropdown>
      </Combobox>
      <Button size="xs" variant="default" className="speech-voice-preview-button" disabled={disabled && !active || !voice}
        aria-label={`${label} ${voice?.name || '音色'} · 角色 ${index + 1}`} title={voice ? '播放官方样音，不消耗合成额度' : '填写的音色暂无官方样音'}
        leftSection={loading ? <Loader size={13} /> : playing ? <Pause size={13} /> : <Play size={13} />}
        onClick={() => { if (voice) preview.toggle(id, voice) }}>{label}</Button>
    </div>
    {voice?.description && <p className="speech-voice-description">{voice.description}</p>}
    {active && preview.error && <small className="speech-voice-preview-error" role="alert">{preview.error}</small>}
  </div>
}
