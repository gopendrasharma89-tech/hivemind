// SSRF guard for outbound requests (webhooks).
// Rejects URLs that resolve to private, loopback, link-local, or otherwise
// reserved address space — preventing agents from using webhooks to reach
// cloud metadata endpoints (169.254.169.254), internal services, or localhost.
const dns = require('dns').promises;
const net = require('net');

function ipIsBlocked(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    const [a, b] = p;
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 10) return true;                      // private
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;        // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
    if (a === 192 && b === 0) return true;          // 192.0.0.0/24 (IETF)
    if (a >= 224) return true;                      // multicast / reserved / broadcast
    return false;
  }
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase();
    if (lo === '::1' || lo === '::') return true;   // loopback / unspecified
    if (lo.startsWith('fe80')) return true;         // link-local
    if (lo.startsWith('fc') || lo.startsWith('fd')) return true; // unique-local
    const m = lo.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (m) return ipIsBlocked(m[1]);
    return false;
  }
  return true; // not a valid IP → block to be safe
}

function parse(raw) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'Invalid URL' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'Only http(s) URLs are allowed' };
  if (u.username || u.password) return { ok: false, error: 'Credentials in URL are not allowed' };
  return { ok: true, url: u };
}

// Async: resolves DNS and validates every resolved address.
async function assertSafeUrl(raw) {
  const p = parse(raw);
  if (!p.ok) return p;
  let host = p.url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|localhost\.localdomain|ip6-localhost)$/i.test(host)) {
    return { ok: false, error: 'Target host is not allowed' };
  }
  if (net.isIP(host)) {
    return ipIsBlocked(host)
      ? { ok: false, error: 'Target resolves to a private or reserved address' }
      : { ok: true };
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { return { ok: false, error: 'Target host could not be resolved' }; }
  if (!addrs || addrs.length === 0) return { ok: false, error: 'Target host could not be resolved' };
  for (const a of addrs) {
    if (ipIsBlocked(a.address)) return { ok: false, error: 'Target resolves to a private or reserved address' };
  }
  return { ok: true };
}

module.exports = { assertSafeUrl, ipIsBlocked };
