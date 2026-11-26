// Draft a service-credit claim from a check result. The user sends it; nothing here sends anything.
const fmt = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'ongoing');
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

const SUBJECTS = {
  aws: 'SLA Credit Request', twilio: 'SLA Claim', sanity: 'SLA Credit Request', prisma: 'SLA Credit Request',
};

export function draftClaim(result, { customer = '[your company]', account = '[your account / org ID]' } = {}) {
  if (!['OWED', 'PERIOD_OPEN'].includes(result.code) || !result.owed_services.length) {
    throw Object.assign(new Error(`no credit is owed for ${result.vendor_name} ${result.period} (${result.code})`), { code: result.code });
  }
  const owed = result.services.filter((s) => s.credit_pct > 0);
  const subject = SUBJECTS[result.vendor] ? `${SUBJECTS[result.vendor]} - ${result.period}` : `Service credit request under the ${result.vendor_name} SLA - ${result.period}`;
  const lines = [];
  lines.push(`To: ${result.claim.channel}`);
  lines.push(`Subject: ${subject}`);
  lines.push('');
  lines.push(`Hello ${result.vendor_name} team,`);
  lines.push('');
  const off = (result.period_utc_offset_hours || 0) * 3600000;
  const zone = off ? ', each day counted from the midnight your SLA names' : '';
  lines.push(`${customer} (${account}) requests the service credit owed under your published SLA (${result.card.sla_url}) for ${result.plan_label}, period ${result.period} (${day(+new Date(result.period_start) + off)} to ${day(+new Date(result.period_end) + off - 1)}${zone}${result.regions.length ? `, regions: ${result.regions.join(', ')}` : ''}).`);
  lines.push('');
  for (const s of owed) {
    lines.push(`${s.service}: uptime ${s.uptime_pct}% against the ${s.threshold_pct}% commitment (${s.covered_minutes} minutes of unavailability; ${s.allowed_minutes} allowed). Credit tier: ${s.credit_pct}%${s.credit_usd != null ? ` = $${s.credit_usd.toFixed(2)} on fees of $${Number(s.fee).toFixed(2)}` : ''}.`);
    lines.push(`  Your SLA: "${trim(s.quotes.threshold)}"`);
    lines.push(`  Credit table: "${trim(s.quotes.tiers)}"`);
    lines.push('  Incidents (from your public status history):');
    for (const i of s.incidents.filter((x) => x.in_scope)) {
      lines.push(`  - ${fmt(i.start)} to ${fmt(i.end)}: ${i.name} (${i.minutes} min in period)${i.url ? ` ${i.url}` : ''}`);
    }
    if (s.measure_note) lines.push(`  Note: ${s.measure_note}`);
    lines.push('');
  }
  if (result.credit_usd_total != null) lines.push(`Total credit requested: $${result.credit_usd_total.toFixed(2)}${result.cap ? ` (within the ${result.cap.pct_of_fee}% monthly cap)` : ''}.`);
  const last = result.last_day || day(new Date(+new Date(result.deadline) - 1));
  if (!result.deadline) lines.push(`${result.deadline_rule}`);
  else if (result.deadline_later && new Date() > new Date(result.deadline)) lines.push(`This request is made within the claim window: the SLA allows ${result.deadline_later_rule.replace(', if eligibility starts when the period closes', '')}, as the credit became final when the period closed (last day ${result.last_day_later}).`);
  else lines.push(`This request is made within your claim window (${result.deadline_rule}; last day ${last}).`);
  lines.push('We can provide our own request logs for these times on request.');
  lines.push('');
  lines.push('Thank you,');
  lines.push(customer);
  return { subject, body: lines.join('\n'), to: result.claim.channel, deadline: result.deadline };
}

function trim(q, n = 220) {
  if (!q) return '';
  return q.length > n ? q.slice(0, n).replace(/\s+\S*$/, '') + ' ...' : q;
}
