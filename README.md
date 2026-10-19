# utm-dsh — DeepSeek Harness plugins

Cordis-плагины для [DeepSeek Harness](https://github.com/deepseek-ai) (dsh web): каждый плагин — своя папка, ставится снапшотом через `pnpm add file:<папка>` + `insert:` в `cordis.patch.yml`.

Cordis plugins for DeepSeek Harness (dsh web): one folder per plugin, installed as a snapshot via `pnpm add file:<folder>` + `insert:` into `cordis.patch.yml`.

## Плагины / Plugins

| Папка | Что делает |
|---|---|
| [resmon/](resmon/) | Монитор ресурсов: чип в доке с итогом памяти всего семейства `dsh-web.service` (cgroup), ховер с деревом атрибуции — хост, MCP-процессы, код плагинов. Resource monitor: dock chip with the whole `dsh-web.service` family memory total (cgroup) + hover attribution tree — host, MCP processes, plugin code. |

## Правила / Conventions

- Zero runtime deps — только Node builtins.
- Test-first: `npm test` зелёный обязателен перед пушем (`test-first` из systematic-debugging: падающая проверка → root cause → один фикс).
- Честные числа: что не меряется (retained heap плагинов в общей куче V8) — так и написано в README плагина.
