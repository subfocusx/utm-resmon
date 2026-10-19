# utm-resmon

Монитор ресурсов DSH: **сколько памяти жрёт всё семейство `dsh-web.service` и кто именно**. Чип в доке показывает итог семьи, ховер — дерево атрибуции: хост-процесс, MCP-дети, код плагинов.

## Что показывает

- **Чип в доке** — итог семьи (cgroup `memory.current`), на русском/английском по локали клиента. Краснеет, когда системной памяти мало.
- **Ховер-панель** (inline HoverCard, открывается только внутри вьюпорта):
  - шапка: итог семьи + пик (`memory.peak`) + разбивка anon/file/kernel из `memory.stat`;
  - `хост` — RSS главного Node-процесса + куча V8 (used/total) + CPU;
  - `mcp × N` — каждый MCP-дочерний процесс отдельно: PID, RSS, команда (раскрывается);
  - `плагины` — размер кода каждого плагина **на диске** (честно помечено on-disk, не retained heap);
  - `система` — вся машина: занято/всего, load average.
- Без cgroup (не-Linux) шапка и чип честно падают назад на RSS хоста.

## Почему так устроено (замеры)

- `process.memoryUsage().rss` покрывает **один** процесс, а семья DSH = хост + MCP-дети (+ доля ядра). Единственное число, совпадающее с «что нам выставила ОС» — `memory.current` cgroup сервиса (на prod: итог ~627 МБ при RSS хоста ~320 МБ).
- Cordis-плагины делят одну кучу V8 → per-plugin RSS не существует на уровне ОС; размеры кода — грубый, но честный прокси.
- MCP stdio-серверы (`dsh-mcp-client` → `spawn`) — отдельные процессы со своим RSS, читаются из `/proc` без спавна (только `node:fs`).

## Структура

```
resmon/
├── package.json   # utm-resmon; exports . и ./client; peers ^0.2.0-rc.2
├── index.js       # тонкий wiring: apply регистрирует 3 тула + GET /dsh-resmon
├── client.js      # чип + inline HoverCard (MemIcon, дерево PanelNode)
├── src/
│   ├── plugin.js      # collectSnapshot / buildToolDefs / registerTools / route (без импорта DSH → тестируемо)
│   ├── cgroup.js      # collectCgroup: memory.current/peak/stat, null-safe
│   ├── hostStats.js   # process.memoryUsage + v8 heap + os
│   ├── mcpScan.js     # /proc-скан MCP-процессов по allowlist
│   └── pluginSizes.js # require.cache → байты по префиксам пакетов
└── test/
    ├── run-tests.mjs   # 20 unit-тестов на src (синтетический ФС, без DSH)
    └── apply-tests.mjs # 14 контрактных: регистрация тулов, роут 200/cache/500, контракт client.js
```

Тулы: `resmon_snapshot` (всё сразу; slim-режим без mcp/plugins ключей ради экономии токенов), `resmon_mcp` (процессы, `match`), `resmon_plugins` (группы кода, `top`). Кеш роута 5 с.

## Установка

```bash
cd ~/.dsh/profiles/web
pnpm add "file:<путь-к-клону>/utm-resmon"
```

```yaml
# cordis.patch.yml — ТОЛЬКО через insert:
- insert:
    - id: utm-resmon
      name: utm-resmon
      config:
        mcpMatch: ['mcp', 'chrome-devtools']
```

Затем `systemctl --user restart dsh-web.service`, проверка: `curl localhost:3080/dsh-resmon`.

## Тесты

`npm test` — 34 проверки, зелёный обязателен перед пушем. Правила: test-first (падающая проверка → root cause → один фикс), без живой сети, `sleep` только в deploy-проверках.

## Честные ограничения

- `resmon_plugins` = байты кода на диске, НЕ retained heap. Точный retained — только heap-snapshot.
- `mcpScan` и cgroup — Linux-only; вне Linux возвращают `[]`/`null`, клиент деградирует на RSS хоста.
- Пик (`memory.peak`) — nice-to-have: отсутствие файла не обнуляет итог.

## Конвенции

- Zero runtime deps — только Node builtins.
- Репозиторий = один плагин (`utm-*`), файлы в корне — как `utm-github`, `utm-csv`.
