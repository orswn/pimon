# pimon

A pi package that holds one set of extensions as features of one extension.

## Install

```bash
pi install ~/Projects/pimon
```

## Configure

Optional file: `~/.pi/agent/pimon.json`.

```json
{
	"features": {
		"vi": false,
		"background": { "enabled": true }
	}
}
```

- `true` or `false` turns a feature on or off.
- An object can set `enabled` and the feature's options.
- Unknown features and invalid options show a warning at session start.
- Run `/pimon` to see feature status, prompt sections, and diagnostics.
