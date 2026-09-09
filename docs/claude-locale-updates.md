# Locale updates for pxt-wifi-adafruitio-https

## 2026-09-09

**Context:** `main.ts` had uncommitted changes (uncommitted at the time) adding new blocks
(`sendToThingsboard`, `setThingsboardServer`, `adafruitIOGetValue`), renaming
`sendToThinkSpeak` → `sendToThingSpeak`, reorganizing block `group`s (Connection,
Adafruit IO, ThingSpeak, IFTTT, Thingsboard), and changing `adafruitIOPost`'s
parameter order (username, aioKey, feed, value — aioKey moved before feed/value).
The four existing locale files (`_locales/{de,es,fr,it}/main-strings.json` and
`main-jsdoc-strings.json`) were stale relative to this: still keyed on
`WiFi.sendToThinkSpeak`, missing keys for the three new/renamed functions, and
`adafruitIOPost|block` still had the old param order in its label text.

**Decision:** Regenerated all four locales (de, es, fr, it) from scratch to match
current `main.ts`, keeping existing translation style/register per language. Added:
- `WiFi.sendToThingSpeak|block` (renamed key, translated label kept equivalent meaning)
- `WiFi.sendToThingsboard|block` + jsdoc
- `WiFi.setThingsboardServer|block` + jsdoc
- `WiFi.adafruitIOGetValue|block` + jsdoc
- Fixed `WiFi.adafruitIOPost|block` param order to `username|aioKey|feed|value`

**Verification:** Confirmed all `%paramName` tokens in each locale's `main-strings.json`
match exactly (same set, case-sensitive) against `%paramName` tokens in `main.ts`, and
that all 8 JSON files parse. No English base strings file exists in this repo (pxt
generates the English blocks directly from the `//% block=` annotations in `main.ts`).

**Note for next time:** locale files should be updated in the same commit/PR as any
`main.ts` block signature or group change — check `_locales/*/main-strings.json` for
stale keys whenever `main.ts` block annotations change.

## 2026-09-09 (follow-up): translations not applying at v0.3.0

**Symptom:** after tagging v0.3.0 with the corrected `_locales/*/main-strings.json`
files above, block translations still didn't show up in MakeCode with a non-English
editor language.

**Root cause:** PXT expects the locale filenames to match the package `name` in
`pxt.json` (here `pxt-wifi`), not a fixed `main-strings.json`/`main-jsdoc-strings.json`.
The user renamed all locale files accordingly:
`_locales/<lang>/main-strings.json` → `_locales/<lang>/pxt-wifi-strings.json`,
`_locales/<lang>/main-jsdoc-strings.json` → `_locales/<lang>/pxt-wifi-jsdoc-strings.json`,
and updated the `files` list in `pxt.json` to match (commit 4df63ab, "update
translations"). This fixed block/jsdoc translation.

A generated base file `_locales/pxt-wifi-strings.json` (English) appeared as a byproduct
of a local pxt build and is useful as a reference for the exact key formats PXT expects,
including group/category keys (see below).

**Decision:** Added group-name translations, which were still missing. PXT's generated
base file revealed the key format: `"{id:group}<GroupName>"` for each `//% group="..."`
value, and `"{id:category}<Namespace>"` for the namespace/category label. Added these to
all four locale `pxt-wifi-strings.json` files:
- `{id:category}WiFi`
- `{id:group}Connection`
- `{id:group}Adafruit IO`
- `{id:group}ThingsSpeak` (kept the group's actual spelling from `main.ts` line 89 —
  note this doesn't match the `groups=` declaration at the top of the file, which says
  `"ThingSpeak"` (no extra "s"). This mismatch predates these translation changes;
  flagged to Hugo but not changed since fixing it would alter block layout/behavior,
  not just translation.)
- `{id:group}IFTTT`
- `{id:group}Thingsboard`

**Gotcha for next time:** locale filenames must match the `pxt.json` package `name`,
not `main-*.json`. If translations mysteriously don't apply after otherwise-correct
edits, check this first.
