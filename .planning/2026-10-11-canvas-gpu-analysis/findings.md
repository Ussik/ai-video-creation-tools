# Findings

- Prior node visibility/memo optimization covers data/interaction regressions, not system GPU load.
- project-canvas.css2680-2744 contains old base-edge animation plus a later override making structural edges static; verify effective styles.
- Related edge glow2625-2630 retains infinite dashoffset animation and drop-shadow. All-select can make all visible edges related. Reduced-motion does not target this glow.
- Canvas/sidebar/chrome use backdrop blur14-20px; check effective filters.
- ScriptThemeWaterCanvas uses a fullscreen WebGL pass at DPR<=2 and schedules rAF forever. Reduced-motion freezes shader time but not drawing. Inspect mounting/hidden rules.
- Prior memory associates an old SMIL script-settings overlay with Chrome Helper CPU spikes; current WebGL differs, and historical CPU figures are not current GPU measurements.
- TaskSpace18/p1 opened current local app. No data modifications.

- Runtime current project:54 mounted nodes/155 edges. Below80 threshold, so no offscreen pruning. Idle structural/base edges have animation:none; glow opacity0/no animation. One profile-dots infinite animation. Ten video elements paused/preload metadata, no WebGL canvas.
- Runtime chrome has6 blur backdrops: navigation/mode/save/list-toggle/utility14px and dock18px.
- Actual images sampled1672x941 versus438px display width; browser lazy-loading does not create smaller decoded images.
- Script settings conditional only checks settingsOpen; outer section can be hidden, and WebGL has no visibility/intersection gating. Water shader uses up to16 marching iterations and several texture taps.

- Four-second samples on the actual project: idle main-thread TaskDuration12ms/style0ms; select-all155 glow animations yielded TaskDuration275ms/style100ms; disabling only glow animation/filter through temporary page CSS reduced TaskDuration62ms/style0ms. These are main-thread/browser counters, not GPU-utilization percentages.
- Runtime all-select makes155 base paths acquire drop-shadow and155 glow paths run infinitely; CSS animated:false on React Flow edges does not prevent custom CSS animation.

- Short2500ms tracing samples: all-selected313 Paint events versus2 with glow disabled. RasterTask501 versus287 (aggregate browser trace, not GPU utilization). Only15/155 glow path bounding boxes intersect the viewport; longest box16746px tall. Below80-node pruning threshold permits many offscreen animated paths.
- Idle video elements are paused and no autoplay is configured. They still mount with original video metadata; posters and cached image thumbnails can reduce initial media/texture cost but are not proven continuous idle load.
- Current backend video frame GET extracts via ffmpeg on every request; a poster optimization should cache the output rather than repeatedly extract frames during rendering.

- Instrumented real water shader:204 drawArrays calls/3s(~68fps), backing796x560/CSS398x280/DPR2. With reduced-motion:147 calls(~49fps), proving time freeze does not stop drawing. Canvas visibility:hidden still produced5 calls/3s; browser throttles but application does not suspend.
- NodeMedia only changes controls/muted when inactive, no pause lifecycle. A previously started video can continue decoding after deselection (source-based risk, runtime videos were paused).
- Connection magnetism scans every mounted handle and reads its bounding rectangle on each relevant pointer move, then writes CSS offsets. Secondary interaction overhead; not the idle cause.
- A user clarification is pending on whether their reported spike occurs idle, selected, or with settings/video; recommendations are scenario-specific rather than claiming all causes are continuously active.
