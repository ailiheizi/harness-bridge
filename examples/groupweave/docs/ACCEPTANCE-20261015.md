# Telegram acceptance matrix — 2026-10-15

This record combines the run sheet with the 2026-10-15 real AYUGRAM result.
Keep real-user, group, and message identifiers out of shared notes.

## Evidence status

- **Current local suite:** `npm test` — 251 tests, 240 passed, 0 failed, 11
  skipped. `npm run typecheck` and `git diff --check` passed.
- **Current Telegram-only suite:**
  `npm exec -- tsx --test 'tests/telegram*.test.ts'` — 48 passed, 0 failed,
  0 skipped. This includes three new acceptance tests and uses a synthetic
  Telegram API; it is not real transport evidence.
- **Real AYUGRAM run, 2026-10-15:** 22/22 gates passed: 17 Telegram messages,
  2 callback queries, and 3 startup gates. The dedicated tester exercised
  private `/start`; test-group `/register`, `/plugins`, `/settings`, and
  `/status`; missing-argument `/rules` and `/links`; unknown-rule preview
  without a confirmation button; two `example.invalid` links through the
  extractor; `/cancel` with no active task; fail-closed `/digest`, `/brief`,
  `/ask`, and `/scan` without configuration; and `/echo` rejection while the
  feature was disabled. The tester then previewed and confirmed enabling Echo,
  received one real Koishi Echo response, and replayed the same confirmation
  button; replay was rejected and caused no second `sendMessage`. Runtime was
  2,608,763 ms, exit code 0, no OOM, with cleanup verified. The app image was
  `[private digest omitted]`
  with Harness Bridge 0.1.4. The original 17 service IDs and `StartedAt`
  values were unchanged. Evidence: sanitized Telegram receipt（私人历史证据未随公开案例发布）
  and run report（私人历史证据未随公开案例发布）.
  This proves only the single authorized tester and dedicated test group; AI
  and anti-ad remained disabled.
- **Synthetic cross-process storage run, 2026-10-15:** 41/41 checks passed in
  three fresh processes using the actual application image: seed 10, new-process
  verification 15, and restored-process verification 16. The checks covered
  stored group configuration, private/group task results, member access to
  private results, controlled unfinished-task recovery as blocked, persistent
  idempotency, sent/unknown delivery finality, and integrity-checked native
  backup/restore with explicit point-in-time acknowledgement. The fixture seeded
  synthetic Store rows directly; it did not create them through HTTP or
  Telegram. All phases exited 0 without OOM and cleanup was verified. This did
  not restart or reconnect the live Telegram bot. See the storage report（私人历史证据未随公开案例发布）
  and sanitized receipt（私人历史证据未随公开案例发布）.
- **Application-container synthetic model run, 2026-10-15:** 77/77 checks
  passed on image `[private digest omitted]`
  with Harness Bridge 0.1.4. Actual HTTP/Store/actions/Koishi and native
  OpenShell/DSH paths were exercised with synthetic identities, model response,
  and meter. The code path used 0 model requests; the synthetic digest used 1
  request, with model delta/admission/meter each exactly 1. Under global
  `maxActiveTasks=1`, another group's task was denied with 429; another member's
  private-task read returned 404; cross-group read and execution were denied.
  The app flow took 22,494 ms, the controller 40,373 ms; exit 0, no OOM, cleanup
  verified, and the original 17 service identities and start times were
  unchanged. This is not a live Telegram AI or real-provider result. See the
  application report（私人历史证据未随公开案例发布）
  and sanitized receipt（私人历史证据未随公开案例发布）.
- **Historical real Telegram run, 2026-10-13:** 9/9 narrow gates passed using
  one real tester, the dedicated bot, and one empty private test group. The
  gates were `getMe`, HTTP health, polling, private `/start`, group
  `/register`, `/help`, rules preview, real confirmation callback, and `/echo`.
  The run had AI off, no model request, and clean shutdown. It does not count as
  this round's AYUGRAM result. See the [dated acceptance record](ACCEPTANCE-GAPS-20261013.md)
  and the Telegram run report（私人历史证据未随公开案例发布）.
- **Historical app-container fixture, 2026-10-13:** 77/77 checks passed with a
  synthetic model context in the actual app image. This is a separate boundary
  from live Telegram, real model use, or production accounting. See the
  app-container report（私人历史证据未随公开案例发布）.

## Per-command run sheet

| Entry | Required actor and state | Expected behavior | Useful evidence |
| --- | --- | --- | --- |
| `/plugins` | Current verified member; group registered | Lists only capabilities available to this group and their actual Telegram entrypoints. If a feature exists only in the panel or has no Telegram runner, it must not advertise a command for it. | Incoming update; `getChatMember`; outgoing `sendMessage`; compare list with current group config and platform capability state. |
| `/settings` | Current administrator of this group; registered group | Shows this group's configuration and supported changes. A member or a platform admin without group-admin status is denied; no other group's settings are disclosed. | Current member-role lookup; response text scoped to this group; no privileged settings response for the negative control. |
| `/rules <rules>` | Current group admin; registered group; supported rules | Creates a pending preview against the displayed base version. A proposal with warnings has no confirmation button. Missing text gives usage guidance; unknown clauses cannot be activated. | Preview message and callback data; persisted proposal ID, creator, group, status, warnings, and base version. |
| Rules confirmation | Proposal creator is still current group admin; callback is in the same group; proposal is pending and base version is current | Confirms exactly that proposal and reports activation. Another admin, another group, revoked admin, malformed, or already activated button is rejected. | `answerCallbackQuery`; persisted proposal status and group version/config; activation response only on successful activation. |
| Two pending rules previews | Same creator/group and same base version; neither has activated yet | Both remain reviewable. **The first valid confirmation wins.** The other proposal then fails its base-version CAS; it is not silently replaced just because it is older. Replaying the activated button is rejected. | Both proposal rows initially `pending`; after one confirmation only that candidate is active and the group version increments once; stale callback has no success message; replay gets invalid-button answer. Covered locally with real Store/actions/binding. |
| `/echo <text>` | Current group member; `echo` enabled; Telegram feature runner bound | Runs the fixed Echo path on this input only, with zero model calls, then replies in the group. Missing feature or runner returns the configured unavailable/disabled response. | Incoming update; task feature/status/input scope; `modelCalls=0`; outgoing reply and task delivery record. |
| `/links <text>` | Current member; `link-cleaner` enabled and code binding available; command matches response mode | Cleans links from this message only; fixed code path, zero model calls. Empty/invalid link input returns a bounded failure. In mention mode use `/links@BotUsername` or explicit bot mention. | Update entities and target; task scope/status; `modelCalls=0`; outgoing reply/delivery record. |
| `/digest <text>` | Current member; `digest` enabled; Telegram runner and provider configuration available; selected text ≤8,000 UTF-8 bytes | First sends a consent prompt bound to this text and requester. No execution before the requester confirms. Missing provider configuration must fail closed without fallback. Confirmation runs the selected text and posts the result to the group. | Prompt's original-message binding; no task before callback; callback answer; task `externalProcessingAcknowledged`, actual model-call receipt, and one delivery. |
| `/brief <text>` | Current member; `link-brief` and `link-cleaner` enabled; runner and provider configuration available; selected text ≤8,000 bytes | Same explicit-consent boundary as digest; successful path uses the AI/link-code/AI flow. Missing provider configuration must fail closed without fallback. | Consent prompt and callback; task feature, actual model/tool receipts, and delivery. A typical successful path is two model calls and one tool call; use actual receipts rather than assume them. |
| `/ask <text>` | Current member; `assistant` enabled; runner and provider configuration available; selected text ≤8,000 bytes | Requests personal consent before any model call. Only the exact confirmed input runs; no group history is read. Missing provider configuration must fail closed without fallback. | Consent prompt/callback; exact task scope; actual model/tool receipt; one delivery. |
| `/cancel` | Current verified member; cancellation binding available | Cancels only this user's active tasks in this group. With none active, replies that there is nothing to cancel. A cancellation button is bound to the original owner, group, and prompt. | Incoming update or callback; cancellation actor/group; task cancellation request and terminal state; no late result delivered. |
| `/scan <text>` | Current member; `antiad` enabled; Telegram runner available | Analyzes only this input; does not delete, mute, ban, or otherwise moderate. Fixed analysis path should use zero model calls. Missing feature/runner is rejected. | Task feature/input scope, `modelCalls=0`, response; confirm no moderation API/action occurred. |
| Unknown slash command or ordinary unmentioned text | Any group member | Current adapter treats unknown slash commands as a no-op; ordinary text does not trigger work in command mode. In mention mode only explicit bot mention follows the configured route. Do not count silence as a successful business operation. | Incoming update; no task/action/API business call and no cross-group read. Record any unexpected response or action as a finding. |
| Any business command in an unregistered group | Current Telegram member, but group not registered | Refuses business execution and directs a current group admin to `/register`. `/register` itself requires the bot to be a group admin and the sender to be a current group admin. | `getChatMember` for bot and sender; refusal/register reply; no task before successful registration. |
| Enabled feature without Telegram runner | Current member; feature may be enabled in stored group config, but binding has no `executeFeature` | `/plugins` must not advertise unsupported command entrypoints; direct invocation returns the disabled/unconfigured response and performs no task. | Discovery message; direct-command rejection; zero feature executions. Covered locally. |

## 2026-10-15 outcomes

The matrix above is now exercised only for the behaviors listed in the real
run receipt. The run verified discovery/settings/status, bounded code-only
link extraction, disabled/unconfigured command refusals, Echo activation and
execution, and confirmation replay protection. The 22 gates comprise 17
message updates, two callback queries, and three startup gates; see the linked
receipt and report for gate-level evidence. No private identifiers or message
contents are recorded here.

Separately, the actual app HTTP path completed one synthetic digest through the
installed bridge, OpenShell and DSH and verified a task/sandbox/session-bound
synthetic meter receipt. This does not represent a real provider, real identity,
or Telegram `/digest` consent flow; AI remained disabled during the AYUGRAM run.

## Rule-button age and concurrency

The store does **not** implement a time-to-live for rule proposals. It writes
`createdAt`, but the activation path does not compare it with the current time.
Therefore an old-created proposal that is still `pending`, belongs to the
creator and group, has no warnings, and still matches the current group version
remains eligible. Age alone does not expire it. Proposals are subject to the
per-group retention cap (50 rows by default), which is count-based pruning, not
a TTL.

Concurrent previews at one base version are intentionally both retained for
review. The version comparison at activation determines the winner: first
confirmed proposal activates; the other gets a version-conflict failure. A
proposal already activated is rejected at the Telegram callback boundary and
must not produce a second success reply. Current local tests cover these CAS
and replay behaviors; they do not prove delivery timing or callback behavior
against the live Telegram API.

## Scope still open

The five-minute expiry applies to AI consent callbacks. It is not a rule
proposal expiry policy; rule proposals have no time-based expiry.

The storage run proves synthetic persistence and restore behavior only; it
does not establish live Telegram restart/reconnect behavior. The app-container
run proves one synthetic digest on the actual HTTP/app path, not a Telegram
consent flow or real provider. These results do not establish multi-user or
cross-group live isolation, Mini App login, live permission revocation, real
Telegram AI consent/confirmation/cancellation, real provider usage, production
budget/meter/credential brokering, anti-ad behavior, or production deployment.
AI and anti-ad were disabled during the AYUGRAM pass. The 2026-10-13 9-gate
Telegram and 77/77 app-container results remain historical evidence for their
narrower scopes.
