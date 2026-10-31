# Service catalog: what runs where (spec)

Each environment repo keeps a `catalog/` directory of YAML files that say what runs, where, how it is reached, how its
health is checked, who owns it and where its docs are. Agents read it first instead of searching configs. The format
is [Backstage's entity vocabulary](https://backstage.io/docs/features/software-catalog/descriptor-format) without
running Backstage, plus one Saturn extension block, `x-saturn`.

- Schema: [schema/catalog.schema.json](../schema/catalog.schema.json). Tool: `tools/catalog/catalog` (Python stdlib).
- Synthetic example: [fixtures/catalog-example/](../fixtures/catalog-example/).
- **Never** in a catalog: secret values, health data, people's names (other than the owner's account), PHI. Secret
  **names** and the file they live in are fine and wanted.

## Files

`catalog/*.yaml`, one or more entities per file separated by `---`. The tool reads a YAML subset (block maps and
lists, `[a, b]` flow lists, quoted or plain scalars, `|` and `>` block text, `#` comments); anything else is an error.

## Entities

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component            # System | Component | API | Resource | Group
metadata:
  name: agent-router       # [a-z0-9-], unique across every catalog that is merged
  title: Agent router
  description: One sentence a stranger understands.
  tags: [box, python]
  links: [{url: "https://...", title: Docs}]
spec:
  type: service            # see the table below
  lifecycle: production    # experimental | trial | production | deprecated
  owner: group:owner
  system: agent-server
  dependsOn: [resource:tusharpc]
  providesApis: [router-api]
  consumesApis: []
x-saturn: {...}            # below
```

| kind | `spec.type` | other spec fields |
|---|---|---|
| System | (none) | owner, lifecycle, dependsOn |
| Component | service, cli, job, website, library | lifecycle, owner, system, subcomponentOf, dependsOn, providesApis, consumesApis |
| API | openapi, other | lifecycle, owner, system, definition (a URL or repo path) |
| Resource | database, bucket, repo, queue, file-store, host, network, secret-store | owner, system, lifecycle, dependsOn |
| Group | person, team, org | parent, children |

References are `[kind:]name` (`resource:d1`, or `d1` when the name is unique). Names are unique across all merged
catalogs, so `/catalog/{name}` needs no kind. `host`, `network` and `secret-store` extend Backstage's open resource
type list for the machine, the tailnet and SOPS files.

## `x-saturn`

| key | what |
|---|---|
| `urls[]` | `{name, url, tailnet, phi}`. `tailnet: true` = reachable only from the owner's tailnet devices. `phi: true` = the page shows health data |
| `ports[]` | `{port, bind, protocol, tailnet, note}`. `bind: 127.0.0.1` = loopback only |
| `auth` | `{method, secrets[{name, location, note}], notes}`. `location` is a SOPS file path or a box path; **never a value** |
| `health` | `http{url, status, conditions[]}`, `unit` (systemd), `metric` (PromQL that is 1 when healthy), `check` (the Gatus `group/name` that watches it), `gatus{group, name, interval}` (generate that check from `http`), `description` (alert text) |
| `data` | `{phi, reads[], writes[], notes}`; `phi: true` when it stores or serves health data |
| `docs[]` | `<repo>:<path>[#anchor]` or an https URL |
| `runbook[]` | `{what, cmd, where}`; read paths first; anything that changes state says so in `what` |
| `agents` | plain notes for agents: how to use it, what not to do |

## Tool

```
tools/catalog/catalog validate DIR...                  schema, references resolve, names unique, no secret-looking values
tools/catalog/catalog merge DIR... [-o FILE]           one multi-document YAML
tools/catalog/catalog gen wellknown DIR... [-o FILE]   merged JSON ({catalog, entities[]}) for /.well-known/saturn-catalog.json
tools/catalog/catalog gen llms DIR... --out DIR        llms.txt (short map) + llms-full.txt (every entity) per llmstxt.org
tools/catalog/catalog gen agents-md DIR... --target AGENTS.md [--check]
                                                       the "Where is what" block between
                                                       <!-- catalog:where-is-what start --> and <!-- ... end -->
tools/catalog/catalog gen gatus DIR... [--format yaml|json] [-o FILE]
                                                       Gatus endpoints for every entity with health.http + health.gatus
```

Every `gen` and `merge` validates first and is deterministic (no timestamps), so a CI job can regenerate and diff.
`--title` and `--summary` set the llms.txt heading and blockquote. Exit codes: 0 ok, 1 invalid catalog, 2 usage.

The secret rule flags any string that looks like a credential (known token prefixes, private-key headers, bot tokens,
32+ character random-looking strings). Opaque ids that look random (account or database ids) belong in the env repo's
`env.yaml`, not the catalog: point at them with a `docs` entry.

Gatus endpoints come out in Gatus's own shape (`name, group, url, interval, conditions`, plus
`alerts: [{type: custom, description}]` when `health.description` is set; `--alert-type` changes the type), so an
env repo can load the JSON form as is (Nix: `builtins.fromJSON`). Check names are `health.gatus.{group,name}`, so an
existing hand-written check keeps its name when it moves into the catalog.
