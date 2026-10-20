# @pipeworx/california-tax-appeals

California Office of Tax Appeals (OTA) opinions — search by statute citation
or topic across 4,254 issued opinions (precedential and nonprecedential,
2018–2026), or retrieve one specific opinion's full text and cited
provisions by its OTA citation.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1851+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ca_ota_search(query, category?, precedential_only?, limit?)` — find
  opinions by topic keyword (e.g. "residency", "innocent spouse") or statute
  citation (e.g. "17014"). Returns citation, title, date, tax category
  (Franchise/Income Tax vs Business Tax), precedential status, and OTA's own
  one-line "Issues" tag, most recent first. Searches listing metadata only
  (title + Issues tag) — OTA publishes no full-text search.
- `ca_ota_opinion_lookup(cite)` — fetch one opinion by its OTA citation (e.g.
  "2020-OTA-263P"), live. Returns the full opinion text, exact date issued,
  OTA's internal case number, tax category, precedential status, and statute
  citations found in the text (best-effort R&TC/Cal. Code Regs./IRC).

## Auth

Keyless. No signup — this is a read of OTA's own published, public opinions.

## Data sources

- <https://ota.ca.gov/opinions/> — the landing page this pack's bake script
  (`scripts/bake-index.mjs`) scrapes to discover every per-year and
  all-precedential opinion listing page.
- Per-year listing pages, e.g. <https://ota.ca.gov/2024-franchise-income-tax-opinions/>
  and <https://ota.ca.gov/2024-business-tax-opinions/> — every opinion issued
  that year/category, precedential and nonprecedential alike.
- All-years precedential pages, e.g.
  <https://ota.ca.gov/all-precedential-franchise-and-income-tax-opinions/> —
  fetched too, to cover any year a per-year page might omit.
- Individual opinion PDFs (e.g.
  `https://ota.ca.gov/wp-content/uploads/sites/54/2021/06/19064883_Mazer_Opinion_Revised_090420_P.pdf`)
  — fetched live per `ca_ota_opinion_lookup` call, text extracted with
  `shared/src/pdf-text.ts`.

## Shape and known limits

ota.ca.gov (WordPress/WP Engine, TablePress tables) has **no JSON search
backend** — every opinion-listing page renders its whole table as static
HTML; the DataTables plugin paginates it client-side only (confirmed live:
every `DataTable('#tablepress-NNN', {...})` init call on these pages carries
no `ajax`/`serverSide` option). So this pack bakes a citation-indexed table
from OTA's own listing pages rather than proxying a search endpoint — see
`scripts/bake-index.mjs`'s own header for exactly which pages it fetches and
how it discovers new years without a code change.

Per root CLAUDE.md's standing rule on baked data (fleet #2754), the index
(4,254 rows, ~1.6MB) lives in KV, never gateway module scope — uploaded by
`scripts/sync-gateway-static-json.mjs` and injected as `args._bakedIndex`
(registered in `workers/gateway/src/pack-baked-indexes.json`).

`ca_ota_search` searches **listing metadata only** — the opinion title and
OTA's own one-line "Issues" tag (e.g. "Residency (R&TC 17014; Reg. 17014)").
A statute cited only in an opinion's full body text, and not in its Issues
tag, will not be found by search; use `ca_ota_opinion_lookup` on a specific
citation to read that opinion's full text.

"Case number" = OTA's own citation (e.g. "2020-OTA-263P", the trailing "P"
marking Precedential status) — what OTA itself cites opinions by, not the
PDF's internal 8-digit "OTA Case No." docket number (which only appears
inside the PDF body and is surfaced in `ca_ota_opinion_lookup`'s response as
`ota_case_no`, read live, not indexed). The trailing precedential marker may
be omitted when looking up a citation; `ca_ota_opinion_lookup` tries both
forms before reporting a miss. Some opinions carry other OTA suffix letters
(e.g. "...SCP" for a Summary Conclusion of Proceedings) — those must be
typed exactly.

A transport failure (non-200) or a listing/PDF mismatch (a 404 for a
citation the index says has a PDF) throws loudly naming the upstream status
— never a silent `found: false`. A PDF that exists but fails to extract
(rare; e.g. a scanned, non-text PDF) degrades to `full_text: null` with a
warning rather than throwing, since the opinion's metadata (title, date,
decision type, Issues tag) is still valid from the listing page.

Re-run `node scripts/bake-index.mjs > src/ca-ota-index-data.ts` periodically
to pick up newly issued opinions — it refuses to write a suspiciously small
index (fewer than 2,000 opinions or fewer than 15 listing pages fetched),
so a silent partial bake from an OTA markup change is caught rather than
shipped.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "california-tax-appeals": {
      "url": "https://gateway.pipeworx.io/california-tax-appeals/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/california-tax-appeals/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1851+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ca_ota_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"residency"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ca_ota_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "california-tax-appeals": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-california-tax-appeals"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-california-tax-appeals
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about California Tax Appeals data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
