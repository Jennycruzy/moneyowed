# MONEY OWED

**Your vendors promise uptime in writing. When they miss it, they owe you money, but only if you ask in time. MONEY OWED finds those credits, proves them incident by incident, and drafts the claim.**

Live: **https://moneyowed.38-49-216-59.sslip.io** · Telegram: **@moneyowed_claims_bot** · Telegraph miner: **2611217** (`moneyowed-sla`)

In the 12 months to October 2026, 13 of the 17 vendors covered here broke their written uptime promise at least once, for a total of **52 vendor-periods where customers were owed a credit**. A few examples:

| Vendor, plan | Period | Uptime on covered services | Promise | Credit owed |
|---|---|---|---|---|
| GitHub Enterprise Cloud | 2026-Q3 | 99.376% (827 min down) | 99.9% | 10% of the quarter |
| Jira Premium | 2026-06 | 98.97% (445 min down) | 99.9% | 25% of the month |
| Sanity Enterprise | 2026-10 | 99.24% | 99.9% | 10% of the month |

The vendor pays only if the customer files a claim inside a short window (15 to 60 days), in the vendor's format, with the incidents listed. Almost nobody does.

## Try it in two minutes

1. Open the site and run a check, for example **GitHub, 2026-Q3, bill $6,000**. You get the verdict, the dollar amount, the claim deadline, every incident in the period (counted or not, with the reason), the contract sentence with its numbers, and a drafted claim.
2. On the same page, the **Telegraph** table shows the SLA answers the check bought from Telegraph miners: cost, time, answer hash, and whether each one agrees with the contract-scoped count.
3. Click **Proof file**, then recompute it on your own machine with no network:
   ```
   git clone https://github.com/Jennycruzy/moneyowed && cd moneyowed && npm install
   node bin/moneyowed.js verify moneyowed-proof-<id>.json
   ```
   It re-reads the vendor's own incident records inside the proof, checks each one against its archived sha256, re-runs the decision, and prints `VERIFIED` only if the verdict, uptime, minutes, credit and deadline all match.
4. Install the browser extension ([download](https://moneyowed.38-49-216-59.sslip.io/extension.zip), unzip, load unpacked in `chrome://extensions`), open the [sample invoice](https://moneyowed.38-49-216-59.sslip.io/sample-invoice) or a real vendor invoice in Gmail, and click the icon: "This invoice is $2,000. You are owed $200 (10%) for 2026-10. Claim before paying."

## How it decides

- **Incident history.** Each vendor's own public status history (Statuspage incidents with per-component status changes, the AWS Health history, the Google Cloud incident feed, Azure post-incident reviews), refreshed hourly. Every file is archived exactly as fetched, with its sha256.
- **Rule cards.** One card per vendor plan, written from the vendor's SLA text: which services are covered, the uptime promise, the credit tiers, the cap, the claim deadline and channel. Every number on a card sits next to a word-for-word quote, and a checker confirms each threshold, tier boundary, credit and deadline appears in its quote. The SLA pages are re-read nightly. If a quoted sentence disappears, checks for that vendor stop with `TERMS_CHANGED` rather than give an old answer.
- **Counting.** Only time the vendor itself marked a covered service as down counts: Statuspage `partial_outage` or `major_outage` on a covered component, AWS "service disruption", Google `SERVICE_OUTAGE`, an Azure review stating the service was unavailable. Degraded performance and scheduled maintenance do not count, which is what the contracts say.
- **Decision.** Plain code: covered minutes, uptime, credit tier, cap, deadline. No language model sets a number.

**Tested against hand-checked truth.** For each vendor-period in a sample drawn by a fixed seed, every incident was read by hand against the card before the engine ran. The first run scored 93.7%. The miss was one cause: degraded time counted as down. The fix and a fresh sample were logged in advance, and the second run matched 57 of 57 service-periods on verdict, credit tier and minutes.

## Telegraph

MONEY OWED uses Telegraph in two directions.

- **As a buyer.** Each check buys `SLA_COMPLIANCE_GENERAL` answers through the escrow payment path: one from Telegraph's own routing plus direct picks from ranked SLA miners, at $0.01 each. Every purchase is stored with miner, route, cost, latency and answer hash, and shown beside the contract-scoped result, with disagreements explained. Spending limits per user and per day, and a fresh answer to the same question is reused for an hour instead of being bought twice. All purchases: [/purchases.json](https://moneyowed.38-49-216-59.sslip.io/purchases.json).
- **As a miner.** The same engine answers `SLA_COMPLIANCE_GENERAL` for any Telegraph buyer as miner **2611217**: 17 vendors, any past window ("last 30 days", "2026-10", "2026-Q3", date ranges), plus the credit and claim deadline when a whole billing period is asked, and every incident with whether it counted and why. Miner file: [miner.yaml](https://moneyowed.38-49-216-59.sslip.io/miner.yaml) (its sha256 is stored on chain). Try it directly: [/miner/sla?service=GitHub&period=2026-Q3](https://moneyowed.38-49-216-59.sslip.io/miner/sla?service=GitHub&period=2026-Q3). The app labels this miner as ours wherever it shows its answer.

## Where it runs

| Surface | What it does |
|---|---|
| Web | Checks, claim drafts with Sent / Credited / Refused tracking, the 12-month breach record ([/record](https://moneyowed.38-49-216-59.sslip.io/record), also CSV and JSON), method and evidence ([/evidence](https://moneyowed.38-49-216-59.sslip.io/evidence)) |
| Browser extension | Before-you-pay banner on vendor invoice emails in Gmail. Reads the open email only when you click the icon. |
| Telegram | `/check github 2026-Q3 6000`, `/owed` (open claim windows now), `/watch jira` (a message when a watched vendor misses its SLA in a way that owes a credit) |
| MCP server | `node bin/moneyowed-mcp.js`: tools `check_credit`, `list_incidents`, `get_rule_card`, `draft_claim`, `sla_compliance`, `list_vendors` |
| CLI | `node bin/moneyowed.js check jira 2026-06 --spend 1000`, `verify <proof.json>`, `vendors` |
| API | `POST /api/check`, `GET /check/<id>.json`, `GET /check/<id>/proof.json`, `GET /api/cards/<vendor>`, `GET /miner/sla` |

## Vendors

GitHub Enterprise Cloud, Jira, Confluence, Jira Service Management, Bitbucket, Vercel, DigitalOcean, Twilio, Linode (Akamai), Mailgun, Sanity, Prisma, Mapbox, Buildkite, AWS, Google Cloud and Microsoft Azure (per service and region). Vendors left out, and why (no credit SLA, or no incident history a program can read), are listed on [/evidence](https://moneyowed.38-49-216-59.sslip.io/evidence#not-covered).

## Run it yourself

Node 22 or newer.

```
npm install
npm test                       # unit and replay tests
npm run collect                # 13 months of vendor history into data/ (archived with hashes)
node scripts/sla-sync.js --check   # fetch the SLA pages the cards quote and check them against the cards
npm start                      # http://127.0.0.1:8787
```

Optional `.env`: `TELEGRAPH_PRIVATE_KEY` (a Sepolia test wallet with escrow deposited, for buying answers), `TELEGRAM_BOT_TOKEN` (for `npm run bot`), `OWN_SLA_MINER_ID`.

MONEY OWED drafts claims and never sends them. Telegraph payments run on testnet. MIT licence.
