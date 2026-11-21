// Register (or dry-run) the SLA miner on the Telegraph Diamond.
// Usage: node scripts/register-miner.js [--send] [--update <registrationId>]   (update = new YAML/hash for an existing registration)
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createPublicClient, createWalletClient, http, parseAbi, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const DIAMOND = '0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b';
const USDC = '0xcc194e1a843B658526D0D5C431f670028582Ae17';
const RPC = process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
const YAML_URL = process.env.MINER_YAML_URL || 'https://moneyowed.38-49-216-59.sslip.io/miner.yaml';
const INTENTS = ['SLA_COMPLIANCE_GENERAL'];
const MIN_PRICE = 10000n;

const account = privateKeyToAccount(process.env.TELEGRAPH_PRIVATE_KEY);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function mint(address,uint256)']);
const reg = parseAbi([
  'function registerMiner(string,bytes32,address,uint256,string[]) returns (uint256)',
  'function updateMiner(uint256,string,bytes32,address,uint256,string[]) returns (uint256)',
  'function isCanonicalIntent(string) view returns (bool)',
  'event MinerRegistered(uint256 indexed registrationId, address indexed miner, string yamlUrl, bytes32 yamlHash, address feeAddress, uint256 minPriceUsdc, string[] supportedIntents)',
]);

const served = Buffer.from(await (await fetch(YAML_URL)).arrayBuffer());
const local = fs.readFileSync(new URL('../miner/moneyowed-sla.yaml', import.meta.url));
if (!served.equals(local)) throw new Error('served YAML differs from miner/moneyowed-sla.yaml; deploy first');
const hash = `0x${crypto.createHash('sha256').update(served).digest('hex')}`;
console.log('wallet', account.address, '\nyaml', YAML_URL, hash);
for (const i of INTENTS) console.log(i, 'canonical', await pub.readContract({ address: DIAMOND, abi: reg, functionName: 'isCanonicalIntent', args: [i] }));
console.log('ETH', Number(await pub.getBalance({ address: account.address })) / 1e18);
let bal = await pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [account.address] });
console.log('test USDC', Number(bal) / 1e6, 'allowance', Number(await pub.readContract({ address: USDC, abi: erc20, functionName: 'allowance', args: [account.address, DIAMOND] })) / 1e6);
const send = process.argv.includes('--send');
const ui = process.argv.indexOf('--update');
const oldId = ui > 0 ? BigInt(process.argv[ui + 1]) : null;
const fn = oldId != null ? 'updateMiner' : 'registerMiner';
const args = oldId != null ? [oldId, YAML_URL, hash, account.address, MIN_PRICE, INTENTS] : [YAML_URL, hash, account.address, MIN_PRICE, INTENTS];

if (send && oldId == null) {
  if (bal < 2_000_000n) { const tx = await wallet.writeContract({ address: USDC, abi: erc20, functionName: 'mint', args: [account.address, 5_000_000n] }); await pub.waitForTransactionReceipt({ hash: tx }); console.log('minted 5 test USDC', tx); }
  const tx = await wallet.writeContract({ address: USDC, abi: erc20, functionName: 'approve', args: [DIAMOND, 2_000_000n] });
  await pub.waitForTransactionReceipt({ hash: tx }); console.log('approved 2 test USDC for the bond', tx);
}
try {
  const { result } = await pub.simulateContract({ account, address: DIAMOND, abi: reg, functionName: fn, args });
  console.log('dry run OK, registrationId would be', result.toString());
} catch (e) { console.log('dry run reverted:', e.shortMessage || e.message); if (!send) process.exit(0); throw e; }
if (!send) process.exit(0);
const tx = await wallet.writeContract({ address: DIAMOND, abi: reg, functionName: fn, args });
const rcpt = await pub.waitForTransactionReceipt({ hash: tx });
for (const l of rcpt.logs) { try { const ev = decodeEventLog({ abi: reg, data: l.data, topics: l.topics }); if (ev.eventName === 'MinerRegistered' && ev.args.registrationId != null) console.log('registered, registrationId', ev.args.registrationId.toString()); } catch { /* other events */ } }
console.log('tx', tx, 'status', rcpt.status);
