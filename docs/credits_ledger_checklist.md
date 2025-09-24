# Credits Ledger Feature Acceptance Checklist

## Core Ledger Behavior
- [ ] Text-to-Image job success creates exactly one debit ledger entry (type=image, source=text2image) with correct amount and model/resolution metadata.
- [ ] Image-to-Image job success creates exactly one debit ledger entry (type=image, source=image2image) with correct amount and metadata.
- [ ] Each job debit is idempotent via `debit:<source>:<jobId>` idempotencyKey; replays do not duplicate entries.
- [ ] Purchase success creates exactly one credit ledger entry with source=purchase, contains paymentId & invoiceId.
- [ ] Purchase credit is idempotent via `credit:purchase:<paymentId>`.
- [ ] Admin adjustment API can create credit or debit with source=admin_adjustment and createdBy=admin:<uid>.
- [ ] Refund / failed job path writes a credit (source=refund) when a previously reserved debit must be undone (if reservation system exists).
- [ ] Negative balance debits are rejected atomically with clear error; no ledger entry written and no balance change.
- [ ] Ledger entries are immutable after creation.
- [ ] Balances (`users/{uid}/balances`) reflect cumulative ledger math and stay consistent.

## Data Model
- [ ] `credits_ledger` collection contains required fields: uid, type, direction, amount, balance_after, source, reason, jobId, paymentId, invoiceId, meta, createdAt, createdBy, idempotencyKey.
- [ ] `users/{uid}/balances` doc holds integer `image`, `video`, updatedAt.
- [ ] Optional `daily_credits_summary/{YYYY-MM-DD}` docs have totals and bySource aggregates.

## Indexes
- [ ] Composite index (uid, type, createdAt desc) created.
- [ ] Single-field index createdAt descending supported queries (if not automatic).
- [ ] Additional indexes for jobId, paymentId, source queries as needed (or alternately store mapping docs).

## Server APIs
- [ ] `writeLedgerEntry` transactional utility ensures: idempotency check, balance read/update, ledger insert.
- [ ] `/api/credits/ledger` (auth user) supports filters: type, direction, source, date range, pagination; returns entries + current balances.
- [ ] `/api/credits/export.csv` exports filtered subset for user.
- [ ] `/api/admin/credits/ledger` supports global search by uid/email/jobId/paymentId plus filters.
- [ ] `/api/admin/credits/export.csv` exports admin-filtered dataset.
- [ ] `/api/admin/credits/adjust` validates admin auth + body, writes ledger entry.
- [ ] Purchase webhook / confirmation path invokes `writeLedgerEntry` for credits.
- [ ] Job success code paths invoke debit logic with correct price calculation.
- [ ] Daily summary cron aggregates previous day into `daily_credits_summary`.

## Security Rules
- [ ] Users can read only their own ledger entries & balances; cannot write.
- [ ] Admins can read all ledger entries and balances.
- [ ] Invoices readable only by owner or admin; writes are server-only.
- [ ] No client path can forge ledger entries.

## Frontend User UI (My Bills & Invoices → Credits Usage)
- [ ] Tab displays image & video current balances with Top Up CTA.
- [ ] Filter controls (direction, type, source, date range) update list.
- [ ] Infinite scroll / pagination loads next page efficiently.
- [ ] Table columns: Date/Time (local with UTC tooltip), Type, Direction icon, Amount, Balance After, Source, Details (reason + meta), Link to Job/Invoice where applicable.
- [ ] Export CSV triggers server export honoring current filters.
- [ ] Empty state + skeleton loaders present.

## Frontend Admin UI (Reports & Analytics → Credits)
- [ ] Tabs: Ledger, Users Overview, Daily Summaries, Anomalies.
- [ ] Ledger tab global search (uid/email/jobId/paymentId) + same filters + export.
- [ ] Users Overview shows low-balance users & Grant Credits action.
- [ ] Daily Summaries tab shows charts for debit vs credit & by source.
- [ ] Anomalies lists blocked negative debit attempts & duplicate webhook attempts (idempotent skips with metadata).

## Reliability & Idempotency
- [ ] Duplicate job completion or webhook events do not create extra entries.
- [ ] Idempotency keys stored & enforced; repeated call returns existing entry reference.
- [ ] Concurrency-safe under simultaneous debits/credits for same user.

## Tests
- [ ] Unit: writeLedgerEntry success credit & debit.
- [ ] Unit: negative debit rejected.
- [ ] Unit: idempotent duplicate returns existing / no second write.
- [ ] Integration: job success creates debit & updates balance.
- [ ] Integration: purchase webhook creates credit & links invoice.
- [ ] (Optional) Integration: daily summary script aggregates correctly.

## Documentation
- [ ] README / docs updated with API contracts, data model, pricing integration.
- [ ] Example CSV export format documented.
- [ ] Guidance for adding new sources / credit types.

## Performance
- [ ] Ledger queries paginated (limit + startAfter) and indexed.
- [ ] Export uses stream or batched pagination to avoid memory blow-up.

## Observability
- [ ] Server logs idempotency skip events with key & context.
- [ ] Errors for negative balance include attempted amount & current balance.
- [ ] (Optional) Metrics counters for debits/credits by source.

