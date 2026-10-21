# Recommended skill sources

`toolgate skills recommended` lists the sources in `packages/toolgate/data/recommended-skills.json`.
The list is data shipped with the package: it is never fetched at run time, and listing a source
installs nothing. A project, a user or a local config can extend it with `skills.recommended`
(same `id` replaces an entry; `{"id": "...", "disabled": true}` hides one).

## Adding or updating an entry (pull request checklist)

- `commit` is a full 40-character SHA, never a branch or a tag.
- `skills` is the list of skills that were read at that commit; a skill added upstream later is not
  recommended until someone reviews it and the pin moves.
- The source is `github:<owner>/<repo>` or an `https://` URL without credentials.
- `license` is filled in and the repository's `LICENSE` allows redistribution of the skills.
- Skills that compete with toolgate's own routing (for example a skill router) go in `exclude`.
- Per-skill `overrides` (`mcps`, `tags`) are added when the skill needs them to be activated.

`npm test` validates every entry; a weekly workflow checks that each pinned commit still exists
and holds the listed skills.

## Installing one

`toolgate skills install recommended:<id> [name...] [--user|--local]` fetches exactly the entry's commit (by SHA; what
arrives is checked against it), installs only the reviewed skills (a name outside the list is refused, and so is a
reviewed skill that is missing at that commit; nothing is installed then), records the entry's `exclude` in the lock
and writes its `overrides` to the config of the install level without replacing one that is already there.
`--ref` and `--path` cannot be combined with it. The lock records the commit as its `ref`, so a later `toolgate skills update` stays on the reviewed
commit; moving on means reviewing a new commit and bumping the entry. Installing the same source again with a plain `install <source>` (no `--ref`) keeps that commit too. The install exits 1 if a
reviewed skill had to be skipped (an edited copy, say), and `--user` accepts only entries from the shipped list or from your own
user and local config: an entry from the committed project config is refused there, because its overrides would land in your
user config. If the overrides cannot be written the skills stay installed; run the same command again. Running it again is
`unchanged` while the lock holds the pinned content.

## Fields

| Field | Meaning |
| --- | --- |
| `id` | Name used to refer to the entry (`owner/name`). |
| `source`, `commit` | `github:<owner>/<repo>` or an `https://` URL, and the full commit the skills were reviewed at. |
| `path` | Folder of the repository that holds the skills (default `skills`); relative, never `..`. |
| `skills`, `exclude` | The reviewed skill names; `exclude` lists the ones that are not installed. |
| `overrides` | Per-skill `mcps`, `tags` or `description`, applied when the skills are indexed. |
| `license` | The licence of the source. |

`toolgate skills recommended` reports each entry against the project's lock: `not installed`, `partial`,
`installed`, and the installed commit when it differs from the pin. It never installs or fetches anything.
