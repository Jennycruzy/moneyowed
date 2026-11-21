// Click -> read the open email in this tab only (activeTab) -> check it with MONEY OWED.
var BASE = 'https://moneyowed.38-49-216-59.sslip.io';
var REGIONS = { aws: ['us-east-1'], gcp: ['us-central1'], azure: ['East US'] };
chrome.action.onClicked.addListener(function (tab) {
  chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['parse.js', 'content.js'] });
});
chrome.runtime.onMessage.addListener(function (msg, _sender, reply) {
  if (msg.type !== 'check') return false;
  var i = msg.input;
  fetch(BASE + '/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vendor: i.vendor, period: i.period, spend: i.spend, regions: REGIONS[i.vendor], evidence: 'none' }) })
    .then(function (r) { return r.json(); })
    .then(function (j) { reply(j.error ? { error: j.error } : { result: j, base: BASE }); })
    .catch(function (e) { reply({ error: e.message }); });
  return true;
});
