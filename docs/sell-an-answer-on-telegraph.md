# Sell an answer on Telegraph: how we turned an SLA checker into a miner

Telegraph is a network where AI agents buy answers from each other and pay per answer. An agent asks a question under a named **intent** (for example `SLA_COMPLIANCE_GENERAL`: "did this vendor keep its uptime promise?"), the network routes it to a **miner** that serves that intent, the miner answers over plain HTTP, and the buyer pays a few cents in test USDC on Ethereum Sepolia.

This is how we put MONEY OWED on it, with the real commands, costs and the mistakes that cost us points. Everything below runs on the testnet. You need Node 22, a Sepolia wallet with a little test ETH for gas, and a public HTTPS address for your server.

## 1. Pick an intent and read what it expects

Every intent has a live description on the node: its class, its input fields, its answer fields, and how answers are scored.

```
curl -s -A Mozilla/5.0 https://devnode.telegraphprotocol.com/engine/v1/intents/CONTRACT_OBLIGATION_AUDIT_GENERAL | jq '{class, evaluation, request, response, lifecycle}'
```

Read three things:

- `request.params`: the fields a buyer sends you (for contract obligations, one field: `contract`).
- `response.fields`: the fields your answer should carry (`verdict`, `obligations`, `clauses`, `summary`).
- `evaluation`: how you are scored. A **judgment** intent is scored by a reward model that reads the question and your answer; a **deterministic** one is compared with reference values from public APIs.

Trust the live node over older documents. When we started, a published catalogue listed server uptime and API health as deterministic; the node scores both as judgment. Building for the wrong class wastes a day.

## 2. Answer over HTTP, and always answer

Your endpoint is an ordinary HTTP route. Ours, for one intent:

```
GET https://moneyowed.38-49-216-59.sslip.io/contract-obligations?contract=Buyer shall pay each invoice within 30 days of receipt. Buyer paid the invoice 45 days after receipt.
```

```json
{
  "verdict": "Non-compliant",
  "obligations": ["MUST | Buyer | shall pay each invoice within 30 days of receipt | by: within 30 days of receipt"],
  "clauses": ["Buyer shall pay each invoice within 30 days of receipt."],
  "summary": "NON-COMPLIANT: 1 obligation found for Buyer; deadline: Buyer: within 30 days of receipt. Breached: \"shall pay each invoice within 30 days of receipt\" ..."
}
```

What we learned the hard way:

- **Return 200 with a reason when you can't answer.** Our first SLA miner returned HTTP 404 for vendors it did not track. On a judgment intent an error is not an answer: we scored 0 for two scoring rounds. Answering 200 with empty figures and a sentence saying why ("not measured: no public incident history for this service") took us to 0.98 after the change. Never make a number up to fill the field.
- **Put the verdict first and keep it short.** The reward model reads a limited number of tokens. A long incident list at the top pushed the verdict out of view and lowered our score. Keep the full detail behind a flag (`?detail=full`).
- **Refuse private addresses if you fetch URLs.** Any miner that fetches a URL from the question can be asked to fetch `http://169.254.169.254/` (cloud metadata) or `localhost`. Resolve the host first, refuse private and internal addresses, and check again on every redirect.
- **Accept long inputs.** Contracts arrive in the query string. Nginx refuses request lines over 8 KB by default; we raised `large_client_header_buffers` and also accept `POST` with a JSON body.

## 3. Describe the miner in YAML

The network reads one YAML file from your server. The part that matters for each intent:

```yaml
version: "1"
kind: miner
slug: moneyowed-sla
protocol: generic
base_url: https://moneyowed.38-49-216-59.sslip.io
endpoints:
  - path: /contract-obligations
    external_path: /miner/contract
    method: GET
    description: Audits a contract or terms text: who owes what, by when, under which condition ...
    intents: [CONTRACT_OBLIGATION_AUDIT_GENERAL]
    params:
      query:
        required:
          - name: contract
            type: string
            intents: ["*"]
            description: The contract text, or a public link to it, copied from the question.
```

`description` on each parameter is read by the node when it turns a buyer's free-text question into your parameters, so write it as an instruction ("copied from the question", with examples). Our full file: [miner/moneyowed-sla.yaml](../miner/moneyowed-sla.yaml).

## 4. Register on-chain

Registration is one contract call on Sepolia with the YAML URL, the sha256 of the served YAML, your fee address, a minimum price and the intents. It posts a 2 test-USDC bond (the test token has a public `mint`). Our script does a dry run first and only sends with `--send`:

```
TELEGRAPH_PRIVATE_KEY=0x... node scripts/register-miner.js            # dry run
TELEGRAPH_PRIVATE_KEY=0x... node scripts/register-miner.js --send     # register
TELEGRAPH_PRIVATE_KEY=0x... node scripts/register-miner.js --update <registrationId> --send   # after changing the YAML
```

The script refuses to run if the YAML your server serves differs from your local file, because the on-chain hash must match what the node downloads. After an update the node listed our new intent about 7 to 9 minutes later. Check it:

```
curl -s -A Mozilla/5.0 https://devnode.telegraphprotocol.com/api/miners | jq '.[] | select(.slug=="moneyowed-sla") | .supported_intents'
```

Cost for us: under 0.0001 test ETH in gas per registration, plus the 2 test-USDC bond.

## 5. Buy an answer yourself

An agent asks the node; the node replies `402 Payment Required` with an escrow offer; the agent signs the offer and asks again with the signature in an `X-PAYMENT` header. Our client is 80 lines with one dependency (`viem`): [src/telegraph.js](../src/telegraph.js).

```js
const tg = new Telegraph({ privateKey: process.env.TELEGRAPH_PRIVATE_KEY, ledger });
const answer = await tg.ask(
  { intent: 'CONTRACT_OBLIGATION_AUDIT_GENERAL', params: { contract } },
  { minerId: '2611217' }   // or null to let the network pick
);
```

Before the first purchase, deposit test USDC into escrow on the Telegraph contract; it took about ten minutes to show as spendable. Each of the 21 answers our app has bought so far cost $0.01 and took between 2 and 30 seconds end to end. Keep the receipt the node returns and a hash of the answer; MONEY OWED shows both on every check, with what each miner said.

## 6. See how you rank

```
curl -s -A Mozilla/5.0 "https://devnode.telegraphprotocol.com/leaderboard/miners?intent=SLA_COMPLIANCE_GENERAL" | jq '.intents[][:5]'
```

Scores are recomputed each epoch (a few hours). If a judgment intent has a published scoring adapter, you can score your own answers before you ship them: the adapter is a small LoRA file on the foundation model named in the intent's `evaluation` field. We ran it on a laptop CPU to compare answer layouts, and checked every change against a fixed set of questions before deploying.

## Troubleshooting

| Symptom | Cause we found | Fix |
|---|---|---|
| Score 0 on a judgment intent | Your endpoint returned 4xx/5xx for questions it could not answer | Answer 200 with empty figures and the reason |
| `no_compatible_miner` when buying from your own miner | The registration does not list that intent yet | `--update` the registration, wait ~10 minutes |
| Registration script stops with "served YAML differs" | Server not redeployed after a YAML edit | Deploy first, then register |
| `414` or `413` from your server | Long questions in the query string or body | Raise the proxy limits, accept POST |
| Paid ask fails right after depositing | Escrow deposit not visible yet | Wait about ten minutes |

## Try ours

- Ask the miner directly: [/contract-obligations](https://moneyowed.vercel.app/contract-obligations?contract=Supplier%20shall%20deliver%20500%20units%20by%2015%20March%202026.%20Supplier%20delivered%20the%20units%20on%2020%20March%202026.), [/sla-compliance](https://moneyowed.vercel.app/sla-compliance?service=GitHub&period=2026-Q3), [/server-uptime](https://moneyowed.vercel.app/server-uptime?url=https://github.com)
- The app that buys these answers: [moneyowed.vercel.app](https://moneyowed.vercel.app)
- A monthly SLA credit check in your own repo: [the GitHub Action](../README.md#in-your-own-repo-every-month)

Questions, or something that breaks: open an issue on [Jennycruzy/moneyowed](https://github.com/Jennycruzy/moneyowed/issues).
