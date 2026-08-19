# Multi-node mode revert

Working notes and decision history for reverting the multi-node ("push to hub")
experiment from the WiFi dashboard driver.

## 2026-08-18 — Reverted multi-node mode, kept 6 independent fixes

### Decision

Revert the multi-node experiment (`7e14cb4`) back to the `2242023` reference,
but reapply the changes that were unrelated to multi-node.

**Revert base: `testprj/wifi.ts` @ `2242023`, used for *both* files.**

This mattered: at `2242023` the two driver copies were *not* identical
(39-line diff). `testprj/wifi.ts` was strictly ahead — it already had
`AT+CIPSERVERMAXCONN=5` and the re-firing idle watchdog (`webRecovered`
removed), which `main.ts` still lacked. Reverting each file to "its own"
`2242023` version would have silently regressed `main.ts`. Both files were
therefore reverted to the wifi.ts version and remain byte-identical.

### Kept (reapplied on top of `2242023`)

| Fix | Why it's independent of multi-node |
| --- | --- |
| Cold-boot `AT` handshake retry (~12 s, was one shot) | Module boots alongside the Calliope; first commands get swallowed |
| `AT+CWJAP` join retry (3 attempts) | First join can fail even after `AT` answers |
| mDNS `AT+MDNS=1,"calliope","_http",80` | `calliope.local` reachability; unrelated to nodes |
| `X-Total-Rows` header + "Empfangene Pakete" | True device row total vs. the client's diff cursor |
| Sliders `value="0"` | Browser defaulted the thumb to midpoint 50 while reporting 0 |
| `/log.csv` streamed in 20-row batches | Large-download protection on a fragmented heap |

### Reverted along with the node code

**Page segmentation (`pageSegs` / `buildPage` / `servePage`).** Kept out
deliberately. It existed only to fix error 022 (`GC_TOO_BIG_ALLOCATION`), which
the multi-node UI had itself *caused* by growing the page ~9.1 KB → ~12.7 KB.
With the node UI gone the page is back to ~9.3 KB, so the single cached
`pageHtml()` string is fine again. Alternative considered: keep the segment
mechanism as general heap-fragmentation defense — rejected because it meant
hand-stripping node-specific JS out of a ~190-entry segment array (high
transcription-risk for no current benefit). **If the page grows materially
again, revisit this** — `git show 7e14cb4:main.ts` has the working
implementation.

Also removed: `pushToHub` / `setHubAddress` blocks, "Sensor Node" group,
`pushStatus` / `lastResponse` diagnostics, `/push` ingest route + `ingestPush`,
`urlEncode` / `urlDecode` / `hexVal`, node-aware table grouping and multi-series
charts (`nodeIx`, `senIx`, `renderN`, `svgM`, `PAL`), and the `lastAt` capture in
`waitAtResponse` (its only consumers were the node diagnostic blocks).

`testprj/main.ts`: dropped the `"node"` column and the boot-time
`datalogger.deleteLog()` (a multi-node schema-migration workaround). **Kept** the
`1.1.1.1` → `4.3.2.1` comment correction — the AP has always been `4.3.2.1`, so
that was a pre-existing doc bug, not part of the experiment.

### Verification performed

- Extracted the generated dashboard page from the TS string concatenation and
  ran `node --check` on the embedded browser JS → parses cleanly.
- Page back to ~9.3 KB (from ~12.7 KB), no node/multi-series leftovers.
- Simulated the batched `/log.csv` against the old single-string `getRows(0,total)`
  for totals 0/1/5/19/20/21/40/41/63/100 → byte-identical output and matching
  `Content-Length` at every batch boundary.
- Brace/paren/bracket balance, grep sweep for all node identifiers → clean.

### Gotcha for future sessions

`main.ts` and `testprj/wifi.ts` are byte-identical *by convention*, not by any
build step or symlink — there is no tooling enforcing it. Any driver change must
be written to both. `diff -q main.ts testprj/wifi.ts` is the check.

The standalone TS language server reports `Cannot find name 'basic'` /
`'datalogger'` in these files. That is expected and pre-existing: there is no
`tsconfig.json` and those are MakeCode/pxt globals supplied at build time. Not a
real error — don't "fix" it.

## 2026-08-19 — Working tree was restored to the multi-node state

The revert described above is **no longer in the tracked files.** At the start of
this session `git status` was clean and `main.ts`, `testprj/wifi.ts`,
`testprj/main.ts` and `CHANGELOG.md` were all byte-identical to `HEAD`
(`7e14cb4`, multi-node). Something restored them after the previous session — a
`git checkout`/`restore`, a discarded stash, or an editor revert. Nothing was
committed, so the revert work was lost; only this untracked note survived.

The classification in the 2026-08-18 entry is still valid and is the recipe for
redoing it (base = `testprj/wifi.ts` @ `2242023`, plus the six kept fixes).
