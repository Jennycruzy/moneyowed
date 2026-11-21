// Buying intelligence on Telegraph (testnet) through the escrow payment path.
// Every purchase is recorded with miner, route, cost, latency and the answer's hash; spending stops at the limits.
import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

export const NODE = process.env.TELEGRAPH_NODE || 'https://devnode.telegraphprotocol.com/engine';

export class SpendLimitError extends Error { constructor(m) { super(m); this.code = 'LIMIT_REACHED'; } }

export class Telegraph {
  // ledger: { spentToday(bucket) -> usd, record(purchase) }
  constructor({ privateKey, ledger, limits = { perBucketUsd: 0.2, globalUsd: 3 }, fetchImpl = fetch } = {}) {
    if (!privateKey) throw new Error('TELEGRAPH_PRIVATE_KEY is not set');
    this.acct = privateKeyToAccount(privateKey);
    this.from = this.acct.address.toLowerCase();
    this.ledger = ledger;
    this.limits = limits;
    this.fetch = fetchImpl;
  }

  // body: { intent, query, params }. minerId: direct pick, or null for the node's own routing.
  async ask(body, { minerId = null, bucket = 'default', checkId = null } = {}) {
    const url = minerId ? `${NODE}/v1/ask/${minerId}` : `${NODE}/v1/ask`;
    const t0 = Date.now();
    let r = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status !== 402) {
      const text = await r.text();
      return this.#done({ body, minerId, bucket, checkId, status: r.status, text, cost: 0, ms: Date.now() - t0, paid: false });
    }
    const challenge = await r.json();
    const e = (challenge.accepts || []).find((a) => a.scheme === 'escrow');
    if (!e) return this.#done({ body, minerId, bucket, checkId, status: 402, text: JSON.stringify(challenge), cost: 0, ms: Date.now() - t0, paid: false, error: 'no escrow payment option offered' });
    const amount = (e.extra.message.match(/Amount: (\d+) uUSDC/) || [])[1];
    const cost = Number(amount) / 1e6;
    const spentBucket = this.ledger.spentToday(bucket), spentAll = this.ledger.spentToday(null);
    if (spentBucket + cost > this.limits.perBucketUsd) throw new SpendLimitError(`daily limit for this user reached ($${spentBucket.toFixed(2)} of $${this.limits.perBucketUsd.toFixed(2)})`);
    if (spentAll + cost > this.limits.globalUsd) throw new SpendLimitError(`daily service limit reached ($${spentAll.toFixed(2)} of $${this.limits.globalUsd.toFixed(2)})`);
    const now = Math.floor(Date.now() / 1000);
    const va = String(now - 30), vb = String(now + 80), nonce = crypto.randomBytes(16).toString('hex'); // node accepts windows up to 2 minutes
    const msg = e.extra.message.replace('{from}', this.from).replace('{nonce}', nonce).replace('{validAfter}', va).replace('{validBefore}', vb);
    const signature = await this.acct.signMessage({ message: msg });
    const pay = { x402Version: 2, scheme: 'escrow', network: e.network, payload: { signature, authorization: { from: this.from, to: e.payTo.toLowerCase(), value: amount, validAfter: va, validBefore: vb, nonce } } };
    r = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-PAYMENT': Buffer.from(JSON.stringify(pay)).toString('base64') }, body: JSON.stringify(body) });
    const text = await r.text();
    const rh = r.headers.get('x-telegraph-receipt');
    let receipt = null;
    if (rh) { try { receipt = JSON.parse(Buffer.from(rh, 'base64').toString('utf8')); } catch { receipt = rh; } }
    return this.#done({ body, minerId, bucket, checkId, status: r.status, text, cost: r.ok ? cost : 0, ms: Date.now() - t0, paid: r.ok, receipt, nonce });
  }

  #done(p) {
    let parsed = null;
    try { parsed = JSON.parse(p.text); } catch { /* not JSON */ }
    const purchase = {
      at: new Date().toISOString(), check_id: p.checkId, bucket: p.bucket, intent: p.body.intent, route: p.minerId ? 'direct' : 'auto',
      requested_miner: p.minerId, miner_id: parsed?.miner_id ?? p.minerId, miner_name: parsed?.miner_name ?? null,
      status: p.status, paid: p.paid, cost_usd: p.cost, latency_ms: p.ms, error: p.error || (p.status >= 400 ? (parsed?.error || p.text.slice(0, 300)) : null),
      question_sha256: crypto.createHash('sha256').update(JSON.stringify(p.body)).digest('hex'), answer: parsed?.result ?? null, answer_sha256: crypto.createHash('sha256').update(p.text).digest('hex'),
      node_cost_usd: parsed?.cost_usd ?? null, node_timestamp: parsed?.timestamp ?? null, receipt: p.receipt || null, payment_nonce: p.nonce || null, from: this.from,
    };
    this.ledger?.record(purchase);
    return purchase;
  }
}

// What we ask SLA miners, in the form today's SLA miners accept (params: service, period; target in the text).
export function slaQuestion({ vendorName, serviceName, threshold, periodStart, periodEnd, periodKey }) {
  const a = periodStart.toISOString().slice(0, 10), b = new Date(+periodEnd - 1).toISOString().slice(0, 10);
  return {
    intent: 'SLA_COMPLIANCE_GENERAL',
    params: { service: vendorName.toLowerCase().replace(/\s*\(.*\)$/, '').replace(/\s+/g, ' '), period: `${a} to ${b}` },
    query: `Did ${serviceName.toLowerCase().includes(vendorName.toLowerCase().split(' ').pop()) ? serviceName : `${vendorName} ${serviceName}`} meet a ${threshold}% uptime SLA for ${periodKey} (${a} to ${b} UTC)? Give the uptime percentage, outage minutes and the incidents counted.`,
  };
}

// Read the common answer shapes into {uptime_pct, compliant, period_label} without trusting them.
export function readSlaAnswer(answer) {
  if (!answer || typeof answer !== 'object') return { usable: false, why: 'no answer' };
  const up = Number(answer.uptime_pct ?? answer.uptime ?? answer.availability_pct ?? NaN);
  const compliant = typeof answer.compliant === 'boolean' ? answer.compliant : (typeof answer.met === 'boolean' ? answer.met : null);
  const period = answer.period ?? answer.window ?? null;
  return { usable: Number.isFinite(up) || compliant !== null, uptime_pct: Number.isFinite(up) ? up : null, compliant, period_label: period, incidents_listed: Array.isArray(answer.incidents) ? answer.incidents.length : 0 };
}
