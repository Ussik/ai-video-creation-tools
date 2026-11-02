// Generated from backend/test/fixtures/script-source-analysis.ts (tsc transpile). Test model fixture for the QA mock; not production code.
/** Model fixture for the upload reader and its separate whole-story synthesis. */
export function sourceAnalysisFixture(prompt) {
    const reviewMarker = '【原稿分析核对资料】\n';
    if (prompt.includes(reviewMarker)) {
        const input = JSON.parse(prompt.slice(prompt.lastIndexOf(reviewMarker) + reviewMarker.length));
        return JSON.stringify({ checked_section_ids: input.sections.map((section) => section.id), findings: [] });
    }
    const storyMarker = '【全剧整合资料】\n';
    if (prompt.includes(storyMarker)) {
        const input = JSON.parse(prompt.slice(prompt.lastIndexOf(storyMarker) + storyMarker.length));
        const ids = input.materials.flatMap((item) => item.covered_section_ids);
        const characters = new Map();
        for (const item of input.materials)
            for (const character of item.section.characters) {
                const existing = characters.get(character.name);
                if (existing)
                    existing.section_ids.push(item.section.id);
                else
                    characters.set(character.name, { name: character.name, aliases: [], description: character.description, section_ids: [item.section.id] });
            }
        const timeline = input.materials.filter((item) => item.section.events.length).map((item) => ({
            summary: item.section.events.map(event => event.summary).join('；').slice(0, 600), section_ids: [item.section.id],
        }));
        const story = { summary: '主角返乡，保留全剧事实与结局。', characters: [...characters.values()], timeline, threads: [],
            ending: { summary: '主角最后回家。', section_ids: ids }, uncertainties: [] };
        if (input.part?.kind === 'overview')
            return JSON.stringify({ covered_section_ids: ids, summary: story.summary, ending: story.ending });
        if (input.part?.kind === 'characters')
            return JSON.stringify({ characters: story.characters.filter(item => input.part.target_names.includes(item.name)) });
        if (input.part?.kind === 'timeline')
            return JSON.stringify({ covered_section_ids: input.part.section_ids,
                timeline: timeline.filter((item) => item.section_ids.some(id => input.part.section_ids.includes(id))) });
        if (input.part?.kind === 'threads')
            return JSON.stringify({ threads: [] });
        if (input.part?.kind === 'uncertainties')
            return JSON.stringify({ uncertainties: [] });
        return JSON.stringify({ covered_section_ids: ids, story });
    }
    const mapMarker = '【原文片段】\n';
    if (!prompt.includes(mapMarker))
        return;
    const batch = JSON.parse(prompt.slice(prompt.lastIndexOf(mapMarker) + mapMarker.length));
    const units = batch.passages.flatMap((passage) => passage.units)
        .filter((unit) => !batch.output_window || unit.id >= batch.output_window.first_unit && unit.id <= batch.output_window.last_unit);
    const first = units[0], last = units.filter((unit) => unit.text.trim()).at(-1);
    return JSON.stringify({ sections: [{ start_unit: first.id, title: `剧情片段 ${first.id}`, episode_number: null,
                summary: '本段原文的检索摘要，不是正式剧本。',
                // QA mock: name a person only where that exact name occurs in a source unit, citing that unit as evidence.
                characters: ['顾舟', '林棠'].flatMap(name => { const unit = units.find(item => item.text.includes(name)); return unit ? [{ name, description: `${name}（原文出现）`, evidence: { unit_id: unit.id } }] : [] }),
                events: [{ summary: '本段结尾事件', evidence: { unit_id: last.id } }] }] });
}
