# Findings

- Image generation results use fitImageNode, 160×160 minimum, aspect-preserving resize and image-result CSS hiding the selected status footer.
- Video generation results lack onLoadedMetadata and retain default 440×420 dimensions; contain rendering therefore creates top/bottom strips.
- Just using cover would crop the frame. Video must reuse actual metadata fitting, the same minimum and footer-free selected layout.
- Existing fit ignores invalid dimensions, preserves assets by ID and returns the current object for a stable size to avoid repeated shrinking.
