// Small helpers for the app pages. Everything works without it; this only makes forms and lists easier to use.
(function () {
  document.documentElement.classList.add('js');

  // Check form: plans for the chosen vendor, the right period hint, regions only for clouds.
  var v = document.getElementById('f-vendor');
  if (v) {
    var plan = document.getElementById('f-plan'), hint = document.getElementById('f-period-hint'), per = document.getElementById('f-period');
    var reg = document.getElementById('f-regions-wrap');
    var now = new Date(), y = now.getUTCFullYear(), m = now.getUTCMonth();
    var lastMonth = (m === 0 ? y - 1 : y) + '-' + ('0' + (m === 0 ? 12 : m)).slice(-2);
    var q = Math.floor(m / 3), lastQ = q === 0 ? (y - 1) + '-Q4' : y + '-Q' + q;
    function sync() {
      var o = v.options[v.selectedIndex];
      var plans = JSON.parse(o.getAttribute('data-plans') || '[]');
      plan.innerHTML = plans.map(function (p) { return '<option value="' + p[0] + '">' + p[1].replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</option>'; }).join('');
      plan.parentNode.style.display = plans.length > 1 ? '' : 'none';
      var quarterly = o.getAttribute('data-period') === 'quarter';
      per.placeholder = quarterly ? lastQ : lastMonth;
      hint.textContent = quarterly ? 'This SLA is measured per quarter, written like ' + lastQ + '.' : 'A month, written like ' + lastMonth + '.';
      reg.classList.toggle('hidden', !o.getAttribute('data-region'));
    }
    v.addEventListener('change', sync); sync();
  }

  // Record: filter rows by vendor.
  var f = document.querySelector('.filter');
  if (f) {
    var rows = document.querySelectorAll(f.getAttribute('data-filter') + ' tbody tr');
    f.addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      var want = b.getAttribute('data-v');
      f.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('on', c === b); });
      rows.forEach(function (r) { r.style.display = !want || r.getAttribute('data-v') === want ? '' : 'none'; });
    });
  }

  // Claim: copy the letter.
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var t = document.querySelector(btn.getAttribute('data-copy'));
      if (!t || !navigator.clipboard) return;
      navigator.clipboard.writeText(t.innerText).then(function () { var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = o; }, 1600); });
    });
  });
})();
