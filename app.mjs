import express from 'express';
import * as cheerio from 'cheerio';
import {isIP} from 'node:net';
import {promises as dns} from 'node:dns';

const PORT = Number(process.env.PORT || 3000);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

const app = express();

// Parse a dotted-decimal IPv4 string into its four bytes, or null if malformed.
function ipv4ToBytes(ip) {
  const parts = ip.split('.');

  if (parts.length !== 4) {
    return null;
  }

  const bytes = [];

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }

    const octet = Number(part);

    if (octet > 255) {
      return null;
    }

    bytes.push(octet);
  }

  return bytes;
}

// Expand an IPv6 string (incl. "::" compression, zone id and embedded IPv4) into
// its 16 bytes, or null if it cannot be parsed.
function ipv6ToBytes(ip) {
  let str = ip.toLowerCase();

  const zoneIdx = str.indexOf('%');

  if (zoneIdx !== -1) {
    str = str.slice(0, zoneIdx);
  }

  // Pull off a trailing embedded IPv4 (e.g. "::ffff:192.168.0.1").
  let tail = [];

  if (str.includes('.')) {
    const colonIdx = str.lastIndexOf(':');

    if (colonIdx === -1) {
      return null;
    }

    const v4 = ipv4ToBytes(str.slice(colonIdx + 1));

    if (!v4) {
      return null;
    }

    tail = v4;
    str = str.slice(0, colonIdx);
  }

  const halves = str.split('::');

  if (halves.length > 2) {
    return null;
  }

  const toBytes = (segment) => {
    if (segment === '') {
      return [];
    }

    const bytes = [];

    for (const group of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return null;
      }

      const value = parseInt(group, 16);

      bytes.push((value >> 8) & 0xff, value & 0xff);
    }

    return bytes;
  };

  const head = toBytes(halves[0]);
  const back = halves.length === 2 ? toBytes(halves[1]) : [];

  if (head === null || back === null) {
    return null;
  }

  let bytes;

  if (halves.length === 2) {
    const zeros = 16 - (head.length + back.length + tail.length);

    if (zeros < 0) {
      return null;
    }

    bytes = [...head, ...new Array(zeros).fill(0), ...back, ...tail];
  } else {
    bytes = [...head, ...tail];
  }

  return bytes.length === 16 ? bytes : null;
}

function isPrivateIPv4Bytes([a, b]) {
  return (
    a === 0 ||                       // 0.0.0.0/8    "this" network
    a === 10 ||                      // 10.0.0.0/8   private
    a === 127 ||                     // 127.0.0.0/8  loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) ||      // 169.254.0.0/16 link-local
    (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12 private
    (a === 192 && b === 168)         // 192.168.0.0/16 private
  );
}

function isPrivateIPv6Bytes(bytes) {
  // IPv4-mapped ::ffff:0:0/96 — apply the IPv4 rules to the embedded address.
  const isV4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;

  if (isV4Mapped) {
    return isPrivateIPv4Bytes(bytes.slice(12));
  }

  // :: (unspecified) and ::1 (loopback)
  if (bytes.slice(0, 15).every((byte) => byte === 0)) {
    return bytes[15] === 0 || bytes[15] === 1;
  }

  // fc00::/7 (unique local) — first byte 0xfc or 0xfd.
  if ((bytes[0] & 0xfe) === 0xfc) {
    return true;
  }

  // fe80::/10 (link-local).
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
    return true;
  }

  return false;
}

// True if `ip` (a literal IPv4/IPv6 address) is in a private/reserved range.
// Anything that is not a recognisable IP is treated as unsafe (blocked).
function isPrivateAddress(ip) {
  const family = isIP(ip);

  if (family === 4) {
    return isPrivateIPv4Bytes(ipv4ToBytes(ip));
  }

  if (family === 6) {
    const bytes = ipv6ToBytes(ip);

    return bytes === null ? true : isPrivateIPv6Bytes(bytes);
  }

  return true;
}

// Read the response body as text, aborting if it exceeds `maxBytes`.
async function readCappedText(response, maxBytes) {
  const reader = response.body?.getReader();

  if (!reader) {
    return await response.text();
  }

  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let text = '';

  while (true) {
    const {done, value} = await reader.read();

    if (done) {
      break;
    }

    received += value.byteLength;

    if (received > maxBytes) {
      await reader.cancel();
      throw {code: 413, message: 'Response too large'};
    }

    text += decoder.decode(value, {stream: true});
  }

  return text + decoder.decode();
}

app.get('/', async ({query: {url: requestedUrl}}, response) => {
  if (!requestedUrl || !URL.canParse(requestedUrl)) {
    const error = {
      code: 400,
      message: 'Invalid requested',
    }

    console.error(error.code, error.message);

    response.status(error.code).end(error.message);

    return;
  }

  console.log(requestedUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const parsed = new URL(requestedUrl);

    // 1. Scheme allowlist — only http(s) may reach fetch.
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw {code: 400, message: 'Unsupported scheme'};
    }

    // 2. Block private/reserved targets. For a literal-IP host we check it
    // directly; otherwise we resolve every address and reject if any is
    // private. NOTE: this resolve-then-fetch has a DNS-rebinding (TOCTOU) gap —
    // the name could re-resolve to an internal IP between this check and the
    // fetch below. Acceptable for this undeployed utility; pinning to the
    // resolved IP would close it but breaks TLS SNI / virtual hosting.
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    let addresses;

    if (isIP(host)) {
      addresses = [host];
    } else {
      addresses = (await dns.lookup(host, {all: true})).map(({address}) => address);
    }

    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw {code: 403, message: 'Forbidden target host'};
    }

    // 3. Do not auto-follow redirects: a 3xx could point at an internal host.
    const upstream = await fetch(requestedUrl, {
      redirect: 'manual',
      signal: controller.signal,
    });

    if (upstream.type === 'opaqueredirect' || (upstream.status >= 300 && upstream.status < 400)) {
      throw {code: 403, message: 'Redirect not followed'};
    }

    if (!upstream.ok) {
      throw {code: upstream.status, message: upstream.statusText};
    }

    // 4. Reject oversized bodies — declared, then enforced while streaming.
    const declaredLength = Number(upstream.headers.get('content-length'));

    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      throw {code: 413, message: 'Response too large'};
    }

    const body = await readCappedText(upstream, MAX_BODY_BYTES);

    const $ = cheerio.load(body);
    const $title = $('head > title');
    const $description = $('meta[name="description"]');

    const data = {
      title: $title && $title.text().trim() || '',
      description: $description && $description.attr('content') && $description.attr('content').trim() || '',
    };

    console.log(data);

    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(JSON.stringify(data));
  } catch (error) {
    const {code = 500, message = 'Server error'} = error ?? {};
    // Upstream/DNS/abort failures can carry non-HTTP codes (e.g. 'ENOTFOUND',
    // AbortError.code === 20); clamp to a valid HTTP status.
    const httpCode = Number.isInteger(code) && code >= 100 && code <= 599 ? code : 500;

    console.error(code, message);

    response.status(httpCode).end(message);
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening at port ${PORT}...`);
});
