import { stringify } from 'yaml';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INPUT_CHARS = 500_000;
const MAX_LINKS = 500;
const MAX_LINE_CHARS = 8_192;
const DIRECT_GROUP = '直连';
const ADS_GROUP = '广告拦截';
const RESERVED_NAMES = new Set([
  'global', 'proxy', 'direct', 'reject', 'reject-drop', 'compatible', 'pass', 'pass-rule',
  DIRECT_GROUP, ADS_GROUP,
]);

export const SAMPLE_LINKS = [
  'vless://11111111-1111-4111-8111-111111111111@example.com:443?encryption=none&security=tls&sni=example.com&type=ws&host=cdn.example.com&path=%2Fedge#示例-VLESS',
  'vmess://eyJhZGQiOiJ2bWVzcy5leGFtcGxlLmNvbSIsImFpZCI6IjAiLCJob3N0IjoiY2RuLmV4YW1wbGUuY29tIiwiaWQiOiIyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIiLCJuZXQiOiJ3cyIsInBhdGgiOiIvZWRnZSIsInBvcnQiOiI0NDMiLCJwcyI6Iua1i-ivleeUqC1WTWVzcyIsInNjeSI6ImF1dG8iLCJ0bHMiOiJ0bHMiLCJ2IjoiMiJ9',
  'trojan://example-password@example.org:443?sni=example.org#示例-Trojan',
  'ss://YWVzLTI1Ni1nY206ZXhhbXBsZS1wYXNzd29yZA==@ss.example.net:8388#示例-SS',
].join('\n');

class LinkError extends Error {}

function fail(message) {
  throw new LinkError(message);
}

function decodeBase64(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    fail('Base64 编码无效');
  }
  const unpadded = normalized.replace(/=+$/, '');
  const padded = unpadded + '='.repeat((4 - unpadded.length % 4) % 4);
  try {
    const binary = atob(padded);
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch {
    fail('Base64 或 UTF-8 编码无效');
  }
}

function getFragmentName(url) {
  if (!url.hash) return '';
  try {
    return decodeURIComponent(url.hash.slice(1)).trim();
  } catch {
    fail('名称中的 URL 编码无效');
  }
}

function urlWithProtocol(raw, protocol) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    const rawAuthority = raw.slice(raw.indexOf('://') + 3).split(/[/?#]/, 1)[0];
    const endpoint = rawAuthority.slice(rawAuthority.lastIndexOf('@') + 1);
    const portMatch = endpoint.startsWith('[')
      ? endpoint.match(/^\[[^\]]+\]:(.*)$/)
      : endpoint.match(/^[^:]+:(.*)$/);
    if (portMatch) strictPort(portMatch[1]);
    fail('链接格式无效');
  }
  if (url.protocol !== `${protocol}:`) fail('协议标记无效');
  if (url.username === '' || url.hostname === '') fail('缺少必要的认证信息或服务器地址');
  if (url.password) fail('认证信息格式无效');
  return url;
}

function strictPort(value, label = '端口') {
  if (!/^\d+$/.test(String(value ?? ''))) fail(`${label}必须是 1 到 65535 的整数`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail(`${label}必须是 1 到 65535 的整数`);
  }
  return port;
}

function validateHost(host) {
  const normalized = host?.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!normalized || /[\s/@?#]/.test(normalized)) fail('服务器地址无效');
  return normalized;
}

function parseQuery(url, allowed, aliases = {}) {
  const result = new Map();
  for (const [rawKey, value] of url.searchParams) {
    const key = aliases[rawKey] ?? rawKey;
    if (!allowed.has(key)) fail('包含不支持的参数');
    if (result.has(key)) fail('参数重复');
    result.set(key, value);
  }
  return result;
}

function queryBool(params, key, defaultValue = false) {
  if (!params.has(key)) return defaultValue;
  const value = params.get(key).toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no'].includes(value)) return false;
  fail(`参数 ${key} 必须是布尔值`);
}

function csv(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function transportOptions(proxy, network, values) {
  if (!['tcp', 'ws', 'grpc'].includes(network)) fail('不支持该传输方式');
  if (network === 'ws') {
    if (values.serviceName) fail('WS 传输不能包含 gRPC serviceName');
    proxy.network = 'ws';
    const wsOpts = {};
    if (values.path) wsOpts.path = values.path;
    if (values.host) wsOpts.headers = { Host: values.host };
    if (values.earlyData) wsOpts['max-early-data'] = Number(values.earlyData);
    if (values.earlyDataHeader) wsOpts['early-data-header-name'] = values.earlyDataHeader;
    proxy['ws-opts'] = wsOpts;
  } else if (network === 'grpc') {
    if (values.path || values.host || values.earlyData || values.earlyDataHeader) {
      fail('gRPC 传输包含不兼容的 WS 参数');
    }
    proxy.network = 'grpc';
    proxy['grpc-opts'] = {};
    if (values.serviceName) proxy['grpc-opts']['grpc-service-name'] = values.serviceName;
  } else if (values.path || values.host || values.serviceName || values.earlyData || values.earlyDataHeader) {
    fail('TCP 传输包含不兼容的 WS 或 gRPC 参数');
  }
}

function tlsOptions(proxy, { enabled, servername, insecure, fingerprint, alpn }) {
  if (!enabled) {
    if (servername || insecure || fingerprint || alpn?.length) fail('指定了 TLS 参数，但 security 未启用 TLS');
    return;
  }
  proxy.tls = true;
  if (servername) proxy.servername = servername;
  if (insecure) proxy['skip-cert-verify'] = true;
  if (fingerprint) proxy['client-fingerprint'] = fingerprint;
  if (alpn?.length) proxy.alpn = alpn;
}

function parseVless(raw) {
  const url = urlWithProtocol(raw, 'vless');
  const userId = decodeURIComponent(url.username);
  if (!UUID_RE.test(userId)) fail('VLESS UUID 无效');
  const allowed = new Set([
    'encryption', 'security', 'type', 'sni', 'servername', 'fp', 'alpn',
    'allowInsecure', 'insecure', 'host', 'path', 'serviceName', 'pbk', 'sid',
    'flow', 'headerType', 'ed', 'eh', 'spx',
  ]);
  const params = parseQuery(url, allowed, { servername: 'sni', insecure: 'allowInsecure' });
  if (params.has('encryption') && params.get('encryption') !== 'none') fail('VLESS 仅支持 encryption=none');
  if (params.has('headerType') && params.get('headerType') !== 'none') fail('VLESS 暂不支持该 TCP headerType');

  const network = params.get('type') || 'tcp';
  const security = params.get('security') || 'none';
  if (!['none', 'tls', 'reality'].includes(security)) fail('不支持该 VLESS security 模式');
  if (security !== 'reality' && (params.has('pbk') || params.has('sid') || params.has('spx'))) {
    fail('VLESS pbk、sid 和 spx 仅支持 security=reality');
  }
  if (params.has('flow') && security === 'none') fail('VLESS flow 需要 TLS 或 Reality');
  const name = getFragmentName(url);
  const proxy = {
    name,
    type: 'vless',
    server: validateHost(url.hostname),
    port: strictPort(url.port),
    uuid: userId,
    udp: true,
  };
  if (params.has('flow')) {
    const flow = params.get('flow');
    if (!['xtls-rprx-vision'].includes(flow)) fail('不支持该 VLESS flow');
    proxy.flow = flow;
  }
  if (security === 'reality') {
    if (!params.get('pbk')) fail('Reality 缺少必需的 pbk');
    // Xray's spx controls fallback crawling; Mihomo reality-opts has no matching field.
    proxy.tls = true;
    proxy['client-fingerprint'] = params.get('fp') || 'chrome';
    proxy['reality-opts'] = { 'public-key': params.get('pbk') };
    if (params.get('sid')) proxy['reality-opts']['short-id'] = params.get('sid');
    if (params.get('sni')) proxy.servername = params.get('sni');
    if (params.has('allowInsecure') && queryBool(params, 'allowInsecure')) {
      fail('Reality 不支持跳过证书验证');
    }
    if (params.has('alpn')) proxy.alpn = csv(params.get('alpn'));
  } else {
    tlsOptions(proxy, {
      enabled: security === 'tls',
      servername: params.get('sni'),
      insecure: queryBool(params, 'allowInsecure'),
      fingerprint: params.get('fp'),
      alpn: params.has('alpn') ? csv(params.get('alpn')) : [],
    });
  }
  transportOptions(proxy, network, {
    path: params.get('path'),
    host: params.get('host'),
    serviceName: params.get('serviceName'),
    earlyData: params.get('ed'),
    earlyDataHeader: params.get('eh'),
  });
  if (params.has('ed') && (!/^\d+$/.test(params.get('ed')) || Number(params.get('ed')) > 65535)) {
    fail('参数 ed 必须是 0 到 65535 的整数');
  }
  return proxy;
}

function parseVmess(raw) {
  const encoded = raw.slice('vmess://'.length).split('#', 1)[0];
  let data;
  try {
    data = JSON.parse(decodeBase64(encoded));
  } catch (error) {
    if (error instanceof LinkError) throw error;
    fail('VMess Base64 内容不是有效 JSON');
  }
  if (!data || Array.isArray(data) || typeof data !== 'object') fail('VMess 内容格式无效');
  const supported = new Set([
    'v', 'ps', 'add', 'port', 'id', 'aid', 'scy', 'net', 'type', 'host',
    'path', 'tls', 'sni', 'alpn', 'fp', 'allowInsecure', 'serviceName',
  ]);
  for (const key of Object.keys(data)) if (!supported.has(key)) fail('包含不支持的 VMess 字段');
  for (const key of ['add', 'port', 'id']) {
    if (data[key] === undefined || data[key] === '') fail(`VMess 缺少必需字段 ${key}`);
  }
  if (!UUID_RE.test(String(data.id))) fail('VMess UUID 无效');
  const aid = Number(data.aid ?? 0);
  if (!Number.isInteger(aid) || aid < 0 || aid > 65535) fail('VMess aid 必须是 0 到 65535 的整数');
  const cipher = String(data.scy || 'auto');
  if (!['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305', 'aes-128-cfb'].includes(cipher)) {
    fail('不支持该 VMess 加密方式');
  }
  const network = String(data.net || 'tcp').toLowerCase();
  const tlsValue = String(data.tls || '').toLowerCase();
  if (!['', 'none', 'tls', '1', 'true'].includes(tlsValue)) fail('不支持该 VMess TLS 设置');
  if (data.type && !['none', 'tcp'].includes(String(data.type).toLowerCase())) {
    fail('不支持该 VMess TCP header type');
  }
  const proxy = {
    name: typeof data.ps === 'string' ? data.ps.trim() : '',
    type: 'vmess',
    server: validateHost(String(data.add)),
    port: strictPort(data.port),
    uuid: data.id,
    alterId: aid,
    cipher,
    udp: true,
  };
  tlsOptions(proxy, {
    enabled: ['tls', '1', 'true'].includes(tlsValue),
    servername: data.sni,
    insecure: data.allowInsecure === true || data.allowInsecure === 1 || data.allowInsecure === '1',
    fingerprint: data.fp,
    alpn: data.alpn ? csv(String(data.alpn)) : [],
  });
  if (data.allowInsecure !== undefined && ![true, false, 0, 1, '0', '1'].includes(data.allowInsecure)) {
    fail('VMess allowInsecure 必须是布尔值');
  }
  transportOptions(proxy, network, {
    path: data.path,
    host: data.host,
    serviceName: data.serviceName,
  });
  return proxy;
}

function parseTrojan(raw) {
  const url = urlWithProtocol(raw, 'trojan');
  const password = decodeURIComponent(url.username);
  if (!password) fail('Trojan 缺少密码');
  const params = parseQuery(url, new Set([
    'security', 'type', 'sni', 'peer', 'fp', 'alpn', 'allowInsecure',
    'host', 'path', 'serviceName', 'ed', 'eh',
  ]), { peer: 'sni' });
  if (params.has('security') && params.get('security') !== 'tls') {
    fail('不支持该 Trojan security 模式');
  }
  const proxy = {
    name: getFragmentName(url),
    type: 'trojan',
    server: validateHost(url.hostname),
    port: strictPort(url.port),
    password,
    udp: true,
  };
  tlsOptions(proxy, {
    enabled: params.get('security') !== 'none',
    servername: params.get('sni'),
    insecure: queryBool(params, 'allowInsecure'),
    fingerprint: params.get('fp'),
    alpn: params.has('alpn') ? csv(params.get('alpn')) : [],
  });
  transportOptions(proxy, params.get('type') || 'tcp', {
    path: params.get('path'),
    host: params.get('host'),
    serviceName: params.get('serviceName'),
    earlyData: params.get('ed'),
    earlyDataHeader: params.get('eh'),
  });
  return proxy;
}

function parsePlugin(value) {
  const [pluginName, ...parts] = value.split(';');
  const options = new Map();
  for (const part of parts) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const key = separator < 0 ? part : part.slice(0, separator);
    const option = separator < 0 ? 'true' : part.slice(separator + 1);
    if (options.has(key)) fail('SS 插件参数重复');
    options.set(key, option);
  }
  if (pluginName === 'simple-obfs' || pluginName === 'obfs-local') {
    for (const key of options.keys()) if (!['obfs', 'obfs-host'].includes(key)) fail('包含不支持的 simple-obfs 参数');
    const mode = options.get('obfs') || 'http';
    if (!['http', 'tls'].includes(mode)) fail('不支持该 simple-obfs 模式');
    const pluginOpts = { mode };
    if (options.has('obfs-host')) pluginOpts.host = options.get('obfs-host');
    return { plugin: 'obfs', 'plugin-opts': pluginOpts };
  }
  if (pluginName === 'v2ray-plugin') {
    for (const key of options.keys()) if (!['mode', 'tls', 'host', 'path', 'mux'].includes(key)) fail('包含不支持的 v2ray-plugin 参数');
    const mode = options.get('mode') || 'websocket';
    if (mode !== 'websocket') fail('不支持该 v2ray-plugin 模式');
    const pluginOpts = { mode };
    if (options.get('tls') === 'true') pluginOpts.tls = true;
    else if (options.has('tls') && options.get('tls') !== 'false') fail('v2ray-plugin tls 必须是布尔值');
    if (options.has('host')) pluginOpts.host = options.get('host');
    if (options.has('path')) pluginOpts.path = options.get('path');
    if (options.has('mux')) {
      if (!['true', 'false'].includes(options.get('mux'))) fail('v2ray-plugin mux 必须是布尔值');
      pluginOpts.mux = options.get('mux') === 'true';
    }
    return { plugin: 'v2ray-plugin', 'plugin-opts': pluginOpts };
  }
  fail('不支持该 SS 插件');
}

function parseSs(raw) {
  let rest = raw.slice('ss://'.length);
  const hashAt = rest.indexOf('#');
  let fragment = '';
  if (hashAt >= 0) {
    fragment = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }
  let query = '';
  const queryAt = rest.indexOf('?');
  if (queryAt >= 0) {
    query = rest.slice(queryAt + 1);
    rest = rest.slice(0, queryAt);
  }

  let method;
  let password;
  let authority;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    let userInfo = rest.slice(0, at);
    authority = rest.slice(at + 1);
    try {
      userInfo = decodeURIComponent(userInfo);
    } catch {
      fail('SS 认证信息 URL 编码无效');
    }
    if (!userInfo.includes(':')) userInfo = decodeBase64(userInfo);
    const colon = userInfo.indexOf(':');
    if (colon <= 0 || colon === userInfo.length - 1) fail('SS 认证信息必须包含 method:password');
    method = userInfo.slice(0, colon);
    password = userInfo.slice(colon + 1);
  } else {
    const decoded = decodeBase64(rest);
    const decodedAt = decoded.lastIndexOf('@');
    if (decodedAt >= 0) {
      const userInfo = decoded.slice(0, decodedAt);
      authority = decoded.slice(decodedAt + 1);
      const colon = userInfo.indexOf(':');
      if (colon <= 0 || colon === userInfo.length - 1) fail('SS 认证信息必须包含 method:password');
      method = userInfo.slice(0, colon);
      password = userInfo.slice(colon + 1);
    } else {
      const colon = decoded.indexOf(':');
      if (colon <= 0) fail('SS 内容必须包含 method:password@server:port');
      const authAndHost = decoded.slice(colon + 1);
      const serverAt = authAndHost.lastIndexOf('@');
      if (serverAt < 0) fail('SS 内容缺少服务器地址');
      method = decoded.slice(0, colon);
      password = authAndHost.slice(0, serverAt);
      authority = authAndHost.slice(serverAt + 1);
    }
  }
  if (!method || !password) fail('SS 缺少加密方式或密码');
  let endpoint;
  try {
    endpoint = new URL(`ss://${authority}`);
  } catch {
    fail('SS 服务器地址无效');
  }
  if (!endpoint.hostname) fail('SS 缺少服务器地址');
  const proxy = {
    name: fragment ? (() => {
      try { return decodeURIComponent(fragment); } catch { fail('名称中的 URL 编码无效'); }
    })() : '',
    type: 'ss',
    server: validateHost(endpoint.hostname),
    port: strictPort(endpoint.port),
    cipher: method,
    password,
    udp: true,
  };
  if (query) {
    const params = new URLSearchParams(query);
    let pluginSeen = false;
    for (const [key, value] of params) {
      if (key !== 'plugin') fail('包含不支持的 SS 参数');
      if (pluginSeen) fail('SS plugin 参数重复');
      pluginSeen = true;
      Object.assign(proxy, parsePlugin(value));
    }
  }
  return proxy;
}

function uniqueName(proxy, used) {
  const base = proxy.name || `${proxy.type.toUpperCase()} ${proxy.server}:${proxy.port}`;
  let candidate = base;
  let suffix = 2;
  while (RESERVED_NAMES.has(candidate.toLowerCase()) || used.has(candidate.toLowerCase())) {
    candidate = `${base} (${suffix++})`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function parseLinks(text) {
  const input = String(text ?? '');
  const candidateLines = input.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    return trimmed ? [{ line: index + 1, value: trimmed }] : [];
  });
  const errors = [];
  if (input.length > MAX_INPUT_CHARS) {
    return {
      nodes: [],
      errors: [{ line: 1, message: `输入超过 ${MAX_INPUT_CHARS} 个字符的限制` }],
      total: candidateLines.length,
    };
  }
  const nodes = [];
  const usedNames = new Set();
  for (const [index, entry] of candidateLines.entries()) {
    if (index >= MAX_LINKS) {
      if (index === MAX_LINKS) errors.push({ line: entry.line, message: `最多支持 ${MAX_LINKS} 条链接` });
      continue;
    }
    if (entry.value.length > MAX_LINE_CHARS) {
      errors.push({ line: entry.line, message: `单条链接不能超过 ${MAX_LINE_CHARS} 个字符` });
      continue;
    }
    try {
      if (/%(?![0-9a-fA-F]{2})/.test(entry.value)) fail('URL 编码无效');
      const scheme = entry.value.slice(0, entry.value.indexOf('://')).toLowerCase();
      let node;
      if (scheme === 'vless') node = parseVless(entry.value);
      else if (scheme === 'vmess') node = parseVmess(entry.value);
      else if (scheme === 'trojan') node = parseTrojan(entry.value);
      else if (scheme === 'ss') node = parseSs(entry.value);
      else fail('仅支持 vless、vmess、trojan、ss 链接');
      node.name = uniqueName(node, usedNames);
      nodes.push(node);
    } catch (error) {
      errors.push({
        line: entry.line,
        message: error instanceof LinkError ? error.message : '链接格式无效',
      });
    }
  }
  return { nodes, errors, total: candidateLines.length };
}

function makeProvider(url, behavior, path) {
  return {
    type: 'http',
    behavior,
    format: 'mrs',
    url,
    path,
    interval: 86400,
    proxy: 'PROXY',
  };
}

export function buildConfig(nodes, { blockAds = true, directChina = true, name = '我的订阅' } = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new TypeError('至少需要一个有效节点才能生成配置');
  const proxies = nodes.map((node) => ({ ...node }));
  for (const [index, node] of proxies.entries()) {
    if (!node || typeof node.name !== 'string' || !node.name.trim()) {
      throw new TypeError(`第 ${index + 1} 个节点缺少名称`);
    }
    if (!['vless', 'vmess', 'trojan', 'ss'].includes(node.type)) {
      throw new TypeError(`第 ${index + 1} 个节点类型无效`);
    }
  }
  const nodeNames = proxies.map((node) => node.name);
  if (new Set(nodeNames.map((value) => value.toLowerCase())).size !== nodeNames.length
    || nodeNames.some((value) => RESERVED_NAMES.has(value.toLowerCase()))) {
    throw new TypeError('节点名称必须唯一，且不能占用策略组名或 Mihomo 内置名称');
  }

  const providers = {
    private: makeProvider(
      'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/private.mrs',
      'domain',
      './ruleset/private.mrs',
    ),
  };
  if (directChina) {
    providers.cn = makeProvider(
      'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.mrs',
      'domain',
      './ruleset/cn.mrs',
    );
    providers.cn_ip = makeProvider(
      'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geoip/cn.mrs',
      'ipcidr',
      './ruleset/cn_ip.mrs',
    );
  }
  if (blockAds) {
    providers.ads = makeProvider(
      'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/category-ads-all.mrs',
      'domain',
      './ruleset/ads.mrs',
    );
  }
  const rules = [];
  if (blockAds) rules.push(`RULE-SET,ads,${ADS_GROUP}`);
  rules.push(
    'RULE-SET,private,DIRECT',
    'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,100.64.0.0/10,DIRECT,no-resolve',
    'IP-CIDR6,::1/128,DIRECT,no-resolve',
    'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
    'IP-CIDR6,fe80::/10,DIRECT,no-resolve',
  );
  if (directChina) rules.push(`RULE-SET,cn,${DIRECT_GROUP}`, `RULE-SET,cn_ip,${DIRECT_GROUP}`);
  rules.push('MATCH,PROXY');

  const dns = {
    enable: true,
    listen: '127.0.0.1:1053',
    ipv6: false,
    'enhanced-mode': 'redir-host',
    'default-nameserver': ['223.5.5.5', '119.29.29.29'],
    nameserver: ['https://1.1.1.1/dns-query#PROXY', 'https://8.8.8.8/dns-query#PROXY'],
    'proxy-server-nameserver': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
  };
  if (directChina) {
    dns['nameserver-policy'] = {
      'rule-set:cn': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
    };
  }

  const config = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'warning',
    'find-process-mode': 'strict',
    proxies,
    'proxy-groups': [
      {
        name: 'PROXY',
        type: 'select',
        proxies: [...nodeNames, 'DIRECT'],
      },
      ...(directChina ? [{
        name: DIRECT_GROUP,
        type: 'select',
        proxies: ['DIRECT', 'PROXY', ...nodeNames],
      }] : []),
      ...(blockAds ? [{
        name: ADS_GROUP,
        type: 'select',
        proxies: ['REJECT', 'DIRECT', 'PROXY'],
      }] : []),
    ],
    'rule-providers': providers,
    rules,
    dns,
  };
  const yaml = `# subscription-name: ${JSON.stringify(String(name))}\n${stringify(config, { lineWidth: 0 })}`;
  return { config, yaml };
}
