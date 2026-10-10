# Findings

The screenshot's network list contains project/continuity polling, which says nothing about the pending model request. Local saved conversation ends with the outline save at 21:41:23. The backend hot-reloaded during the wait. No character output has been persisted. Exact upstream status of that old request is unavailable, so do not claim a model is still running or that hot reload is the exclusive cause.

Regression found a deadline race: the outer SSE scope can reject and close before nested native provider promises finish updating their activity. Share the same recorder between route and tool dialogue, settle every running entry in the route catch before closing, and keep final activity statuses immutable on late promise cleanup.
