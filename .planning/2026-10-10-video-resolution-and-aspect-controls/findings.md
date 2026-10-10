# Findings

- Video UI hardcodes adaptive-only ratio in first_frame/first_last_frame/edit/extend and ignores selected stored ratio again at submit.
- Resolution UI uses local model lists; current video config lists480p/720p with default720p. Generic video starter has480p/720p/1080p default720p.
- Backend validation also rejects values not in those local lists; provider mode_variables override explicit ratio withadaptive.
- Request and canvas types already allow string ratio/resolution. Central standard UI choices will merge configured custom values and preserve known configured casing.
- No provider4K spelling/support evidence; use4k unless explicitly configured differently, render4K in UI.
- First-frame creation stays auto by default, while explicit choices persist across source linking and actual provider submission. New video resolution default is480p; existing selected values remain.
