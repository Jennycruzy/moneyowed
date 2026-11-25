// CONTRACT_OBLIGATION_AUDIT: who owes what, by when, under which condition, with the clause each one comes from.
// Rule-based on purpose: every obligation listed is a sentence of the contract, so it can be checked against the text.
// The verdict is only Compliant / Non-compliant when the question also states what happened; otherwise it is Unclear.
import { probe, targetFrom } from './probe.js';

const MAX_TEXT = 60000;

// ---------- the contract text (inline, or fetched from a public link)
export async function contractText(q) {
  const raw = String(q.contract || q.text || q.document || q.question || q.query || '').trim();
  const onlyLink = /^https?:\/\/\S+$/i.test(raw);
  if (!onlyLink) return { text: raw.slice(0, MAX_TEXT), source: 'inline' };
  const { url } = targetFrom({ url: raw });
  const r = await probe(url, { headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.5' } });
  if (r.refused) return { text: '', source: url, error: 'the link points to a private or internal address' };
  if (r.error || !(r.status >= 200 && r.status < 300)) return { text: '', source: url, error: r.error || `the link answered HTTP ${r.status}` };
  return { text: htmlToText(r.body).slice(0, MAX_TEXT), source: r.final_url || url };
}

export function htmlToText(s) {
  return String(s || '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|h\d|div|tr)>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

// ---------- sentences
export function sentences(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/\b(e\.g|i\.e|etc|no|inc|ltd|co|corp|approx|vs|sec|art|para)\./gi, (m) => m.replace('.', '\u0000'))
    .split(/(?<=[.;!?]["'\u201d)]?)\s+(?=["'(\u201c]?[A-Z0-9])|\s+(?=\(?\d{1,2}(?:\.\d{1,2})+\.?\s+[A-Z])/)
    .map((s) => s.replace(/\u0000/g, '.').trim())
    .filter((s) => s.length >= 12 && /[a-z]/i.test(s));
}

// ---------- one sentence -> an obligation (or a right, or a prohibition)
const MODAL = /\b(shall not|must not|will not|may not|cannot|is not permitted to|are not permitted to|shall|must|should|will|agrees? to|undertakes? to|is required to|are required to|is responsible for|are responsible for|is obligated to|are obligated to|is entitled to|are entitled to|may)\b/i;
const NUM_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, fifteen: 15, thirty: 30, sixty: 60, ninety: 90 };

export function deadlineIn(s) {
  const t = s.replace(/\b(one|two|three|four|five|six|seven|ten|fourteen|fifteen|thirty|sixty|ninety)\s*\((\d+)\)/gi, '$2');
  let m = /\b(within|no later than|not later than|at least|up to)\s+(\d+|one|two|three|four|five|six|seven|ten|fourteen|fifteen|thirty|sixty|ninety)\s+(business days|working days|calendar days|days|hours|weeks|months)\b([^.;]{0,80})/i.exec(t);
  if (m) {
    const n = /^\d+$/.test(m[2]) ? Number(m[2]) : NUM_WORD[m[2].toLowerCase()];
    const from = (/\b(after|of|from|following|before)\b[^.;,]{0,70}/i.exec(m[4]) || [''])[0].trim();
    return { text: `${m[1].toLowerCase()} ${n} ${m[3].toLowerCase()}${from ? ` ${from}` : ''}`, amount: n, unit: m[3].toLowerCase(), kind: m[1].toLowerCase() };
  }
  m = /\b(by|before|on or before|no later than)\s+((?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{1,2})?,?\s+\d{4}|\d{4}-\d{2}-\d{2})/i.exec(t);
  if (m) return { text: `${m[1].toLowerCase()} ${m[2]}`, date: m[2], kind: 'date' };
  m = /\b(immediately|promptly|without undue delay|upon request|on demand|each month|every month)\b/i.exec(t);
  if (m) return { text: m[1].toLowerCase(), kind: 'timing' };
  return null;
}

function conditionIn(s) {
  const m = /\b(subject to|provided that|unless|except|if|in order to|in the event(?: that)?|upon|only if|as long as)\b((?:[^.;,]|\.(?=\S)){3,140})/i.exec(s);
  if (!m) return null;
  return `${m[1].toLowerCase()}${m[2]}`.replace(/\s*,\s*$/, '').trim();
}

function moneyIn(s) {
  const out = [];
  const re = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|thousand|k|m))?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|USDT|USDC|EUR|GBP|NGN|dollars|euros|pounds)\b|\b\d+(?:\.\d+)?\s?%)/gi;
  let m;
  while ((m = re.exec(s)) && out.length < 6) out.push(m[0].replace(/\s+/g, ' '));
  return out;
}

const PARTY_STRIP = /^(?:\(?\d+(?:\.\d+)*\)?\.?\s+|[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}\.\s+)?(?:(?:in order to|in the event|if|upon|subject to|provided that|unless|where|when|except)[^,]{0,140},\s*)?/i;

export function partyOf(s, modalIndex) {
  let head = s.slice(0, modalIndex).replace(/^[^:]{1,40}:\s+/, '').replace(PARTY_STRIP, '').trim();
  head = head.replace(/^(and|or|but|then|also|further|the parties agree that|it is agreed that)\s+/i, '');
  const words = head.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const tail = words.slice(-6).join(' ').replace(/^[^A-Za-z(]+/, '').replace(/[,:;]+$/, '');
  if (!tail || tail.length > 60) return null;
  return tail.replace(/^(the|each|any|every|a|an)\s+/i, (w) => w.toLowerCase());
}

export function classify(modal) {
  const m = modal.toLowerCase();
  if (/not|cannot/.test(m)) return 'prohibition';
  if (/^may$|entitled/.test(m)) return 'right';
  return 'obligation';
}

export function extract(text) {
  const out = [];
  for (const s of sentences(text)) {
    let mm = MODAL.exec(s);
    if (!mm) {
      // a clause with a deadline but no duty verb (e.g. "within fifteen (15) days after the end of the month ...") is still a duty
      // "To submit a request, open a ticket ..." is an instruction to the reader
      const imp = /^(?:To [^,]{3,80},\s+)(?=[a-z]+\b)/.exec(s);
      if (!deadlineIn(s) && !imp) continue;
      mm = { index: 0, 1: 'must', imperative: Boolean(imp) };
    }
    const kind = classify(mm[1]);
    let party = mm.imperative ? 'the customer (instruction to the reader)' : partyOf(s, mm.index);
    // "X will receive / be paid": the duty sits with whoever pays X
    if (party && kind === 'obligation' && /^(will|shall|must)\s+(receive|be paid|be refunded|be credited|be reimbursed|get)\b/i.test(s.slice(mm.index))) party = `the paying party (owed to ${party})`;
    const duty = s.slice(mm.index).replace(/\s+/g, ' ').replace(/[.;]+$/, '').trim();
    const deadline = deadlineIn(s);
    const condition = conditionIn(s);
    const amounts = moneyIn(s);
    // weight: real duties with a party, a deadline or money first
    const weight = (kind === 'obligation' ? 3 : kind === 'prohibition' ? 2 : 1) + (party ? 1 : 0) + (deadline ? 2 : 0) + (amounts.length ? 1 : 0) + (condition ? 1 : 0);
    out.push({ kind, party, duty: duty.length > 220 ? `${duty.slice(0, 217).replace(/\s+\S*$/, '')}...` : duty, deadline, condition, amounts, clause: s.length > 300 ? `${s.slice(0, 297).replace(/\s+\S*$/, '')}...` : s, weight });
  }
  return out;
}

// ---------- facts stated in the question (what actually happened) -> a verdict when they can be compared
const FACT_RE = /\b(was|were|has been|had been|did not|didn't|failed to|never|paid|delivered|sent|notified|received|submitted|completed|missed|arrived|occurred|happened)\b/i;
export function factsIn(text) {
  return sentences(text).filter((s) => FACT_RE.test(s) && !MODAL.test(s));
}

function daysOf(s) {
  const m = /\b(\d+)\s+(business days|working days|calendar days|days|hours|weeks|months)\b/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]); const u = m[2].toLowerCase();
  return u.startsWith('hour') ? n / 24 : u.startsWith('week') ? n * 7 : u.startsWith('month') ? n * 30 : n;
}

export function judge(items, facts) {
  if (!facts.length) return { verdict: 'Unclear', why: 'The text states obligations but says nothing about what actually happened, so compliance cannot be judged from it.' };
  const checks = [];
  for (const f of facts) {
    const neg = /\b(did not|didn't|failed to|never|missed|not (?:paid|delivered|sent|notified|received|submitted|completed))\b/i.test(f);
    const fd = daysOf(f);
    for (const o of items.filter((x) => x.kind === 'obligation')) {
      const shared = overlap(o.duty, f);
      if (shared < 1) continue;
      if (neg) { checks.push({ ok: false, o, f }); continue; }
      if (o.deadline?.kind === 'date') {
        const fdt = dateOf(f), odt = dateOf(o.deadline.date);
        if (fdt && odt) { checks.push({ ok: fdt <= odt, o, f }); continue; }
      }
      const od = o.deadline?.amount != null ? daysOf(`${o.deadline.amount} ${o.deadline.unit}`) : null;
      if (fd != null && od != null && /within|no later|not later|up to/.test(o.deadline.kind)) checks.push({ ok: fd <= od, o, f });
      else if (!o.deadline) checks.push({ ok: true, o, f, weak: true });
    }
  }
  if (!checks.length) return { verdict: 'Unclear', why: 'Facts are given, but none of them can be matched to a stated obligation.' };
  const bad = checks.filter((c) => !c.ok);
  const good = checks.filter((c) => c.ok && !c.weak);
  if (bad.length && (good.length || checks.some((c) => c.ok))) return { verdict: 'Partially compliant', why: `Breached: "${bad[0].o.duty}" (fact: "${bad[0].f}").`, checks };
  if (bad.length) return { verdict: 'Non-compliant', why: `Breached: "${bad[0].o.duty}" (fact: "${bad[0].f}").`, checks };
  if (good.length) return { verdict: 'Compliant', why: `Met: "${good[0].o.duty}" (fact: "${good[0].f}").`, checks };
  return { verdict: 'Unclear', why: 'The facts given touch the obligations but carry no dates or amounts to compare.', checks };
}

function dateOf(s) {
  const m = /(\d{4}-\d{2}-\d{2})|((?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{1,2})?,?\s+\d{4})/i.exec(String(s));
  if (!m) return null;
  const t = Date.parse(`${m[0].replace(/,/g, '')} UTC`);
  return Number.isFinite(t) ? t : null;
}

const STOP = new Set('the a an of to and or in on for by with within days day from that this be is are was were will shall must any all its their his her our your has have had not no as at it'.split(' '));
function overlap(a, b) {
  const w = (s) => new Set(s.toLowerCase().match(/[a-z]{3,}/g)?.filter((x) => !STOP.has(x)) || []);
  const A = w(a), B = w(b);
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n;
}

// ---------- the answer
export async function answerObligations(q) {
  const c = await contractText(q);
  if (c.error || !c.text || c.text.length < 20) {
    const why = c.error || 'no contract text was given';
    return {
      verdict: 'Unclear', obligations: [], clauses: [],
      summary: `CONTRACT NOT AUDITED: ${why}. Send the contract text, or a public link to it, as contract.`,
      status: 'not_audited', source: c.source || null,
    };
  }
  // the contract is the part before any stated facts; facts are past-tense sentences without a modal verb
  const items = extract(c.text);
  const facts = factsIn(c.text);
  const top = [...items].sort((a, b) => b.weight - a.weight).slice(0, 8)
    .sort((a, b) => items.indexOf(a) - items.indexOf(b));
  const j = judge(items, facts);
  const duties = top.filter((x) => x.kind !== 'right');
  const deadlines = top.filter((x) => x.deadline).map((x) => `${x.party || 'a party'}: ${x.deadline.text}`);
  const parties = [...new Set(top.map((x) => x.party).filter(Boolean))];
  const line = (x) => `${x.kind === 'prohibition' ? 'MUST NOT' : x.kind === 'right' ? 'MAY' : 'MUST'} | ${x.party || 'unnamed party'} | ${x.duty}${x.deadline ? ` | by: ${x.deadline.text}` : ''}${x.condition ? ` | condition: ${x.condition}` : ''}`;
  const summary = top.length
    ? `${j.verdict.toUpperCase()}: ${duties.length} obligation${duties.length === 1 ? '' : 's'} found${parties.length ? ` for ${parties.slice(0, 3).join(', ')}` : ''}${deadlines.length ? `; deadline${deadlines.length > 1 ? 's' : ''}: ${deadlines.slice(0, 2).join('; ')}` : '; no deadline stated'}. ${j.why}`
    : `UNCLEAR: no sentence in the text creates an obligation (no shall, must, will or agrees to). ${j.why}`;
  return {
    verdict: j.verdict,
    obligations: top.map(line),
    clauses: top.map((x) => x.clause),
    summary,
    deadlines,
    conditions: [...new Set(top.map((x) => x.condition).filter(Boolean))].slice(0, 4),
    amounts: [...new Set(top.flatMap((x) => x.amounts))].slice(0, 6),
    facts_checked: facts.slice(0, 4),
    status: 'audited',
    source: c.source,
    method: 'Each sentence with shall, must, will, agrees to or may is one obligation, prohibition or right; party, deadline, condition and amounts are read from that sentence; the verdict compares stated facts with the matching obligation and is Unclear when no facts are given.',
  };
}

// The default answer: the four fields the intent declares, verdict first. ?detail=full adds deadlines, conditions, amounts and method.
export function obligationsView(a) {
  return { verdict: a.verdict, obligations: a.obligations, clauses: a.clauses, summary: a.summary };
}
