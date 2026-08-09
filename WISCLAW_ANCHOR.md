# Wisclaw OpenClaw anchor

| Field                           | Value                                         |
| ------------------------------- | --------------------------------------------- |
| Product baseline (package.json) | `2026.7.1`                                    |
| Upstream tag                    | `v2026.7.1-2`                                 |
| Integration commit              | `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`    |
| Describe                        | `v2026.7.1-2`                                 |
| Security floor                  | `2026.3.13`                                   |
| Security blocked                | `2026.3.3` (not a product baseline)           |
| Docs snapshot                   | `infra/dependencies/engine-docs-archive/`     |
| Pin                             | `services/openclaw_adapter/openclaw-pin.json` |

## Policy

- **Only** this tree is the OpenClaw implementation baseline.
- Product development targets `2026.7.1` / tag `v2026.7.1-2` only.
- Do not reintroduce retired `2026.3.3` as a product pin or dual-read capability matrix.

## After every baseline bump (dev machines)

Updating this tree alone is **not** enough. Host Gateway Runtime and the
staging-cn Control API image must track the same pin, or diagnostics will
show `OpenClaw status=error` while the daemon still listens on `:18789`.

Full procedure, root-cause notes (2026-08 protocol/package skew), and
engines smoke gate:

→ [`docs/Key-Documents/Infra/openclaw/Wisclaw_OpenClaw_Version_Maintenance_Guideline.md`](../../../docs/Key-Documents/Infra/openclaw/Wisclaw_OpenClaw_Version_Maintenance_Guideline.md)

Minimal commands:

```bash
bash scripts/dev/refresh_host_runtime_from_source.sh --openclaw-only
bash scripts/dev/rebuild_control_api_for_runtime_baseline.sh
# then: GET /v1/control/engines → openclaw status must be "running"
```
