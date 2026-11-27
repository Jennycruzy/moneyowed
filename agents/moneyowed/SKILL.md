---
name: moneyowed
description: Watch the software and cloud vendors the user pays (GitHub, Jira, Vercel, AWS, Google Cloud, Azure and 11 more) and tell them only when a vendor owes them an SLA service credit, when a promise is already missed this period, or when their SLA terms change. Drafts the claim email; never sends it.
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [sla, vendors, money, monitoring, telegraph]
    category: finance
    requires_toolsets: [terminal]
  openclaw:
    requires:
      bins: [node, moneyowed]
---

# MONEY OWED

Vendors promise uptime in writing and owe a service credit when they miss it, but only if the customer claims in time.
`moneyowed` checks each vendor's own incident history against the exact SLA text, works out the credit and the last day
to claim, and keeps a proof file that anyone can recompute offline.

## When to use

- The user says which vendors they pay ("we pay Vercel $2,000 a month", "add GitHub, about $6k a quarter").
- The user asks whether a vendor owes them anything, or wants to be told when one does.
- A scheduled MONEY OWED message arrives and the user asks what to do next.

## Procedure

1. Add each vendor the user pays, with the bill if they give it (dollars need the bill):
   `moneyowed watch add vercel --spend 2000`
   `moneyowed watch add aws --region us-east-1 --spend 9000`
   `moneyowed vendors` lists vendor ids and plans; use `--plan` when a vendor has several.
2. Run it once now and show the user the output: `moneyowed watch run`.
3. Schedule it weekly so no claim window is missed. Messages come only when something is new.
   - OpenClaw: `openclaw cron add --name moneyowed-weekly --cron "0 9 * * 1" --command "moneyowed watch run" --announce`
     (output `NO_REPLY` = nothing new, nothing is posted).
   - Hermes: create a no-agent cron job running the script `moneyowed-watch.sh` (in `~/.hermes/scripts/`, containing
     `exec moneyowed watch run --silent-token none`), schedule `0 9 * * 1`, deliver to `origin`. Empty output = silent tick.
   - Or run `agents/install.sh openclaw|hermes` from the MONEY OWED repo, which does both steps.
4. When a credit is owed, offer the claim email: `moneyowed claim <check id> --customer "<company>" --account "<account id>"`.
   Show the draft. The user sends it. Never send it for them.
5. Optional evidence from other sellers: with a Telegraph testnet key in `~/.moneyowed/.env`
   (`TELEGRAPH_PRIVATE_KEY=0x...`, chmod 600), each newly owed credit buys SLA and contract answers on Telegraph and
   reports how many agree. Spending stops at the budget: `moneyowed watch budget --run 0.05 --month 0.20`.

## Pitfalls

- Clouds (aws, gcp, azure) need `--region`; the SLA is per service and region.
- Without `--spend` the message gives the credit as a percent, not dollars.
- A reworded SLA page with the same numbers is not reported; only changed terms are.
- If a check fails the run says so ("Could not check ..."); it is retried next run. Do not hide that line.

## Verification

- `moneyowed watch list` shows the vendors, the budget, what was spent this month and the last run.
- `moneyowed verify <proof.json>` recomputes any result from the records inside the proof, with no network.
