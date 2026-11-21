// Reads an invoice email's text: which vendor, which billing period, how much. Plain rules, no model.
var MoneyOwedParse = (function () {
  var SENDERS = [
    ['jira-service-management', /jira service management/i, /atlassian\.com/i],
    ['confluence', /confluence/i, /atlassian\.com/i],
    ['bitbucket', /bitbucket/i, /atlassian\.com|bitbucket\.org/i],
    ['jira', /jira|atlassian/i, /atlassian\.com/i],
    ['github', /github/i, /github\.com/i],
    ['vercel', /vercel/i, /vercel\.com/i],
    ['digitalocean', /digitalocean/i, /digitalocean\.com/i],
    ['twilio', /twilio/i, /twilio\.com/i],
    ['linode', /linode|akamai/i, /linode\.com|akamai\.com/i],
    ['mailgun', /mailgun/i, /mailgun\.(com|net)|sinch\.com/i],
    ['sanity', /sanity/i, /sanity\.io/i],
    ['prisma', /prisma/i, /prisma\.io/i],
    ['mapbox', /mapbox/i, /mapbox\.com/i],
    ['buildkite', /buildkite/i, /buildkite\.com/i],
    ['aws', /amazon web services|\baws\b/i, /amazon\.com|amazonaws\.com/i],
    ['gcp', /google cloud/i, /google\.com/i],
    ['azure', /azure/i, /microsoft\.com|azure\.com/i],
  ];
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  var QUARTERLY = { github: true };

  function vendorOf(from, subject, body) {
    var text = subject + '\n' + body.slice(0, 4000);
    for (var i = 0; i < SENDERS.length; i++) {
      var s = SENDERS[i];
      if (s[2].test(from) && (s[1].test(text) || s[1].test(from))) return s[0];
    }
    for (var j = 0; j < SENDERS.length; j++) if (SENDERS[j][2].test(from)) return SENDERS[j][0];
    return null;
  }

  function periodOf(subject, body, vendor, today) {
    var text = subject + '\n' + body;
    var m = new RegExp('\\b(' + MONTHS.join('|') + '|' + MONTHS.map(function (x) { return x.slice(0, 3); }).join('|') + ')\\.?\\s+(?:\\d{1,2},?\\s+)?(20\\d\\d)\\b', 'i').exec(text);
    var y, mo;
    if (m) { y = +m[2]; mo = MONTHS.findIndex(function (x) { return x.indexOf(m[1].toLowerCase().slice(0, 3)) === 0; }); }
    else {
      var d = /\b(20\d\d)-(\d\d)-\d\d\b/.exec(text);
      if (d) { y = +d[1]; mo = +d[2] - 1; }
      else { var t = today || new Date(); y = t.getUTCFullYear(); mo = t.getUTCMonth() - 1; if (mo < 0) { mo = 11; y--; } }
    }
    if (QUARTERLY[vendor]) return y + '-Q' + (Math.floor(mo / 3) + 1);
    return y + '-' + String(mo + 1).padStart(2, '0');
  }

  function amountOf(body) {
    var pats = [/(total due|amount due|balance due|total amount|invoice total|amount charged|grand total)[^$\d]{0,40}(?:US)?\$\s?([\d,]+(?:\.\d{2})?)/i,
      /(?:^|[^a-z])(total)[^$\d]{0,40}(?:US)?\$\s?([\d,]+(?:\.\d{2})?)/i];
    for (var i = 0; i < pats.length; i++) { var m = pats[i].exec(body); if (m) return Number(m[2].replace(/,/g, '')); }
    var all = (body.match(/\$\s?[\d,]+\.\d{2}/g) || []).map(function (x) { return Number(x.replace(/[$,\s]/g, '')); });
    return all.length ? Math.max.apply(null, all) : null;
  }

  function parse(email, today) {
    var vendor = vendorOf(email.from || '', email.subject || '', email.body || '');
    if (!vendor) return null;
    return { vendor: vendor, period: periodOf(email.subject || '', email.body || '', vendor, today), spend: amountOf(email.body || ''), sample: /MONEY OWED SAMPLE/.test(email.body || '') };
  }
  return { parse: parse };
})();
if (typeof module !== 'undefined') module.exports = MoneyOwedParse;
