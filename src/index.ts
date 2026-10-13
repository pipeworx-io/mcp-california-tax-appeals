interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/**
 * Minimal text extractor for simple, text-based PDFs — the kind a
 * mail-merge/print pipeline produces (Word or LibreOffice "export to PDF"),
 * not a scanned image. Built for Kentucky's per-statute PDFs
 * (apps.legislature.ky.gov/law/statutes/statute.aspx?id=...), which ARE
 * exactly that shape: one object tree, FlateDecode content streams, standard
 * TrueType fonts. This is the capability the state-law survey flagged as
 * "the largest single win available" (docs/state-law-probe.md) — several
 * state statute sites serve text ONLY as a per-section PDF, with no HTML
 * fallback, and until now this repo had no way to read one.
 *
 * WHAT THIS DOES NOT DO: parse a general PDF. No encryption, no cross-
 * reference recovery for a damaged file, no image/OCR, no custom
 * `/Differences` glyph encodings, no LZW or RunLength filters, no multi-byte
 * codespaces other than the 2-byte one every sampled font used. Most objects
 * this needs — Catalog, Pages, a leaf Page, its Resources/Font dict, its
 * Contents stream(s), a Type0 font's ToUnicode CMap — are found by scanning
 * for `N 0 obj ... endobj` directly in the file bytes. If a producer moves
 * one into a compressed object stream and this extractor still cannot find
 * it (see the next paragraph for what IS handled), extraction degrades to
 * `pages_found: 0` / empty text rather than silently returning garbage —
 * check `warnings` before trusting a thin result.
 *
 * COMPRESSED OBJECT STREAMS (`/Type/ObjStm`) ARE SUPPORTED (fleet #2744,
 * added for Wyoming's statute PDFs, which — unlike Kentucky's — are
 * cross-reference-STREAM files whose Catalog and Pages root are themselves
 * compressed into an ObjStm: `5205 0 obj` never appears literally in the
 * file; it exists only as entry in a decompressed `/Type/ObjStm` stream).
 * Every direct `/Type/ObjStm` object found in the file is inflated up front;
 * its header (`/N` object pairs starting at byte `/First`) is parsed into a
 * `(object number -> dict text)` map, and `getObject` falls back to that map
 * whenever the direct byte-scan finds nothing. Per the PDF spec a compressed
 * object can never itself contain a stream (Contents, ToUnicode CMaps, and
 * ObjStm/XRef streams are therefore always direct objects, found the
 * original way) — so this fallback only ever needs to resolve plain
 * dictionaries/arrays (Catalog, Pages, Font, sometimes Page), which is
 * exactly what Wyoming's shape needs. An ObjStm nested inside another
 * ObjStm via `/Extends` is NOT walked — not observed in any file tested.
 *
 * ALSO FIXED HERE: the Catalog/Pages discovery no longer requires `/Type`
 * to be the first thing found after `<<` in a Catalog's own dictionary text
 * — the original `<<[^>]*\/Type\s*\/Catalog` regex broke the moment any
 * NESTED dict (e.g. `/MarkInfo<</Marked true>>`) appeared earlier in the
 * same object, because `[^>]*` cannot cross that inner `>>`. Wyoming's real
 * Catalog objects are exactly this shape (`/Lang(...)/MarkInfo<<...>>
 * /Metadata .../Pages .../Type/Catalog/ViewerPreferences<<...>>`, `/Type`
 * nowhere near the start). Discovery now finds `/Type/Catalog` (or
 * `/Type/Pages`) as plain text anywhere — direct or inside a decompressed
 * ObjStm — and locates its OWN object number by nearest preceding
 * `N 0 obj` marker, which works regardless of what else is in the dict.
 *
 * TWO FONT SHAPES, BOTH NEEDED (confirmed against real KRS statute PDFs,
 * fleet #2734):
 *   - Simple TrueType/Type1 with `/Encoding/WinAnsiEncoding` — the common
 *     case. WinAnsiEncoding is BY DESIGN identical to Windows code page 1252
 *     (that is what "WinAnsi" means), so the raw string-literal bytes decode
 *     directly via `TextDecoder('windows-1252')` with no per-glyph table of
 *     our own to get wrong.
 *   - Type0/CIDFontType2 with `/Encoding/Identity-H` — seen even inside an
 *     otherwise-simple statute, apparently whenever the PDF producer's text
 *     shaping fell back to a subset-embedded font for one run (KRS 532.025's
 *     closing sentence, which includes a curly apostrophe, was entirely in
 *     this font while the rest of the document used WinAnsi). Each character
 *     is a 2-byte CID with NO inherent meaning; the `/ToUnicode` CMap
 *     attached to the font is the only place the real Unicode value lives
 *     (`beginbfchar`/`beginbfrange` blocks). Skipping this font shape would
 *     have truncated or corrupted exactly the statutes that happen to use a
 *     special character — not a rare edge case, a silent one.
 *
 * Verified end-to-end against two real KRS statutes during this pack's
 * build: a single-page WinAnsi-only PDF (507.020, Murder) and a four-page PDF
 * mixing both font shapes (532.025, including the CID-encoded sentence
 * naming "Kimber's Law") — both reproduced the statute's true text exactly,
 * eyeballed against the rendered PDF.
 *
 * INDIRECT /Length (fleet #2743): extended for North Dakota's Century Code
 * chapter PDFs (ndlegis.gov/cencode/t*.pdf), whose content streams all write
 * `/Length` as an indirect reference ("/Length 3 0 R") rather than inlining
 * the literal integer the way every sampled KRS PDF did. The referenced
 * object is resolved (it is always a bare integer object, never itself a
 * stream) rather than falling back to scanning for the "endstream" keyword —
 * that fallback slices in the EOL bytes between the compressed data and the
 * keyword, which this repo's own Node zlib rejects as "trailing junk" even
 * though the compressed payload is intact (Workers' DecompressionStream may
 * be more lenient, but Node is what `prepush-tests.mjs` runs, so the bug was
 * real either way). Verified against ND Century Code chapter 12.1-16
 * (Homicide, t12-1c16.pdf) — every content stream in that 9-page PDF uses
 * the indirect form.
 *
 * THREE FIXES PORTED FROM mcps/guam-code's PACK-LOCAL FORK (fleet #2904,
 * folding in #2888's src/gu-pdf-extract.ts -- nothing about them was
 * actually Guam-specific, which is why they live here now instead of only
 * in that fork):
 *   1. inflate()'s two stream writes were fire-and-forget
 *      (void writer.write(...) / void writer.close()). A malformed deflate
 *      stream (real, not hypothetical -- seen across several Guam chapter
 *      PDFs) rejects that detached promise UNHANDLED, invisible to any
 *      try/catch wrapped around this function's caller and fatal to the
 *      whole Node process; in a Worker it is an unhandled rejection on a
 *      live request. Both writes now carry a no-op .catch() -- the real
 *      failure still surfaces through reader.read() below, which every
 *      caller already handles.
 *   2. A literal (parenthesized) string run was decoded by passing its raw
 *      windows-1252-decoded bytes through unchanged, which is correct for a
 *      WinAnsi font but wrong for a mapped1/cid font whose code space only
 *      means anything via its own /ToUnicode CMap -- the same lookup a hex
 *      string run already gets. Guam's PDF producer writes several of its
 *      non-WinAnsi subset-embedded fonts' text as literal strings rather
 *      than hex, which this extractor previously decoded as line-noise
 *      control characters instead of the real text.
 *   3. decompressedStream now retries a /FlateDecode stream with its tail
 *      trimmed 1-4 bytes before giving up. Several real PDFs declare a
 *      /Length a few bytes LONGER than the true deflate stream (confirmed
 *      on Guam's 21gc033.pdf object 2: /Length says 96, the deflate stream
 *      completes at byte 95, byte 96 is one stray trailing byte). Python's
 *      zlib tolerates trailing garbage by default; the Workers/Node
 *      DecompressionStream used here does not and throws "Trailing junk
 *      found after the end of the compressed stream" -- the true stream
 *      length is always <= the declared one in every sample seen, never
 *      longer, so trimming is safe.
 */

interface PdfExtractResult {
  /** Extracted text, pages joined with a blank line. Empty string if nothing
   *  could be read — check `warnings`, not just truthiness, before deciding
   *  that means the document has no text. */
  text: string;
  /** Number of leaf /Type/Page objects found via the Pages tree (the WHOLE
   *  document's page count, even when `pageRange` restricted extraction to
   *  a subset — see `extractedPages` for how many were actually read). */
  pages: number;
  /** Number of pages actually extracted into `text`. Equal to `pages`
   *  unless a `pageRange` option restricted the run. */
  extractedPages: number;
  /** Non-fatal problems found while extracting (unknown font, missing
   *  ToUnicode, etc). A non-empty array does not mean the text is wrong, but
   *  it means something was guessed rather than read. */
  warnings: string[];
}

interface PdfExtractOptions {
  /** Restrict extraction to a slice of the document's leaf pages, bounded by
   *  PAGE OBJECT NUMBERS rather than page indexes — built for sources (e.g.
   *  New Mexico's NMOneSource chapter PDFs, fleet #2884) whose per-section
   *  bookmarks in `extractPdfOutline`'s output give a /Dest page object
   *  directly, with no indexing step of their own needed. `fromPageObj` is
   *  resolved to its position in document order and extraction starts
   *  there; `toPageObj` (also resolved to its position) is the LAST page
   *  included — pass the object a FOLLOWING bookmark points to and extract
   *  up to (not including) it by resolving that page's own PRECEDING page
   *  instead, since this is page-granularity, not byte-granularity. If
   *  `fromPageObj` is not found among the document's pages, this option is
   *  ignored and the whole document is extracted (a safe fallback, not a
   *  silent wrong answer — a warning is added). */
  pageRange?: { fromPageObj: number; toPageObj?: number };

  /** Called right after a font's own /ToUnicode CMap is parsed (for either
   *  a Type0 font's CID map or a simple font's 1-byte map), before it is
   *  used to decode any text. Return a REPLACEMENT map to override specific
   *  codes, or return nothing (undefined) to use the parsed map unchanged.
   *  Built for mcps/guam-code (fleet #2888/#2904): one embedded symbol font
   *  per chapter PDF carries a /ToUnicode CMap that is itself wrong in the
   *  SOURCE file (confirmed by eye against the rendered PDF — not a general
   *  parsing defect this shared extractor could detect), so the fix is
   *  keyed by matching `fontDict` against something only that caller's PDFs
   *  produce (there, a font name) rather than built into this file. */
  fontCMapOverride?: (fontDict: string, map: Map<number, number>) => Map<number, number> | void;
}

interface PdfOutlineEntry {
  /** The bookmark's own text, verbatim (e.g. "30-2-1. Murder." or
   *  "ARTICLE 1  General Provisions" or "ANNOTATIONS"). */
  title: string;
  /** The PDF page OBJECT NUMBER this bookmark's /Dest (or /A GoTo action)
   *  points to, or null if neither was found on this node. Pass this
   *  straight into `extractPdfText`'s `pageRange` option — no index lookup
   *  needed on the caller's side. */
  pageObjNum: number | null;
  /** Nesting depth in the outline tree, root's children = 0. A section's
   *  own "ANNOTATIONS" child (depth = section's depth + 1) is how a caller
   *  distinguishes statutory text from case annotations that start on the
   *  same page — see mcps/new-mexico-code for the worked example. */
  depth: number;
}

type FontDecoder =
  | { kind: 'winansi' }
  | { kind: 'cid'; map: Map<number, number> }
  // Simple (1-byte-code) font decoded via its own /ToUnicode CMap rather than
  // WinAnsi — see fontDecoderFor's comment on North Dakota's subsetted fonts.
  | { kind: 'mapped1'; map: Map<number, number> };

/** Inflate one `/FlateDecode` stream using the platform's own zlib — no
 *  dependency, works identically in the Workers runtime and in Node (used by
 *  this repo's prepush tests), because both implement the standard
 *  CompressionStream/DecompressionStream API over the zlib wire format PDF's
 *  FlateDecode filter already uses. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  // Fire-and-forget on purpose: the actual decompression result/error comes
  // through reader.read() below, which every caller already wraps in a
  // try/catch. Without a .catch() here, a malformed deflate stream rejects
  // this DETACHED write/close promise UNHANDLED -- invisible to that
  // try/catch and fatal to the whole process (ported from
  // mcps/guam-code's gu-pdf-extract.ts FORK FIX 3/3, fleet #2888/#2904;
  // confirmed crashing scripts/bake-sections.mjs outright on real Guam
  // chapter PDFs). The no-op .catch() here does not hide a real failure --
  // it still surfaces through reader.read() for the caller to see.
  const writeDone = writer.write(bytes).catch(() => {});
  const closeDone = writer.close().catch(() => {});
  void writeDone;
  void closeDone;
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Undo PDF string-literal escaping — `\(`, `\)`, `\\`, `\n`/`\r`/`\t`,
 * octal `\ddd`, and a trailing backslash-newline line continuation — on a
 * windows-1252-decoded slice. Safe to run on the decoded string rather than
 * raw bytes: every character this function inspects or produces (backslash,
 * parens, digits, the letters n/r/t/b/f) is plain ASCII, which windows-1252
 * never remaps, so the 1-byte-per-character alignment this relies on holds
 * throughout.
 */
function unescapePdfLiteral(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const next = s[i + 1];
    if (next === undefined) continue;
    if (next === 'n') { out += '\n'; i++; }
    else if (next === 'r') { out += '\r'; i++; }
    else if (next === 't') { out += '\t'; i++; }
    else if (next === 'b' || next === 'f') { i++; }
    else if (next === '(' || next === ')' || next === '\\') { out += next; i++; }
    else if (next >= '0' && next <= '7') {
      let oct = next, j = i + 1, k = 0;
      while (k < 2 && s[j + 1] >= '0' && s[j + 1] <= '7') { j++; oct += s[j]; k++; }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      i = j;
    } else if (next === '\n') { i++; }
    else if (next === '\r') { i++; if (s[i + 1] === '\n') i++; }
    else { out += next; i++; }
  }
  return out;
}

interface RawObject {
  dict: string;
  streamBytes: Uint8Array | null;
}

/** Extract readable text from a simple, non-encrypted, non-scanned PDF. */
async function extractPdfText(buf: ArrayBuffer, options?: PdfExtractOptions): Promise<PdfExtractResult> {
  const bytes = new Uint8Array(buf);
  // windows-1252 decode is total (every byte maps to exactly one UTF-16 code
  // unit) and length-preserving, so a match index found in `scan` is also a
  // valid BYTE offset into `bytes` — used below to slice stream data without
  // ever routing binary bytes through a lossy string round-trip.
  const scan = new TextDecoder('windows-1252').decode(bytes);
  const warnings: string[] = [];
  const objCache = new Map<number, RawObject | null>();

  // Byte offset of every DIRECT "N 0 obj" marker, sorted, for two uses: (1)
  // the object-lookup fallback stays regex-per-object the same as before;
  // (2) `objNumBefore` below answers "which object's text is this index
  // inside", which is how Catalog/Pages/ObjStm discovery works regardless of
  // what else that object's dictionary contains — see the file header.
  const objStarts: { index: number; num: number }[] = [];
  // Object number -> index right after its "N 0 obj" marker (i.e. where the
  // dictionary text begins), for every object found by the SAME forward
  // scan that builds objStarts — first occurrence wins, matching what a
  // one-shot `.exec` would find. This turns getDirectObject's lookup from
  // one full-document regex scan PER DISTINCT OBJECT NUMBER into one O(1)
  // map read: with a large page-tree walk (New Mexico's chapter PDFs run
  // 657-1,138+ pages, fleet #2884) the old per-call scan made even a
  // `pageRange`-restricted extraction cost nearly as much as extracting the
  // whole document, because walking the Pages tree alone touches every
  // page's object once regardless of how many are actually rendered —
  // measured 1,611ms for a 56-of-1,138-page extraction before this fix vs.
  // 1,699ms for the full document. The fallback regex scan below is kept
  // for any object this forward pass didn't catch (none observed, but
  // cheaper to keep than to prove impossible).
  const objEndByNum = new Map<number, number>();
  {
    const re = /(\d+)\s+0\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      objStarts.push({ index: m.index, num: parseInt(m[1], 10) });
      const num = parseInt(m[1], 10);
      if (!objEndByNum.has(num)) objEndByNum.set(num, m.index + m[0].length);
    }
  }
  function objNumBefore(markerIndex: number): number | null {
    let lo = 0, hi = objStarts.length - 1, ans: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (objStarts[mid].index <= markerIndex) { ans = objStarts[mid].num; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function getDirectObject(n: number): RawObject | null {
    if (objCache.has(n)) return objCache.get(n) ?? null;
    const fastEnd = objEndByNum.get(n);
    let objStart: number;
    if (fastEnd !== undefined) {
      objStart = fastEnd;
    } else {
      const re = new RegExp(`(?:^|\\D)${n}\\s+0\\s+obj`);
      const m = re.exec(scan);
      if (!m) { objCache.set(n, null); return null; }
      objStart = m.index + m[0].length;
    }
    const endobjIdx = scan.indexOf('endobj', objStart);
    const streamIdx = scan.indexOf('stream', objStart);
    let dict: string;
    let streamBytes: Uint8Array | null = null;
    if (streamIdx !== -1 && (endobjIdx === -1 || streamIdx < endobjIdx)) {
      dict = scan.slice(objStart, streamIdx);
      let dataStart = streamIdx + 'stream'.length;
      if (bytes[dataStart] === 0x0d) dataStart++;
      if (bytes[dataStart] === 0x0a) dataStart++;
      // Matches EITHER "/Length 428" (literal) or "/Length 12 0 R"
      // (indirect) — group 2 is present only for the indirect form. Written
      // this way ON PURPOSE instead of the more obvious
      // `/\/Length\s+(\d+)(?!\s+0\s+R)/` for a literal: that negative
      // lookahead is a backtracking trap for any MULTI-DIGIT indirect
      // reference. On "/Length 12 0 R", a greedy `(\d+)` first tries "12",
      // the lookahead correctly forbids it (followed by " 0 R") — but the
      // engine then backtracks `\d+` down to "1", at which point the
      // lookahead is checked against "2 0 R", which does NOT start with
      // whitespace, so the forbidden pattern no longer matches and the
      // lookahead (wrongly) PASSES. The match silently becomes "1" instead
      // of failing, so this object's /Length reads as the literal integer 1
      // instead of as a reference to resolve — exactly the shape of North
      // Dakota's Century Code chapter PDFs (fleet #2743), whose indirect
      // Length refs are almost all two or more digits. An explicit optional
      // group has nothing to backtrack: `(\d+)` greedily keeps "12" and the
      // optional `(\s+0\s+R)?` either matches right after it or doesn't.
      const lenDictMatch = /\/Length\s+(\d+)(\s+0\s+R)?/.exec(dict);
      let dataEnd = -1;
      if (lenDictMatch) {
        if (!lenDictMatch[2]) {
          dataEnd = dataStart + parseInt(lenDictMatch[1], 10);
        } else {
          // Indirect reference. The referenced object is a bare integer
          // ("12 0 obj\n4541\nendobj"), never itself a stream, so resolving
          // it through the same getObject() is safe (no recursion risk back
          // onto object n). Falling back to scanning for the "endstream"
          // keyword instead — which the pre-fix code did unconditionally
          // here — slices in the EOL bytes PDF producers place between the
          // compressed data and that keyword, which Node's strict zlib
          // rejects as "trailing junk" even though the compressed payload
          // itself is intact.
          const lenObj = getObject(parseInt(lenDictMatch[1], 10));
          const lenVal = lenObj ? parseInt(lenObj.dict.trim(), 10) : NaN;
          if (Number.isFinite(lenVal) && lenVal >= 0) dataEnd = dataStart + lenVal;
        }
      }
      if (dataEnd === -1) dataEnd = scan.indexOf('endstream', dataStart);
      streamBytes = bytes.slice(dataStart, dataEnd);
    } else {
      dict = scan.slice(objStart, endobjIdx === -1 ? scan.length : endobjIdx);
    }
    const result = { dict, streamBytes };
    objCache.set(n, result);
    return result;
  }

  // Compressed objects (inside a /Type/ObjStm) — object number -> dict text.
  // Populated below, before any Catalog/Pages/Font lookup runs, because a
  // compressed Catalog or Pages root (Wyoming's shape) must resolve exactly
  // like a direct one from that point on. Never holds a stream: the PDF spec
  // forbids a compressed object from containing one.
  const compressedObjects = new Map<number, string>();
  {
    const objStmNums: number[] = [];
    const re = /\/Type\s*\/ObjStm\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      const n = objNumBefore(m.index);
      if (n !== null) objStmNums.push(n);
    }
    for (const n of objStmNums) {
      const obj = getDirectObject(n);
      if (!obj || !obj.streamBytes) { warnings.push(`ObjStm ${n} has no stream data`); continue; }
      let data: Uint8Array;
      if (/\/Filter\s*\/FlateDecode/.test(obj.dict)) {
        try {
          data = await inflate(obj.streamBytes);
        } catch (e) {
          warnings.push(`inflate failed for ObjStm ${n}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      } else {
        data = obj.streamBytes;
      }
      const nMatch = /\/N\s+(\d+)/.exec(obj.dict);
      const firstMatch = /\/First\s+(\d+)/.exec(obj.dict);
      if (!nMatch || !firstMatch) { warnings.push(`ObjStm ${n} missing /N or /First`); continue; }
      const count = parseInt(nMatch[1], 10);
      const first = parseInt(firstMatch[1], 10);
      const header = new TextDecoder('latin1').decode(data.slice(0, first)).trim().split(/\s+/).map((x) => parseInt(x, 10));
      const entries: { num: number; offset: number }[] = [];
      for (let i = 0; i + 1 < header.length && entries.length < count; i += 2) {
        entries.push({ num: header[i], offset: header[i + 1] });
      }
      const body = new TextDecoder('windows-1252').decode(data);
      for (let i = 0; i < entries.length; i++) {
        const start = first + entries[i].offset;
        const end = i + 1 < entries.length ? first + entries[i + 1].offset : data.length;
        if (start < 0 || end > data.length || start > end) {
          warnings.push(`ObjStm ${n} entry ${entries[i].num} has an out-of-range offset, skipped`);
          continue;
        }
        compressedObjects.set(entries[i].num, body.slice(start, end));
      }
    }
  }

  // The lookup every caller below actually uses: direct object text, falling
  // back to a compressed one. Never both — a given object number is either
  // found literally in the file or inside exactly one ObjStm, not both.
  function getObject(n: number): RawObject | null {
    const direct = getDirectObject(n);
    if (direct) return direct;
    const compressed = compressedObjects.get(n);
    if (compressed !== undefined) return { dict: compressed, streamBytes: null };
    return null;
  }

  async function decompressedStream(n: number): Promise<Uint8Array | null> {
    const obj = getObject(n);
    if (!obj || !obj.streamBytes) return null;
    if (/\/FlateDecode/.test(obj.dict)) {
      // Ported from mcps/guam-code's gu-pdf-extract.ts FORK FIX (fleet
      // #2888/#2904): several real PDFs store a /Length a small number of
      // bytes LONGER than the TRUE deflate stream length (confirmed on
      // Guam's 21gc033.pdf object 2: /Length says 96, the deflate stream is
      // complete at byte 95, and the 96th byte is one stray trailing byte).
      // Python's zlib tolerates trailing garbage by default; the
      // Workers/Node DecompressionStream used here does not and throws
      // "Trailing junk found after the end of the compressed stream".
      // Rather than fail the whole page, retry with the slice trimmed one
      // byte shorter a few times -- the true stream length is always <= the
      // declared one in every sample seen, never longer.
      for (let trim = 0; trim <= 4 && trim < obj.streamBytes.length; trim++) {
        try {
          return await inflate(trim === 0 ? obj.streamBytes : obj.streamBytes.subarray(0, obj.streamBytes.length - trim));
        } catch (e) {
          if (trim === 4) {
            warnings.push(`inflate failed for object ${n} even after trimming trailing bytes: ${e instanceof Error ? e.message : String(e)}`);
            return null;
          }
        }
      }
      return null;
    }
    return obj.streamBytes;
  }

  // Catalog -> Pages -> Kids, walked in document order. Falls back to the
  // first /Type/Pages object if no /Type/Catalog is found. Both searches
  // look for the TYPE MARKER as plain text first (direct text, or inside any
  // decompressed ObjStm body) and then find which object that text belongs
  // to — see the file header for why this replaced a single greedy regex.
  let pagesRef: number | null = null;
  function findObjWithType(typeName: string): number | null {
    const directIdx = scan.search(new RegExp(`/Type\\s*/${typeName}\\b`));
    if (directIdx !== -1) {
      const n = objNumBefore(directIdx);
      if (n !== null) return n;
    }
    const typeRe = new RegExp(`/Type\\s*/${typeName}\\b`);
    for (const [num, text] of compressedObjects) {
      if (typeRe.test(text)) return num;
    }
    return null;
  }
  const catNum = findObjWithType('Catalog');
  if (catNum !== null) {
    const catObj = getObject(catNum);
    const pm = catObj ? /\/Pages\s+(\d+)\s+0\s+R/.exec(catObj.dict) : null;
    if (pm) pagesRef = parseInt(pm[1], 10);
  }
  if (pagesRef === null) {
    pagesRef = findObjWithType('Pages');
  }

  const leafPages: number[] = [];
  function walkPages(n: number, depth: number): void {
    if (depth > 12) { warnings.push('Pages tree exceeded depth 12, stopped walking'); return; }
    const obj = getObject(n);
    if (!obj) return;
    if (/\/Type\s*\/Page\b(?!s)/.test(obj.dict)) { leafPages.push(n); return; }
    const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(obj.dict);
    if (!kidsMatch) return;
    for (const km of kidsMatch[1].matchAll(/(\d+)\s+0\s+R/g)) walkPages(parseInt(km[1], 10), depth + 1);
  }
  if (pagesRef !== null) walkPages(pagesRef, 0);
  else warnings.push('no /Type/Catalog or /Type/Pages object found');

  const totalPages = leafPages.length;
  let pagesToExtract = leafPages;
  if (options?.pageRange) {
    const { fromPageObj, toPageObj } = options.pageRange;
    const fromIdx = leafPages.indexOf(fromPageObj);
    if (fromIdx === -1) {
      warnings.push(
        `pageRange.fromPageObj ${fromPageObj} is not a leaf page in this document — extracting the whole document instead of the requested range.`,
      );
    } else {
      let toIdx = leafPages.length - 1;
      if (toPageObj !== undefined) {
        const foundToIdx = leafPages.indexOf(toPageObj);
        // toPageObj not found, or found strictly BEFORE fromIdx (a bad or
        // out-of-order bookmark), falls back to end-of-document rather than
        // producing a negative-length slice. Equal to fromIdx is normal and
        // valid — a section whose first bookmarked child (e.g. its own
        // "ANNOTATIONS") starts on the SAME page is a single-page range,
        // not an error.
        if (foundToIdx >= fromIdx) toIdx = foundToIdx;
        else if (foundToIdx !== -1) {
          warnings.push(
            `pageRange.toPageObj ${toPageObj} resolves to a page before fromPageObj ${fromPageObj} — extracting through end of document instead.`,
          );
        } else {
          warnings.push(`pageRange.toPageObj ${toPageObj} is not a leaf page in this document — extracting through end of document instead.`);
        }
      }
      pagesToExtract = leafPages.slice(fromIdx, toIdx + 1);
    }
  }

  /** Parse a /ToUnicode CMap stream's `beginbfchar`/`beginbfrange` blocks into
   *  a code -> Unicode-codepoint map. Shared between Type0's 2-byte CIDs and
   *  a simple font's 1-byte codes — the CMap text format is identical either
   *  way; only how the caller SLICES its hex string differs (see decodeRun). */
  async function parseToUnicodeCMap(cmapObjNum: number): Promise<Map<number, number>> {
    const cmapBytes = await decompressedStream(cmapObjNum);
    const cmapText = cmapBytes ? new TextDecoder('latin1').decode(cmapBytes) : '';
    const map = new Map<number, number>();
    for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(parseInt(pair[1], 16), parseInt(pair[2].slice(0, 4), 16));
      }
    }
    for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const triple of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(triple[1], 16), hi = parseInt(triple[2], 16), base = parseInt(triple[3].slice(0, 4), 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, base + (c - lo));
      }
    }
    return map;
  }

  async function fontDecoderFor(fontObjNum: number): Promise<FontDecoder> {
    const obj = getObject(fontObjNum);
    if (!obj) return { kind: 'winansi' };
    if (/\/Subtype\s*\/Type0\b/.test(obj.dict)) {
      const tuMatch = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
      if (!tuMatch) {
        warnings.push(`Type0 font object ${fontObjNum} has no /ToUnicode; its text will show as U+FFFD`);
        return { kind: 'cid', map: new Map() };
      }
      const map = await parseToUnicodeCMap(parseInt(tuMatch[1], 10));
      return { kind: 'cid', map: options?.fontCMapOverride?.(obj.dict, map) ?? map };
    }
    // Simple font. Every KRS sample used /WinAnsiEncoding, which decodes
    // directly as windows-1252 bytes below — unchanged. North Dakota's
    // Century Code PDFs (fleet #2743) use simple TrueType fonts that declare
    // NO /Encoding at all: their embedded subsets number glyphs 0, 1, 2... in
    // whatever order the subsetter emitted them, with no relationship to any
    // standard code page — reading code 0x01 as the WinAnsi byte 0x01 (a
    // control character) produces blank/garbled output, not a wrong letter.
    // Those fonts DO carry a /ToUnicode CMap (the same mechanism Type0 fonts
    // use above, just keyed by a 1-byte code instead of a 2-byte CID), which
    // is the only place the real character is recorded — use it whenever the
    // font isn't declared WinAnsi rather than guessing.
    if (!/\/Encoding\s*\/WinAnsiEncoding\b/.test(obj.dict)) {
      const tuMatch = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
      if (tuMatch) {
        const parsedMap = await parseToUnicodeCMap(parseInt(tuMatch[1], 10));
        const map = options?.fontCMapOverride?.(obj.dict, parsedMap) ?? parsedMap;
        if (map.size) return { kind: 'mapped1', map };
      }
      warnings.push(`font object ${fontObjNum} has a non-WinAnsi simple encoding and no usable /ToUnicode; decoded as WinAnsi anyway`);
    }
    return { kind: 'winansi' };
  }

  const TOKEN_RE =
    /\/(\S+)\s+[\d.]+\s+Tf|\[((?:\\.|[^\]])*)\]\s*TJ|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^()])*)\)\s*Tj|1\s+0\s+0\s+1\s+[\d.-]+\s+([\d.-]+)\s+Tm/g;
  const TJ_PIECE_RE = /\(((?:\\.|[^()])*)\)|<([0-9A-Fa-f\s]*)>/g;

  function decodeRun(dec: FontDecoder, literal: string | undefined, hex: string | undefined): string {
    if (literal !== undefined) {
      const unescaped = unescapePdfLiteral(literal);
      // Ported from mcps/guam-code's gu-pdf-extract.ts FORK FIX 1/2 (fleet
      // #2888/#2904): a WinAnsi run's literal-string bytes ARE already the
      // correct windows-1252 text (unchanged below) -- but a non-WinAnsi
      // simple font ('mapped1') or a Type0 font ('cid') can ALSO show up as
      // a literal string rather than hex. Guam's PDF producer writes
      // several of its subset-embedded fonts' text this way; passing the
      // raw byte through unchanged (the old behavior here) skips that
      // font's /ToUnicode map entirely and produces line-noise control
      // characters instead of the real character -- route it through the
      // SAME decoder a hex run below already uses.
      if (dec.kind === 'winansi') return unescaped;
      let out = '';
      for (let i = 0; i < unescaped.length; i++) {
        const code = unescaped.charCodeAt(i) & 0xff;
        out += String.fromCodePoint(dec.map.get(code) ?? 0xfffd);
      }
      return out;
    }
    const cleaned = (hex ?? '').replace(/\s+/g, '');
    let out = '';
    if (dec.kind === 'mapped1') {
      // 1-byte code per glyph (a simple font's code space), unlike Type0's
      // 2-byte CIDs below — see fontDecoderFor.
      for (let i = 0; i + 2 <= cleaned.length; i += 2) {
        const code = parseInt(cleaned.slice(i, i + 2), 16);
        out += String.fromCodePoint(dec.map.get(code) ?? 0xfffd);
      }
      return out;
    }
    for (let i = 0; i + 4 <= cleaned.length; i += 4) {
      const cid = parseInt(cleaned.slice(i, i + 4), 16);
      if (dec.kind === 'cid') out += String.fromCodePoint(dec.map.get(cid) ?? 0xfffd);
      else out += String.fromCharCode(cid & 0xff);
    }
    return out;
  }

  const pageTexts: string[] = [];
  for (const pn of pagesToExtract) {
    const page = getObject(pn);
    if (!page) continue;

    let resourcesDict = page.dict;
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.dict);
    if (resRef) {
      const ro = getObject(parseInt(resRef[1], 10));
      if (ro) resourcesDict = ro.dict;
    }
    // /Font is usually inline in Resources, but North Dakota's Century Code
    // PDFs (fleet #2743) write it as an indirect reference ("/Font 18 0 R")
    // to a separate dict object — resolve that one hop before giving up.
    let fontDictBody: string | null = null;
    const inlineFontMatch = /\/Font\s*<<([^>]*)>>/.exec(resourcesDict);
    if (inlineFontMatch) {
      fontDictBody = inlineFontMatch[1];
    } else {
      const fontRefMatch = /\/Font\s+(\d+)\s+0\s+R/.exec(resourcesDict);
      if (fontRefMatch) {
        const fontObj = getObject(parseInt(fontRefMatch[1], 10));
        if (fontObj) fontDictBody = fontObj.dict;
      }
    }
    const fontMap = new Map<string, FontDecoder>();
    if (fontDictBody) {
      for (const fm of fontDictBody.matchAll(/\/(\S+?)\s+(\d+)\s+0\s+R/g)) {
        fontMap.set(fm[1], await fontDecoderFor(parseInt(fm[2], 10)));
      }
    }

    const contentsMatch = /\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/.exec(page.dict);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => parseInt(m[1], 10))
      : [];
    let raw = '';
    for (const cr of contentRefs) {
      const dec = await decompressedStream(cr);
      if (dec) raw += new TextDecoder('latin1').decode(dec) + '\n';
    }

    let out = '';
    let currentFont: string | null = null;
    let lastY: number | null = null;
    for (const m of raw.matchAll(TOKEN_RE)) {
      if (m[1] !== undefined) { currentFont = m[1]; continue; }
      if (m[5] !== undefined) {
        const y = parseFloat(m[5]);
        if (lastY !== null && Math.abs(y - lastY) > 1) out += '\n';
        lastY = y;
        continue;
      }
      const dec = (currentFont && fontMap.get(currentFont)) || { kind: 'winansi' as const };
      if (m[2] !== undefined) {
        for (const piece of m[2].matchAll(TJ_PIECE_RE)) out += decodeRun(dec, piece[1], piece[2]);
      } else if (m[3] !== undefined) {
        out += decodeRun(dec, undefined, m[3]);
      } else if (m[4] !== undefined) {
        out += decodeRun(dec, m[4], undefined);
      }
    }
    pageTexts.push(out.trim());
  }

  return { text: pageTexts.join('\n\n'), pages: totalPages, extractedPages: pagesToExtract.length, warnings };
}

/**
 * Parse a PDF's outline (bookmark) tree into a flat, document-order list of
 * {title, pageObjNum, depth} entries — WITHOUT decompressing any content
 * stream, so this is orders of magnitude cheaper than `extractPdfText` and
 * safe to run just to decide WHERE to extract from. Built for
 * mcps/new-mexico-code (fleet #2884): NMOneSource publishes each NMSA 1978
 * CHAPTER as one PDF (657-1,138+ pages observed) but bookmarks every
 * ARTICLE heading (depth 0), every SECTION citation (depth 1, e.g.
 * "30-2-1. Murder."), and that section's own "ANNOTATIONS" sub-heading
 * (depth 2) — giving a caller everything needed to resolve a bare citation
 * straight to a page RANGE via `extractPdfText`'s `pageRange` option,
 * without ever extracting pages the caller didn't ask for.
 *
 * Assumes outline objects are DIRECT (never compressed into an /ObjStm) —
 * true of every source sampled while building this. A PDF whose outline IS
 * compressed, or that has no /Outlines at all, returns an empty array
 * rather than guessing; check for that before concluding a citation isn't
 * bookmarked.
 */
function extractPdfOutline(buf: ArrayBuffer): PdfOutlineEntry[] {
  const bytes = new Uint8Array(buf);
  const scan = new TextDecoder('windows-1252').decode(bytes);

  const objStarts: { index: number; num: number }[] = [];
  // See extractPdfText's identical map for why: one O(1) lookup per object
  // instead of one full-document regex scan — an outline tree with ~1,400
  // bookmarks (New Mexico's larger chapters) made this function itself the
  // bottleneck before this fix (measured 2.8s on Chapter 30's 5.8MB PDF).
  const objEndByNum = new Map<number, number>();
  {
    const re = /(\d+)\s+0\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      objStarts.push({ index: m.index, num: parseInt(m[1], 10) });
      const num = parseInt(m[1], 10);
      if (!objEndByNum.has(num)) objEndByNum.set(num, m.index + m[0].length);
    }
  }
  function objNumBefore(markerIndex: number): number | null {
    let lo = 0, hi = objStarts.length - 1, ans: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (objStarts[mid].index <= markerIndex) { ans = objStarts[mid].num; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  const dictCache = new Map<number, string | null>();
  function dictOf(n: number): string | null {
    if (dictCache.has(n)) return dictCache.get(n) ?? null;
    let start: number;
    const fastEnd = objEndByNum.get(n);
    if (fastEnd !== undefined) {
      start = fastEnd;
    } else {
      const re = new RegExp(`(?:^|\\D)${n}\\s+0\\s+obj`);
      const m = re.exec(scan);
      if (!m) { dictCache.set(n, null); return null; }
      start = m.index + m[0].length;
    }
    const end = scan.indexOf('endobj', start);
    const dict = end === -1 ? scan.slice(start, Math.min(scan.length, start + 4000)) : scan.slice(start, end);
    dictCache.set(n, dict);
    return dict;
  }

  // Prefer the Catalog's own /Outlines reference; fall back to the first
  // direct /Type/Outlines object found anywhere (same "search for the type
  // marker as plain text" approach extractPdfText uses for Catalog/Pages).
  let outlinesRoot: number | null = null;
  const catIdx = scan.search(/\/Type\s*\/Catalog\b/);
  if (catIdx !== -1) {
    const catNum = objNumBefore(catIdx);
    const catDict = catNum !== null ? dictOf(catNum) : null;
    const om = catDict ? /\/Outlines\s+(\d+)\s+0\s+R/.exec(catDict) : null;
    if (om) outlinesRoot = parseInt(om[1], 10);
  }
  if (outlinesRoot === null) {
    const outIdx = scan.search(/\/Type\s*\/Outlines\b/);
    if (outIdx !== -1) outlinesRoot = objNumBefore(outIdx);
  }
  if (outlinesRoot === null) return [];

  function pageObjOf(dict: string): number | null {
    const destMatch = /\/Dest\s*\[\s*(\d+)\s+0\s+R/.exec(dict);
    if (destMatch) return parseInt(destMatch[1], 10);
    const actionMatch = /\/A\s*<<[^>]*\/D\s*\[\s*(\d+)\s+0\s+R/.exec(dict);
    if (actionMatch) return parseInt(actionMatch[1], 10);
    return null;
  }

  const entries: PdfOutlineEntry[] = [];
  const seen = new Set<number>();
  function walk(n: number, depth: number): void {
    if (depth > 20 || seen.has(n)) return; // guards a malformed/cyclic tree
    seen.add(n);
    const dict = dictOf(n);
    if (!dict) return;
    const titleMatch = /\/Title\s*\(((?:\\.|[^()])*)\)/.exec(dict);
    if (titleMatch) {
      entries.push({ title: unescapePdfLiteral(titleMatch[1]).replace(/\s+/g, ' ').trim(), pageObjNum: pageObjOf(dict), depth });
    }
    const firstMatch = /\/First\s+(\d+)\s+0\s+R/.exec(dict);
    if (firstMatch) walk(parseInt(firstMatch[1], 10), titleMatch ? depth + 1 : depth);
    const nextMatch = /\/Next\s+(\d+)\s+0\s+R/.exec(dict);
    if (nextMatch) walk(parseInt(nextMatch[1], 10), depth);
  }
  const rootDict = dictOf(outlinesRoot);
  const rootFirst = rootDict ? /\/First\s+(\d+)\s+0\s+R/.exec(rootDict) : null;
  if (rootFirst) walk(parseInt(rootFirst[1], 10), 0);

  return entries;
}
/**
 * California Office of Tax Appeals (OTA) opinions — search by statute
 * section/topic across issued opinions, retrieve one opinion by its OTA
 * citation with full text and cited provisions. Fleet #2825, the first of
 * a planned pattern for other state tax tribunals.
 *
 * SOURCE AND SHAPE. ota.ca.gov (WordPress/WP Engine, TablePress tables) has
 * NO JSON search backend — every opinion-listing page renders its whole
 * table as static HTML, paginated client-side only (confirmed live: every
 * `DataTable('#tablepress-NNN', {...})` init call on these pages carries no
 * `ajax`/`serverSide` option, and the full row set is present in the raw
 * HTTP response). So this pack bakes a citation-indexed table from OTA's
 * own published listing pages — every "20XX [Business Tax] Opinions" page
 * (one per year per tax category, precedential AND nonprecedential
 * opinions) plus the two "All Precedential [Business Tax] Opinions" pages
 * (all years, precedential only, covering any year a per-year page might
 * have missed) — 4,254 opinions as of the 2026-10-08 bake, deduped by
 * citation. See scripts/bake-index.mjs for exactly how and its own header
 * for the licensing/public-data footing (OTA's own published opinions, no
 * reuse grant needed to proxy/index them — same footing as texas-ag-opinions).
 *
 * Per fleet #2754 (root CLAUDE.md rule 3), a baked table this size (4,254
 * rows, ~1.6MB as generated TS) never sits in gateway module scope — it is
 * uploaded to KV (workers/gateway/src/pack-baked-indexes.json) and injected
 * here as `args._bakedIndex`, same pattern as ca-medical-exclusions /
 * south-dakota-code / delaware-code.
 *
 * CASE NUMBER = OTA's own citation (e.g. "2020-OTA-263P", the trailing "P"
 * marking Precedential). That is what OTA itself cites opinions by and what
 * appears on the opinion's own cover page — NOT the PDF's internal 8-digit
 * "OTA Case No." docket number, which is never listed on any listing page
 * (it only appears inside the PDF body) and so is not indexed here.
 * ca_ota_opinion_lookup's response surfaces the docket number too, read
 * live from the fetched PDF text, for anyone who needs it.
 *
 * TWO TOOLS:
 *   - ca_ota_search(query)   -> opinions whose title or "Issues" summary
 *     (OTA's own one-line topic/statute tag, e.g. "Residency (R&TC 17014;
 *     Reg. 17014)") match a keyword or statute citation. This searches the
 *     baked LISTING metadata only — title + OTA's own issue tag, never the
 *     full opinion text (OTA publishes no full-text search at all; see
 *     above). A statute cited only in an opinion's BODY and not in its
 *     Issues tag will not be found this way.
 *   - ca_ota_opinion_lookup(cite) -> fetches the opinion PDF live, extracts
 *     its full text (shared/src/pdf-text.ts), the exact "Date Issued", and
 *     statute citations found in the text (best-effort regex over R&TC /
 *     Cal. Code Regs. / IRC citation shapes).
 *
 * Keyless, no signup — this is a read of OTA's own published, public
 * opinions, not a third-party API.
 */

import type { OtaOpinionRow, OtaCategory } from './ca-ota-index-data.js';

const UA = 'pipeworx-mcp-california-tax-appeals/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'California Office of Tax Appeals opinions (ota.ca.gov)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, UPSTREAM);
}

// fleet #2754 / root CLAUDE.md rule 3 — the baked table (4,254 rows,
// ~1.6MB) is injected by the gateway as `args._bakedIndex`, loaded from KV
// once per isolate. NEVER value-import ./ca-ota-index-data.js here — only
// the type-only import above, which is erased at compile time. A value
// import puts the whole table back in the bundle and into every isolate's
// heap; scripts/check-gateway-bundle-size.mjs fails the deploy if that
// happens.
let ROWS: OtaOpinionRow[] = [];
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;
let BY_CITE: Map<string, OtaOpinionRow> | null = null;

function citeKey(cite: string): string {
  return cite.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.OTA_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose (silent-zero policy): answering "no opinions found"
    // from an empty table would be a silent wrong answer, indistinguishable
    // from a real clean search result.
    throw new Error(
      `california-tax-appeals: the baked OTA opinion index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query — retry shortly.',
    );
  }
  ROWS = rows as OtaOpinionRow[];
  CAPTURED_AT = String(idx?.OTA_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.OTA_TOTAL_ROWS ?? ROWS.length);
  BY_CITE = new Map();
  for (const r of ROWS) BY_CITE.set(citeKey(r.cite), r);
}

const CATEGORY_LABEL: Record<OtaCategory, string> = {
  fit: 'Franchise and Income Tax (FTB-administered)',
  bt: 'Business Tax (CDTFA-administered: sales/use, excise, and related taxes)',
};

function isPrecedential(decisionType: string | null): boolean {
  return decisionType != null && decisionType.toLowerCase().startsWith('precedential');
}

/** Best-effort statute-citation extraction over opinion text or an OTA
 *  "Issues" tag. Matches California Revenue and Taxation Code ("R&TC"),
 *  California Code of Regulations ("Reg." / "Regulation"), and Internal
 *  Revenue Code ("IRC") citation shapes actually seen in OTA opinions
 *  (verified against the Mazer opinion, 2020-OTA-263P: "R&TC section
 *  19045", "R&TC 17014", 12+ distinct citations across a sample of
 *  opinions, zero false positives on the shapes tested). This is a regex
 *  over plain text, not a citation parser — citations to other states'
 *  codes, case law, or non-standard abbreviations are not captured. */
function extractCitations(text: string): string[] {
  const re = /\b(?:R&TC|Rev(?:enue)?\s*&?\s*Tax(?:ation)?\s*Code)\s+(?:section|§)?s?\.?\s*[0-9][0-9A-Za-z.\-()]*|\bReg(?:ulation)?s?\.?\s*(?:section|§)?\s*[0-9][0-9A-Za-z.\-()]*|\bIRC\s+(?:section|§)?s?\.?\s*[0-9][0-9A-Za-z.\-()]*/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let cite = m[0].replace(/\s+/g, ' ').trim().replace(/[,.;]$/, '');
    // Strip trailing ")" characters that have no matching "(" within the
    // citation itself — common when a citation sits right before a
    // sentence's own closing paren in OTA's "Issues" one-liners (e.g.
    // "Residency (R&TC 17014)"), which the greedy character class above
    // swallows along with the digits. A real statute paren like
    // "17951-4(d)" stays, since it IS balanced.
    while (cite.endsWith(')') && (cite.match(/\(/g)?.length ?? 0) < (cite.match(/\)/g)?.length ?? 0)) {
      cite = cite.slice(0, -1);
    }
    if (cite) seen.add(cite);
  }
  return [...seen];
}

function shapeSearchRow(r: OtaOpinionRow) {
  return {
    cite: r.cite,
    title: r.title,
    date: r.month && r.year ? `${r.month} ${r.year}` : (r.year ? String(r.year) : null),
    year: r.year,
    tax_category: r.category,
    tax_category_label: CATEGORY_LABEL[r.category],
    decision_type: r.decision_type,
    precedential: isPrecedential(r.decision_type),
    issues: r.issues,
    cited_provisions_in_issue_tag: r.issues ? extractCitations(r.issues) : [],
    pdf_url: r.pdf_url,
    source_url: r.source_url,
  };
}

async function caOtaSearch(args: Record<string, unknown>) {
  ensureIndex(args);
  const raw = String(args.query ?? '').trim();
  if (!raw) {
    return {
      found: false,
      reason: 'empty_query',
      message: 'ca_ota_search needs a statute citation or topic keyword, e.g. "residency", "innocent spouse", or "17014".',
    };
  }
  const categoryFilter = args.category === 'fit' || args.category === 'bt' ? (args.category as OtaCategory) : null;
  const precedentialOnly = args.precedential_only === true;
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);

  const needle = raw.toLowerCase();
  const digits = (raw.match(/\d[\d.]*\d|\d/g) ?? []).join('|');
  const digitRe = digits ? new RegExp(digits.replace(/\./g, '\\.')) : null;

  const matches = ROWS.filter((r) => {
    if (categoryFilter && r.category !== categoryFilter) return false;
    if (precedentialOnly && !isPrecedential(r.decision_type)) return false;
    const hay = `${r.title} ${r.issues ?? ''}`.toLowerCase();
    if (hay.includes(needle)) return true;
    if (digitRe && digitRe.test(hay)) return true;
    return false;
  });

  // Most recent first — a topic/statute search is almost always for the
  // current state of the law, and OTA's own precedential opinions
  // supersede earlier ones on the same issue.
  matches.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.cite > a.cite ? 1 : -1));

  const page = matches.slice(0, limit);
  return {
    found: page.length > 0,
    query: raw,
    count: matches.length,
    returned: page.length,
    opinions: page.map(shapeSearchRow),
    coverage_note:
      'Searches OTA\'s own published listing metadata only (opinion title + OTA\'s one-line "Issues" topic/statute tag) — OTA ' +
      'publishes no full-text search of opinion bodies. A statute cited only inside an opinion\'s full text, and not in its ' +
      'Issues tag, will not be found by this search; use ca_ota_opinion_lookup on a specific citation for that opinion\'s full text.',
    index_captured_at: CAPTURED_AT,
    index_total_opinions: TOTAL_ROWS,
    source_url: 'https://ota.ca.gov/opinions/',
  };
}

interface PdfMeta {
  dateIssued: string | null;
  otaCaseNo: string | null;
  fullText: string;
  citations: string[];
  warnings: string[];
}

function parseOpinionPdfText(text: string): PdfMeta {
  const dateM = /Date Issued:\s*([\d/]+)/i.exec(text);
  const caseM = /OTA Case No\.?\s*([\w-]+)/i.exec(text);
  return {
    dateIssued: dateM ? dateM[1]!.trim() : null,
    otaCaseNo: caseM ? caseM[1]!.trim() : null,
    fullText: text,
    citations: extractCitations(text),
    warnings: [],
  };
}

async function caOtaOpinionLookup(args: Record<string, unknown>) {
  ensureIndex(args);
  const raw = String(args.cite ?? args.case_number ?? '').trim();
  if (!raw) {
    return {
      found: false,
      reason: 'empty_cite',
      message: 'ca_ota_opinion_lookup needs an OTA opinion citation, e.g. "2020-OTA-263P" or "2020-OTA-375".',
    };
  }
  const key = citeKey(raw);
  // Users commonly omit/guess the trailing "P" (Precedential marker) — try
  // the exact key first, then with/without a trailing P, before giving up.
  const candidates = [key, key.endsWith('P') ? key.slice(0, -1) : `${key}P`];
  let row: OtaOpinionRow | undefined;
  for (const c of candidates) {
    row = BY_CITE!.get(c);
    if (row) break;
  }
  if (!row) {
    return {
      found: false,
      reason: 'not_in_index',
      message: `"${raw}" does not match any opinion citation in the baked index (${TOTAL_ROWS} opinions, captured ${CAPTURED_AT}). ` +
        'Expected a citation like "2020-OTA-263P" (precedential) or "2020-OTA-374" (nonprecedential). The index may also simply not ' +
        'yet cover a very recently issued opinion — check https://ota.ca.gov/opinions/ directly for anything newer than the capture date.',
      index_captured_at: CAPTURED_AT,
    };
  }
  if (!row.pdf_url) {
    return {
      found: true,
      cite: row.cite,
      title: row.title,
      date: row.month && row.year ? `${row.month} ${row.year}` : null,
      tax_category: row.category,
      decision_type: row.decision_type,
      precedential: isPrecedential(row.decision_type),
      issues: row.issues,
      full_text: null,
      warnings: ['No opinion PDF link found on OTA\'s listing page for this citation — full text and cited provisions are unavailable.'],
      source_url: row.source_url,
    };
  }

  const res = await pwFetch(row.pdf_url);
  if (res.status === 404) {
    throw new Error(
      `upstream_down: ${UPSTREAM} returned HTTP 404 for the PDF at ${row.pdf_url} (indexed from ${row.source_url}) — OTA appears to ` +
        'have moved or removed this file since the index was captured, not a bad query.',
    );
  }
  if (!res.ok) throw await httpError(res, UPSTREAM);

  let pdf: PdfMeta | null = null;
  const warnings: string[] = [];
  try {
    const extracted = await extractPdfText(await res.arrayBuffer());
    if (extracted.text.trim()) {
      pdf = parseOpinionPdfText(extracted.text);
      pdf.warnings = extracted.warnings;
    } else {
      warnings.push(`PDF at ${row.pdf_url} extracted to empty text (pages found: ${extracted.pages}); full opinion text and cited provisions are unavailable for this call.`);
    }
  } catch (err) {
    // A FRAGMENT joined into the opinion's response, not a thrown error of
    // its own — dropClassPrefix per check:class-prefix, since a nested
    // upstream_down:/etc. token here can never reach position 0 and would
    // only leak.
    const rawMsg = err instanceof Error ? err.message : String(err);
    warnings.push(`PDF fetch/extraction for ${row.pdf_url} failed: ${dropClassPrefix(rawMsg)}`);
  }

  return {
    found: true,
    cite: row.cite,
    ota_case_no: pdf?.otaCaseNo ?? null,
    title: row.title,
    date: pdf?.dateIssued ?? (row.month && row.year ? `${row.month} ${row.year}` : null),
    tax_category: row.category,
    tax_category_label: CATEGORY_LABEL[row.category],
    decision_type: row.decision_type,
    precedential: isPrecedential(row.decision_type),
    issues: row.issues,
    cited_provisions: pdf?.citations ?? [],
    full_text: pdf?.fullText ?? null,
    pdf_url: row.pdf_url,
    source_url: row.source_url,
    index_captured_at: CAPTURED_AT,
    warnings: (pdf?.warnings ?? []).concat(warnings).length ? (pdf?.warnings ?? []).concat(warnings) : undefined,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ca_ota_search',
    description:
      'Find California Office of Tax Appeals (OTA) opinions by statute citation or topic keyword (e.g. "residency", "innocent spouse", "17014", "17951-4") -- returns citation, title, date, tax category (Franchise/Income vs Business Tax), precedential status, and OTA\'s own one-line issue/statute tag, most recent first. PARTIAL: this searches opinion titles and OTA\'s published "Issues" tag only, not full opinion text (OTA publishes no full-text search). For full text and all cited provisions of a specific opinion, use ca_ota_opinion_lookup. Sourced from ota.ca.gov\'s own opinion listing pages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'A topic keyword (e.g. "residency", "penalties", "innocent spouse") or a statute citation/number (e.g. "17014" or "R&TC 19045").',
        },
        category: {
          type: 'string',
          enum: ['fit', 'bt'],
          description: 'Optional filter: "fit" (Franchise and Income Tax, FTB-administered) or "bt" (Business Tax, CDTFA-administered: sales/use, excise, etc).',
        },
        precedential_only: {
          type: 'boolean',
          description: 'If true, only return opinions OTA has designated Precedential (binding on future OTA panels). Default false (returns both).',
        },
        limit: {
          type: 'number',
          description: 'Max opinions to return, default 25, max 100.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ca_ota_opinion_lookup',
    description:
      'Look up a California Office of Tax Appeals opinion by its OTA citation (e.g. "2020-OTA-263P" for a Precedential opinion, "2020-OTA-374" for a Nonprecedential one) -- fetches the opinion PDF live and returns the full text, exact date issued, OTA\'s internal case number, tax category, precedential status, OTA\'s issue tag, and statute citations found in the text (best-effort, R&TC/Cal. Code Regs./IRC shapes). Sourced from ota.ca.gov.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cite: {
          type: 'string',
          description: 'OTA opinion citation, e.g. "2020-OTA-263P", "2022-OTA-375P", "2020-OTA-374". Case- and spacing-insensitive; the trailing "P" (precedential marker) may be omitted.',
        },
      },
      required: ['cite'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ca_ota_search':
      return caOtaSearch(args);
    case 'ca_ota_opinion_lookup':
      return caOtaOpinionLookup(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
