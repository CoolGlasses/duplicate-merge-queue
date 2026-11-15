# Duplicate Merge Queue

Fuzzy duplicate detection for HubSpot contacts and companies, with a
human approving every merge.

HubSpot dedupes contacts on exact email only. Duplicates with variant
names ("Jon" vs "John") or typo'd emails pile up, and the built-in fix
is paywalled. This hosted service connects to a portal via OAuth, scans
contacts and companies for fuzzy duplicates, and puts every proposed
merge into a human review queue. **Nothing auto-merges, ever.** On
approval, both records are snapshotted first (the audit/undo record),
and only then is HubSpot's merge API called.

Zero dependencies, Node ≥ 18. `npm test` runs the full suite offline.

## Behaviour specification

### Matching engine (`src/matching.js`, `src/normalize.js`)
Pure, deterministic, explainable. Every proposal carries per-signal
reasons with point values; the score is the sum of its reasons, capped
at 100.

Signals include:
- email: exact match; same mailbox after gmail dot/plus-tag folding
  (a *signal*, not a rule); same-domain local parts within edit
  distance ≤ 2 (typo detection); same local part across domains
- name: exact match; nickname/variant table (Jon→John, Bobby→Robert,
  ~70 entries); Soundex phonetic match (implemented in-repo)
- phone: digit normalization with country-code stripping; exact and
  last-10-digit matches
- companies: domain equality (dominant signal), name equality ignoring
  legal suffixes, phonetic name similarity
- contact↔company association name

Thresholds: **≥ 85** propose merge · **60–84** propose with a caution
flag · **< 60** ignored. A shared phone alone never proposes a merge
(30 points — office lines are shared by different people).

### Review queue (`src/server.js`)
Server-rendered, no framework. Operator logs in with a password
(scrypt-hashed in env, signed session cookie). Proposals are grouped
by band; each shows a side-by-side field comparison with differing
fields highlighted and the score's reasons listed. Per pair:
- **Approve merge** — choose the surviving record, or take the default
  (most complete, then most recently updated, then lowest id). A
  pre-merge snapshot of BOTH records is saved to the store *before*
  the merge API call; the snapshot and the merge result both land in
  the audit log. HubSpot cannot un-merge: the snapshot is the recovery
  record (manual recreation), and the UI copy says so.
- **Dismiss** — with a reason, recorded in the audit log. Dismissed
  pairs are not re-proposed.
- **Snooze** — parks the pair out of the pending list.

### Plan gating (`src/stripe.js`)
- **Free tier:** scans run; the portal sees the duplicate **count**
  only. No pair details, no merges.
- **Paid ($29/mo per portal):** the full review queue and merges.
- Billing is vendor-side Stripe. If `STRIPE_*` env is absent, billing
  endpoints answer "billing not configured" and the app runs in free
  mode (the health endpoint reports `billingConfigured: false`).

### Scanning (`src/scan.js`, `src/sweep.js`)
Full scan on first connect. The sweep (`node src/sweep.js`, run from
cron) does incremental re-scans: records are re-listed and proposals
are generated only for pairs involving a record changed since the last
scan. Dismissed/snoozed/merged pairs keep their state.

### Tokens (`src/tokens.js`)
OAuth tokens are stored encrypted at rest (AES-256-GCM,
`TOKEN_ENC_KEY` = 32-byte key as hex/base64). Without a valid key the
app stores plaintext **and logs a loud warning at startup** — dev only.

## HubSpot scopes required
- `crm.objects.contacts.read`, `crm.objects.contacts.write`
- `crm.objects.companies.read`, `crm.objects.companies.write`
- `oauth`

Scope line (held): **contacts + companies only.** No deals, no
association surgery.

## Configuration
See `.env.example`. Generate the operator password hash with
`npm run hash-password -- '<password>'`.

## Deploy notes
- Single Node process (`npm start`) + a cron entry for `src/sweep.js`
  (e.g. every 6 hours). State is one JSON file under `data/` with
  lockfile transactions — back up that file and you have everything,
  including snapshots and the audit log.
- Intended host: co-located on the existing ScoutCreate droplet
  alongside the wave-1 apps (no new spend). Set `PUBLIC_BASE_URL`
  when behind a proxy so Stripe redirect URLs are correct.
- The service must be reachable at a public HTTPS URL for the HubSpot
  OAuth redirect and the Stripe webhook.

## TODO gates before launch (NOT done in this build)
1. HubSpot developer account + OAuth app registration (client id/secret).
2. A domain we control, verified with HubSpot for the Marketplace
   listing (plus the listing itself — draft copy in `docs/LISTING.md`).
3. Stripe keys + the $29/mo price id delivered via env
   (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PORTAL`)
   and the webhook endpoint registered in Stripe.
4. `TOKEN_ENC_KEY` generated and set; `OPERATOR_PASSWORD_HASH` set.
5. Live-verification pass on every API assumption listed below.

## API assumptions to verify live (flagged, not yet proven)
- OAuth token endpoint + response field names
  (`access_token`/`refresh_token`/`expires_in`) per HubSpot docs.
- Portal id comes from `GET /oauth/v1/access-tokens/{token}` → `hub_id`.
- CRM list pagination shape: `results[]` + `paging.next.after`.
- Merge endpoint: `POST /crm/v3/objects/{objectType}/merge` with
  `{primaryObjectId, objectIdToMerge}`; response carries the surviving
  record. In HubSpot a merge makes the secondary record cease to exist
  independently — hence snapshots first.
- Contact/company property names used for reads
  (`firstname`, `lastname`, `email`, `phone`, `mobilephone`, `company`,
  `name`, `domain`, …) and top-level `createdAt`/`updatedAt` on list
  results.
- Stripe Checkout Sessions API form encoding, webhook signing scheme
  (`t`/`v1`, HMAC-SHA256 over `"<t>.<payload>"`), and the event fields
  used for plan mapping (`client_reference_id`, `metadata.portalId`,
  subscription `status`).
