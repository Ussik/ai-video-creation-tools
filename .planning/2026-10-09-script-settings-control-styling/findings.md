# Findings
- Six equal grid tracks plus nested 32px icon tiles leave narrow value columns.
- Structure control inherits two-column layout, large icon padding and meta across rows; episode count crowds the structure text into ellipsis.
- Targeted styling keeps the charcoal palette, uses quiet solid borders and small inline icons, and separates heading/value/count layout.
- Dedicated stylesheet loaded after existing settings/theme CSS avoids another set of competing overrides in the long legacy stylesheet.
- Container queries use six controls on wide modal content, three columns below 860px and two below 441px.
