<!-- token-saver:begin -->
## Token discipline
- Large logs, files over ~300 lines, or broad searches where only the conclusion matters: delegate to the `output-filter` subagent.
- Read ranges (`grep -n`, `sed -n 'A,Bp'`), not whole files. Never re-read a file already in context.
- Bash output may be trimmed by a filter; the marker shows where the full text is saved. Search that file with grep -n instead of re-running the command.
- Batch independent tool calls. Keep replies short. No recaps of finished work.
<!-- token-saver:end -->
