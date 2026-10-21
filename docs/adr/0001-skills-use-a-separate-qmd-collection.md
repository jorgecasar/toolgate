# ADR 0001: skills live in their own qmd collection

- Status: accepted
- Context: the ROADMAP open question "are skills and the hidden-tools catalog the same index, or
  two parallel mechanisms?" (issue 14).

## Decision

Two qmd collections, one daemon, one search wrapper:

- the skills collection (`skills-<directory>-<hash>` per project), built by `toolgate skills index` from `skills.sources[]`.
- The MCP server catalog, in its own collection, owned by the catalog work.

`toolgate skills index` is the only owner of the skills collection. `toolgate init` does not
create a collection of its own for the raw skill folders: it runs `toolgate skills index`.

## Why two collections

- **Different schema.** A skill document is name, description, tags, required MCPs and path; a
  catalog entry is server, tool and input schema. One collection would force every query to
  filter by kind.
- **Different refresh triggers.** Skills change with the source git HEAD or `SKILL.md` mtimes; the
  catalog changes when an MCP server's tool list changes. One collection would re-index both
  whenever either changed.
- **Different query intents.** "Which skill covers this task?" answers with a file to read; "which
  tool do I need?" answers with a server to activate. Separate collections keep their ranking
  apart.

## Why one owner

`qmd collection add` fails when the name is taken. A raw-folder collection with the same name, as the
init script used to create, made the normalized corpus impossible to register while the index
looked healthy and qmd kept searching the wrong files. Now a taken name is accepted only when it
points at the corpus; any other folder fails with the command that frees the name:

```
qmd collection remove <name>
```

## Addendum: commands share the skills collection
Commands (#57) are indexed in the same collection. The reasons above for keeping the MCP catalog apart do
not apply to them: a command has the same schema as a skill (name, description, path) and the same query
intent (which file to read and follow). Cards carry a kind, and command cards live in `commands/` of the
corpus so a command and a skill can share a name. `toolgate skills index` remains the only owner.

## Consequences

- `toolgate skills search` and the router only query the project's skills collection. Its default
  name is per project (`skills-<directory>-<hash of the path>`, override with `skills.collection`)
  because qmd collections are global to the machine: a single shared `skills` name collided as soon
  as a second project was indexed.
- Skills declare the MCPs they need (a `mcps:` frontmatter key or a "Required MCPs" section). The
  router can use that link to activate servers without merging the two indexes.
- If qmd cannot be run, `skills search` matches keywords against the generated `_index.md` and
  reports `source: "fallback"` with the reason. Invalid input and a missing index fail loudly.
- Generated state lives in `.toolgate/skills-index/`, apart from `.toolgate/skills`, which is a
  default source.

## Addendum: commands (#57)

Commands (`/name` files) are indexed in the same skills collection, not in a collection of their own. They
share the schema that justified the split from the catalog (a name, a description, tags, required MCPs and a
path to read), the refresh trigger (the files of the sources) and the query intent ("which file covers this
task?"). The card says which kind it is, `route` and `skills search --kind` keep the two apart, and a skill and
a command with the same name are both indexed and both found. The Step 0 rule reads `commands` next to
`skills`: a command is a file to read, never something registered in the agent.
