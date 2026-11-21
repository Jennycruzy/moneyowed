// Runs only when the user clicks the extension icon. Reads the open email, asks MONEY OWED, shows one banner.
(function () {
  function openEmail() {
    // Gmail: the open message. Elsewhere (e.g. the sample invoice page): the page itself.
    var bodies = document.querySelectorAll('div.a3s');
    var body = bodies.length ? bodies[bodies.length - 1].innerText : document.body.innerText;
    var subjEl = document.querySelector('h2.hP');
    var fromEl = document.querySelectorAll('span.gD[email]');
    var from = fromEl.length ? fromEl[fromEl.length - 1].getAttribute('email') : ((document.querySelector('[data-from]') || {}).dataset || {}).from || '';
    return { subject: subjEl ? subjEl.innerText : document.title, from: from, body: body };
  }
  function banner(html, tone) {
    var old = document.getElementById('moneyowed-banner');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'moneyowed-banner';
    el.setAttribute('style', 'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:380px;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f3ee;color:#14130f;border:1px solid #14130f;border-left:6px solid ' + (tone === 'owed' ? '#c8361a' : tone === 'ok' ? '#167244' : '#14130f') + ';padding:14px 16px;box-shadow:0 8px 24px rgba(0,0,0,.18)');
    el.innerHTML = html + '<button id="moneyowed-x" style="position:absolute;top:6px;right:8px;border:0;background:none;font-size:18px;cursor:pointer" aria-label="Close">×</button>';
    document.body.appendChild(el);
    document.getElementById('moneyowed-x').onclick = function () { el.remove(); };
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var head = '<div style="font-weight:700;letter-spacing:.04em;font-size:12px;margin-bottom:6px">MONEY OWED</div>';
  var email = openEmail();
  var p = MoneyOwedParse.parse(email);
  if (!p) { banner(head + 'This email is not from a vendor MONEY OWED covers.', ''); return; }
  banner(head + 'Checking ' + esc(p.vendor) + ' for ' + esc(p.period) + '…', '');
  chrome.runtime.sendMessage({ type: 'check', input: p }, function (r) {
    var tag = p.sample ? '<span style="background:#14130f;color:#f4f3ee;font-size:11px;padding:1px 5px;margin-left:6px">SAMPLE</span>' : '';
    if (!r || r.error) { banner(head + 'Could not check: ' + esc(r ? r.error : 'no answer') + tag, ''); return; }
    var c = r.result, base = r.base;
    var link = '<a href="' + base + (c.code === 'OWED' ? '/claim/' : '/check/') + esc(c.id) + '" target="_blank" style="color:#c8361a;font-weight:700">' + (c.code === 'OWED' ? 'Open claim' : 'See the check') + ' →</a>';
    var s = c.services.find(function (x) { return x.credit_pct > 0; }) || c.services[0];
    var bill = p.spend ? 'This invoice is $' + p.spend.toLocaleString('en-US') + '. ' : '';
    if (c.code === 'OWED') {
      var amt = c.credit_usd_total != null ? '$' + c.credit_usd_total.toLocaleString('en-US') + ' (' + s.credit_pct + '%)' : s.credit_pct + '% of the fee';
      banner(head + tag + '<div style="font-size:16px;margin-bottom:6px">' + bill + '<b>You are owed ' + amt + '</b> for ' + esc(c.period) + '. Claim before paying.</div><div style="font-size:13px">' + esc(s.service) + ': ' + s.uptime_pct + '% uptime against the promised ' + s.threshold_pct + '%. ' + (c.days_left != null ? c.days_left + ' days left to claim.' : '') + '</div><div style="margin-top:8px">' + link + '</div>', 'owed');
    } else if (c.code === 'WINDOW_CLOSED') {
      banner(head + tag + bill + 'A ' + s.credit_pct + '% credit was owed for ' + esc(c.period) + ', but the claim window closed ' + esc(String(c.deadline).slice(0, 10)) + '.<div style="margin-top:8px">' + link + '</div>', 'owed');
    } else if (c.code === 'PERIOD_OPEN') {
      banner(head + tag + esc(c.period) + ' is not over yet: ' + s.uptime_pct + '% so far against ' + s.threshold_pct + '%.<div style="margin-top:8px">' + link + '</div>', '');
    } else {
      banner(head + tag + bill + 'No credit owed for ' + esc(c.period) + ': ' + esc(s.service) + ' was up ' + s.uptime_pct + '% against the promised ' + s.threshold_pct + '%.<div style="margin-top:8px">' + link + '</div>', 'ok');
    }
  });
})();
