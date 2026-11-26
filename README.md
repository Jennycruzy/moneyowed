# MONEY OWED

**Your software vendors promise uptime in writing. When they miss it, they owe you a credit, but only if you ask in time. MONEY OWED finds those credits, proves each one incident by incident, and drafts the claim. It buys and sells the answers it needs on [Telegraph](https://telegraphprotocol.com).**

- App: **https://moneyowed.vercel.app**
- Telegram: **[@moneyowed_claims_bot](https://t.me/moneyowed_claims_bot)**
- Telegraph miner: **2611217** (`moneyowed-sla`): registration, accuracy evidence and evaluation material in **[moneyowed-sla](https://github.com/Jennycruzy/moneyowed-sla)**
- Network: Telegraph testnet (Ethereum Sepolia, test USDC)

---

## For judges: run and verify it in 3 minutes

No account, key or wallet needed.

**1. See a real credit (30 s).** Open **[Jira Premium, June 2026, on a $1,000 bill](https://moneyowed.vercel.app/check/a4lYkfBx)**.
You should see: *"$250.00 was owed. The last day to claim was 15 Jul 2026."*, Jira at **98.97%** against its 99.9% promise, and all 7 incidents in June. Each one is marked counted or not, with the reason (3 counted, 445 minutes). Open **The contract terms used** to read Atlassian's own sentences behind the 99.9% and the 25% credit.

**2. See what Telegraph agents said about the same month (30 s).** Scroll to **Second opinions from Telegraph** on the same page. The check bought `SLA_COMPLIANCE_GENERAL` answers from miners on Telegraph at $0.01 each. Each row shows the miner, its answer, whether it agrees, the cost, the time and the answer hash. One miner said 100% and is marked **no**. Below that, **Contract terms from Telegraph** shows the claim clause sent as a `CONTRACT_OBLIGATION_AUDIT_GENERAL` question, and whether each answer gives the same 15-day window.

**3. Recompute it yourself, offline (90 s).** The **Download proof file** button on that page gives the same file this command fetches:

```bash
git clone https://github.com/Jennycruzy/moneyowed && cd moneyowed && npm install
curl -so proof.json https://moneyowed.vercel.app/check/a4lYkfBx/proof.json
node bin/moneyowed.js verify proof.json
```

You should see `VERIFIED: same verdict, uptime, minutes, credit and deadline as stated.` The proof carries the vendor's own incident records, each checked against the sha256 it was archived with, and the SLA text. The decision is re-run from those alone, with no network. Edit any number in the file and it fails.

**4. Ask the miner directly (30 s).** These are the endpoints Telegraph calls:

| Intent | Try it | You should see |
|---|---|---|
| `SLA_COMPLIANCE_GENERAL` | [GitHub, 2026-Q3](https://moneyowed.vercel.app/sla-compliance?service=GitHub&period=2026-Q3) | 99.3761% vs 99.9%: SLA breached |
| `SERVER_UPTIME_MONITOR_GENERAL` | [github.com now](https://moneyowed.vercel.app/server-uptime?url=https://github.com) | a live probe plus GitHub's own 30-day uptime against its SLA |
| `API_HEALTH_CHECK_GENERAL` | [api.github.com now](https://moneyowed.vercel.app/api-health?url=https://api.github.com) | status, latency, content type, JSON validity, open GitHub incidents |
| `CONTRACT_OBLIGATION_AUDIT_GENERAL` | [a late delivery](https://moneyowed.vercel.app/contract-obligations?contract=Supplier%20shall%20deliver%20500%20units%20by%2015%20March%202026.%20Supplier%20delivered%20the%20units%20on%2020%20March%202026.) | who owes what by when, the clause quoted, **Non-compliant** |
| any | [a cloud-metadata address](https://moneyowed.vercel.app/server-uptime?url=http://169.254.169.254/) | refused, never fetched |

**Optional, 2 more minutes:**
- [Run your own check](https://moneyowed.vercel.app/check): pick a vendor, a period and your bill.
- See the [GitHub Action](#in-your-own-repo-every-month) open a real claim issue: [issue #1](https://github.com/Jennycruzy/moneyowed/issues/1), from [this run](https://github.com/Jennycruzy/moneyowed/actions/workflows/sla-credits.yml).
- Read every Telegraph purchase the app has made: [/purchases.json](https://moneyowed.vercel.app/purchases.json).

---

## The problem

Paid plans at GitHub, Atlassian, Vercel, AWS and others come with a written uptime promise and a credit table. When the vendor misses, the customer is owed a share of the bill. The vendor pays only if the customer files a claim inside a short window (15 to 60 days), in the vendor's format, with the incidents listed. Almost nobody does, so the money expires.

Over the 12 months to October 2026, **12 of the 17 vendors covered here missed their promise at least once: 53 vendor-periods where customers were owed a credit** ([the full record](https://moneyowed.vercel.app/record), also as [CSV](https://moneyowed.vercel.app/record.csv)). For example:

| Vendor, plan | Period | Uptime on covered services | Promise | Credit |
|---|---|---|---|---|
| GitHub Enterprise Cloud | 2026-Q3 | 99.376% (827 min down) | 99.9% | 10% of the quarter |
| GitHub Actions (Enterprise Cloud) | 2026-Q3 | 98.986% (1,343 min down) | 99.9% | 25% |
| Jira Premium | 2026-06 | 98.97% (445 min down) | 99.9% | 25% of the month |
| Sanity Enterprise E1 | 2026-10 | 99.24% (339 min down) | 99.9% | 10% of the month |
| Prisma Pro and above | 2026-09 | 99.75% | 99.95% | 10% of the month |

GitHub Enterprise Cloud missed its 99.9% in every one of the last four quarters.

## Who it is for, and what they do with it

A team that pays for developer and cloud tools. Each month, MONEY OWED tells them which vendor owes them money, how much, and by when. They send the drafted claim, then mark it Sent, Credited or Refused. Ways in:

| Where | What you do |
|---|---|
| **Web** | [Check a vendor](https://moneyowed.vercel.app/check), get the claim text, track it. The [record](https://moneyowed.vercel.app/record) lists every miss in the year. |
| **GitHub Action** | One workflow file. Each month it opens an issue for every credit owed. [Set-up below](#in-your-own-repo-every-month). |
| **Telegram** | `/check github 2026-Q3 6000`, `/owed` (claim windows open now), `/watch jira` (a message when a watched vendor misses in a way that owes a credit). |
| **Browser extension** | Open a vendor invoice in Gmail and click the icon: *"This invoice is $2,000. You are owed $200 (10%) for 2026-10. Claim before paying."* [Download](https://moneyowed.vercel.app/extension.zip) (unzip, then "Load unpacked" in `chrome://extensions`), try it on the [sample invoice](https://moneyowed.vercel.app/sample-invoice). |
| **AI agents (MCP)** | `node bin/moneyowed-mcp.js` gives Claude, Cursor or any MCP client the tools `check_credit`, `list_incidents`, `get_rule_card`, `draft_claim`, `sla_compliance`, `list_vendors`. |
| **Command line** | `node bin/moneyowed.js check jira 2026-06 --spend 1000`, `verify <proof.json>`, `vendors`. |
| **HTTP API** | `POST /api/check`, `GET /check/<id>.json`, `GET /check/<id>/proof.json`, `GET /api/cards/<vendor>`, `GET /api/vendors`. |

## In your own repo, every month

Add this file and MONEY OWED checks your vendors after each month closes. When a credit is owed and the claim window is still open, it opens an issue with the amount, the deadline and the claim text, ready to send. You need no key and nothing to install.

```yaml
# .github/workflows/sla-credits.yml
name: SLA credits
on:
  schedule: [{ cron: '0 9 2 * *' }]   # the 2nd of each month
  workflow_dispatch:
permissions:
  issues: write
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: Jennycruzy/moneyowed@build
        with:
          vendors: |
            jira:premium=1200
            github=2100
```

One vendor per line as `vendor[:plan][=monthly bill in USD]`. `node bin/moneyowed.js vendors` lists the ids and plans. The run summary shows every vendor, and each check also buys Telegraph SLA answers and links them on its page. This repo runs the same file: [workflow](https://github.com/Jennycruzy/moneyowed/actions/workflows/sla-credits.yml), [the issue it opened](https://github.com/Jennycruzy/moneyowed/issues/1).

## How Telegraph is used

MONEY OWED is both a buyer and a seller on Telegraph.

**As a buyer (every check).** The app pays through Telegraph's escrow path, $0.01 per answer, and stores each purchase with the miner, route, cost, latency and answer hash ([all purchases](https://moneyowed.vercel.app/purchases.json)):
- `SLA_COMPLIANCE_GENERAL`: one answer from Telegraph's own routing, direct picks from ranked SLA miners, and our own miner (labelled as ours). Each is shown beside the contract-scoped result, with disagreements explained. The verdict always comes from the vendor's records and contract, never from a bought answer.
- `CONTRACT_OBLIGATION_AUDIT_GENERAL`: the vendor's own claim clause. The page shows whether each answer gives the same claim window and the same place to send the claim.

Spending is capped per user and per day. A fresh answer to the same question is reused for an hour instead of being bought twice.

**As a seller (miner 2611217).** The same engine answers four intents for any Telegraph buyer: `SLA_COMPLIANCE_GENERAL`, `SERVER_UPTIME_MONITOR_GENERAL`, `API_HEALTH_CHECK_GENERAL` and `CONTRACT_OBLIGATION_AUDIT_GENERAL`. Its registration, the daily public accuracy check (17 of 17 hand-counted vendor-months) and our evaluation material (443 pairs in three pools) are in **[moneyowed-sla](https://github.com/Jennycruzy/moneyowed-sla)**.

**New to Telegraph?** [Sell an answer on Telegraph](docs/sell-an-answer-on-telegraph.md) walks through how we built, registered and priced this miner, with the mistakes that cost us points.

## How it decides

- **Incident history.** Each vendor's own public status history: Statuspage incidents with per-component status changes, AWS Health history, the Google Cloud incident feed and Azure post-incident reviews. It is refreshed hourly, and every file is archived exactly as fetched, with its sha256.
- **Rule cards.** One card per vendor plan, written from the vendor's SLA text: which services are covered, the promise, the credit tiers, the cap, and the claim deadline and channel. Every number on a card sits next to a word-for-word quote, and a checker confirms that each threshold, tier, credit and deadline appears in its quote. The SLA pages are re-read nightly. A changed page is accepted only if every quoted sentence is still on it word for word; otherwise checks for that vendor stop with `TERMS_CHANGED` rather than give an old answer.
- **Counting.** Only time the vendor itself marked a covered service as down counts: Statuspage `partial_outage` or `major_outage` on a covered component, AWS "service disruption", Google `SERVICE_OUTAGE`, or an Azure review stating the service was unavailable. Degraded performance and scheduled maintenance do not count, which is what the contracts say. Overlaps are merged, and regions are matched for AWS, Google Cloud and Azure.
- **Decision.** Plain code computes covered minutes, uptime, credit tier, cap and deadline. No language model sets a number.

**Tested against hand-checked truth.** For each vendor-period in a sample drawn with a fixed seed, every incident was read by hand against the card before the engine ran. The first run scored 93.7%. The one cause was degraded time counted as down. The fix and a fresh sample were logged in advance, and the second run matched **57 of 57** service-periods on verdict, credit tier and minutes. Details: [/evidence](https://moneyowed.vercel.app/evidence).

## Vendors covered

GitHub Enterprise Cloud, Jira, Confluence, Jira Service Management, Bitbucket, Vercel, DigitalOcean, Twilio, Linode (Akamai), Mailgun, Sanity, Prisma, Mapbox, Buildkite, AWS, Google Cloud and Microsoft Azure (per service and region). Vendors left out, and why (no credit SLA, or no incident history a program can read), are listed on [/evidence](https://moneyowed.vercel.app/evidence#not-covered).

## Public updates

- 21 Nov 2026: the GitHub and Jira numbers ([X](https://x.com/jennyoliver57/status/2124184069105705459))
- 23 Nov 2026: the app, the miner and the evaluation pairs, with three findings for other SLA builders ([Telegraph Discord](https://discord.com/channels/1438396125609463881/1574417365095948360/1574417365095948360))
- 25 Nov 2026: Sanity's October miss and its closing claim window, plus live uptime and API health answers ([X](https://x.com/jennyoliver57/status/2125708225823556027), [Telegraph Discord](https://discord.com/channels/1438396125609463881/1574417365095948360/1575267771506360472))

## Run it yourself

Node 22 or newer.

```bash
npm install
npm test                           # unit and replay tests
npm run collect                    # 13 months of vendor history into data/, archived with hashes
node scripts/sla-sync.js --check   # re-read the SLA pages the cards quote and check every quote
npm start                          # http://127.0.0.1:8787
```

Optional `.env`: `TELEGRAPH_PRIVATE_KEY` (a Sepolia test wallet with escrow deposited, for buying answers), `TELEGRAM_BOT_TOKEN` (for `npm run bot`), `OWN_SLA_MINER_ID`.

MONEY OWED drafts claims and never sends them. MIT licence.
