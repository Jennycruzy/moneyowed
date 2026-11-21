// Vendors whose public SLA offers service credits AND whose incident history can be read by machine.
export const VENDORS = [
  { vendor: 'github', name: 'GitHub', source: 'statuspage', host: 'www.githubstatus.com' },
  { vendor: 'jira', name: 'Jira', source: 'statuspage', host: 'jira-software.status.atlassian.com' },
  { vendor: 'confluence', name: 'Confluence', source: 'statuspage', host: 'confluence.status.atlassian.com' },
  { vendor: 'jira-service-management', name: 'Jira Service Management', source: 'statuspage', host: 'jira-service-management.status.atlassian.com' },
  { vendor: 'bitbucket', name: 'Bitbucket', source: 'statuspage', host: 'bitbucket.status.atlassian.com' },
  { vendor: 'vercel', name: 'Vercel', source: 'statuspage', host: 'www.vercel-status.com' },
  { vendor: 'digitalocean', name: 'DigitalOcean', source: 'statuspage', host: 'status.digitalocean.com' },
  { vendor: 'twilio', name: 'Twilio', source: 'statuspage', host: 'status.twilio.com' },
  { vendor: 'linode', name: 'Linode (Akamai Cloud)', source: 'statuspage', host: 'status.linode.com' },
  { vendor: 'mailgun', name: 'Mailgun', source: 'statuspage', host: 'status.mailgun.com' },
  { vendor: 'sanity', name: 'Sanity', source: 'statuspage', host: 'www.sanity-status.com' },
  { vendor: 'prisma', name: 'Prisma', source: 'statuspage', host: 'www.prisma-status.com' },
  { vendor: 'mapbox', name: 'Mapbox', source: 'statuspage', host: 'status.mapbox.com' },
  { vendor: 'buildkite', name: 'Buildkite', source: 'statuspage', host: 'buildkitestatus.com' },
  { vendor: 'aws', name: 'AWS', source: 'aws' },
  { vendor: 'gcp', name: 'Google Cloud', source: 'gcp' },
  { vendor: 'azure', name: 'Microsoft Azure', source: 'azure' },
];

export const NOT_COVERED = [
  { name: 'Cloudflare', reason: 'publishes a credit SLA but no machine-readable incident history' },
  { name: 'Supabase', reason: 'no machine-readable incident history' },
  { name: 'OpenAI', reason: 'no machine-readable incident history' },
  { name: 'HashiCorp', reason: 'no machine-readable incident history' },
  { name: 'Fastly', reason: 'publishes a credit SLA; its status history is not machine-readable' },
  { name: 'Grafana Cloud', reason: 'SLA page could not be fetched or archived for checking' },
  { name: 'Netlify, Sentry, Render, CircleCI, Dropbox, Box, Elastic, npm', reason: 'no public SLA with service credits found' },
  { name: 'Datadog, PagerDuty, Zoom, Slack, Okta, Heroku, MongoDB Atlas, SendGrid', reason: 'incident history not reachable as data' },
];

export function getVendor(id) {
  const v = VENDORS.find((x) => x.vendor === id);
  if (!v) throw Object.assign(new Error(`vendor "${id}" is not covered`), { code: 'VENDOR_NOT_COVERED' });
  return v;
}
