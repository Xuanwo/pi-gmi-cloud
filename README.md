# pi-gmi-cloud

GMI Cloud provider package for [pi](https://github.com/earendil-works/pi-mono).

Registers provider `gmi` against the OpenAI-compatible GMI Inference API and
loads the live model catalog from `GET /v1/models`.

## Install

```bash
pi install https://github.com/Xuanwo/pi-gmi-cloud
```

Pinned ref:

```bash
pi install git:github.com/Xuanwo/pi-gmi-cloud@v0.1.0
```

One-off without installing:

```bash
pi -e https://github.com/Xuanwo/pi-gmi-cloud
```

## Auth

Create an API key in the [GMI Cloud console](https://console.gmicloud.ai/user-setting/api-keys), then either:

```bash
export GMI_API_KEY=your_key
```

or store it for pi:

```text
/login gmi
```

pi also accepts a stored credential in `~/.pi/agent/auth.json`:

```json
{
  "gmi": {
    "type": "api_key",
    "key": "your_key"
  }
}
```

## Usage

```bash
# List discovered models
pi --list-models gmi

# Start with a specific model
pi --provider gmi --model 'deepseek-ai/DeepSeek-V4-Pro'
```

Inside an interactive session:

```text
/model
```

Select provider `gmi`, then any catalog model. Opening the model picker also
refreshes the remote catalog when network access is allowed.

## Behavior

| Item | Value |
|------|--------|
| Provider id | `gmi` |
| API | `openai-completions` |
| Base URL | `https://api.gmi-serving.com/v1` |
| Catalog source | `GET /v1/models` |
| Cost units | Converted from GMI per-token USD to pi per-million-token USD |
| Context window | From GMI `context_length` when present |
| Auth | `GMI_API_KEY`, `/login gmi`, or `auth.json` |

Notes:

- Catalog fetch runs during extension load so `pi --list-models gmi` works immediately.
- Transient catalog failures keep the last successful in-memory list instead of crashing pi.
- Reasoning / image capability flags are inferred from model ids and names. Override later via `models.json` `modelOverrides` if needed.

## Security

Pi packages run with full local permissions. Review this repository before
installing on machines you care about.

## License

MIT
