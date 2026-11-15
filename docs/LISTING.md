# Marketplace listing copy — Duplicate Merge Queue (DRAFT)

- Name: Duplicate Merge Queue
- Short description (no trailing punctuation): "Fuzzy duplicate detection for HubSpot contacts and companies, with a human approving every merge"
- Support URL: (the product repository / site — set at listing time)
- Privacy policy URL: (hosted PRIVACY.md — set at listing time)
- Terms URL: (hosted TERMS.md — set at listing time)
- Contact email (all leads): coacha810@gmail.com
- Pricing: $29/mo flat per portal. Free tier: "Free scan" — connect a
  portal, run a scan, see the duplicate count before any card is asked
  for; the count is the sales pitch.
  Bullets:
  - Fuzzy matching that catches what exact-email dedupe misses — name variants, typo'd emails, shared phones
  - Every merge is human-approved in a review queue — nothing auto-merges, ever
  - Pre-merge snapshots of both records, kept as your audit and recovery trail
  - Flat $29/mo per portal — no per-record or per-seat pricing

## Intro description

HubSpot dedupes on exact email only. Every other duplicate — the Jon
who is also John, the typo'd email, the same person entered twice at a
trade show — piles up silently, and the built-in cleanup is paywalled.
Duplicate Merge Queue scans your contacts and companies with fuzzy
matching, explains exactly why each pair looks like a duplicate, and
queues it for a human decision. Nothing merges itself.

## Detailed description

Detection is explainable by design: each proposed pair shows a score
built from named signals — email similarity (including typo detection
and gmail dot/plus variants), name variants and phonetic matching,
phone normalization, and company domain matching — so the reviewer
sees the evidence, not just a number. Pairs score in two bands:
proposed merges, and a caution band for pairs a human should look at
twice (a shared office phone alone never proposes a merge).

Approving a merge snapshots both records first, then executes it
through HubSpot's merge API, and both the snapshot and the result are
written to an audit log. Dismiss pairs with a reason and they stay
dismissed; snooze pairs that need more information. Re-scans run
incrementally, so new duplicates surface as your portal grows.

Contacts and companies only — no deals, no association surgery, no
automation acting behind your back. Flat pricing per portal, and a
free scan tier that shows your duplicate count before you pay
anything.
