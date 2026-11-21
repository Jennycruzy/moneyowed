#!/usr/bin/env node
// MONEY OWED as an MCP server (stdio, JSON-RPC 2.0). Tools call the public MONEY OWED API; nothing is sent to a vendor.
// Add to an MCP client:  { "command": "node", "args": ["/path/to/moneyowed/bin/moneyowed-mcp.js"] }
import readline from 'node:readline';
import { draftClaim } from '../src/claim.js';

const API = process.env.MONEYOWED_API || 'https://moneyowed.38-49-216-59.sslip.io';
const get = async (p) => { const r = await fetch(`${API}${p}`); const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || j.error || `HTTP ${r.status}`); return j; };
const post = async (p, body) => { const r = await fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
const str = (description) => ({ type: 'string', description });

const TOOLS = [
  { name: 'check_credit', description: 'Is a service credit owed by a vendor for a billing period under its written SLA? Returns verdict (OWED, NOT_OWED, WINDOW_CLOSED, PERIOD_OPEN), uptime on covered services, minutes counted, credit percent and amount, claim deadline, and a check id.',
    inputSchema: { type: 'object', required: ['vendor', 'period'], properties: { vendor: str('Vendor id, e.g. github, jira, vercel, aws (see list_vendors)'), period: str('Billing period: YYYY-MM, or YYYY-Qn for GitHub'), plan: str('Plan id when the vendor has several (optional)'), spend: { type: 'number', description: "The period's bill in USD (optional, gives the dollar amount)" }, regions: str('Comma-separated regions, required for aws, gcp, azure') } },
    run: async (a) => { const r = await post('/api/check', { ...a, evidence: 'none' }); return { id: r.id, code: r.code, vendor: r.vendor_name, plan: r.plan_label, period: r.period, credit_usd_total: r.credit_usd_total, deadline: r.deadline, deadline_rule: r.deadline_rule, services: r.services.map((s) => ({ service: s.service, uptime_pct: s.uptime_pct, threshold_pct: s.threshold_pct, covered_minutes: s.covered_minutes, credit_pct: s.credit_pct, credit_usd: s.credit_usd })), page: `${API}/check/${r.id}`, proof: `${API}/check/${r.id}/proof.json` }; } },
  { name: 'list_incidents', description: 'Every vendor incident in a checked period, with whether it counted under the SLA and why. Takes the id returned by check_credit.',
    inputSchema: { type: 'object', required: ['check_id'], properties: { check_id: str('Id from check_credit') } },
    run: async ({ check_id }) => { const r = await get(`/check/${encodeURIComponent(check_id)}.json`); return r.services.map((s) => ({ service: s.service, incidents: s.incidents.map((i) => ({ name: i.name, start: i.start, end: i.end, counted: i.in_scope, minutes: i.minutes, reason: i.reason, url: i.url })) })); } },
  { name: 'get_rule_card', description: "A vendor's SLA terms as used for the decision: thresholds, credit tiers, cap and claim deadline, each with the vendor's own words quoted.",
    inputSchema: { type: 'object', required: ['vendor'], properties: { vendor: str('Vendor id') } },
    run: async ({ vendor }) => get(`/api/cards/${encodeURIComponent(vendor)}`) },
  { name: 'draft_claim', description: 'Draft the credit claim email for an OWED check. Returns the text for the customer to send; nothing is sent.',
    inputSchema: { type: 'object', required: ['check_id'], properties: { check_id: str('Id from check_credit'), customer: str('Customer company name (optional)'), account: str('Account or org id (optional)') } },
    run: async ({ check_id, customer, account }) => draftClaim(await get(`/check/${encodeURIComponent(check_id)}.json`), { customer, account }) },
  { name: 'sla_compliance', description: 'Uptime of a vendor service over any past window ("last 30 days", "2026-10", "2026-Q3") against its SLA target, counting only vendor-marked outages on covered services.',
    inputSchema: { type: 'object', required: ['service', 'period'], properties: { service: str('Vendor and optional service/region, e.g. "GitHub Actions", "Amazon EC2 us-east-1"'), period: str('Past period') } },
    run: async ({ service, period }) => get(`/miner/sla?service=${encodeURIComponent(service)}&period=${encodeURIComponent(period)}`) },
  { name: 'list_vendors', description: 'Covered vendors, their plans with an SLA, and the billing period each uses.',
    inputSchema: { type: 'object', properties: {} }, run: async () => get('/api/vendors') },
];

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'moneyowed', version: '1.0.0' } } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    if (method === 'tools/call') {
      const t = TOOLS.find((x) => x.name === params?.name);
      if (!t) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
      try { const out = await t.run(params.arguments || {}); return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] } }); }
      catch (e) { return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message }] } }); }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }); }
});
