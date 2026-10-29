import test from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { SAMPLE_LINKS, buildConfig, parseLinks } from '../src/lib/engine.js';

const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NON_RFC_VARIANT_UUID = 'cccccccc-cccc-4ccc-eccc-cccccccccccc';
const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');
const vmess = (overrides = {}) => `vmess://${b64(JSON.stringify({
  v: '2',
  ps: 'VMess',
  add: 'vmess.example.com',
  port: '443',
  id: UUID,
  aid: '0',
  scy: 'auto',
  net: 'tcp',
  tls: 'tls',
  ...overrides,
}))}`;

test('parses all four protocols and returns the stable public shape', () => {
  const result = parseLinks(SAMPLE_LINKS);
  assert.equal(result.total, 4);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.nodes.map((node) => node.type), ['vless', 'vmess', 'trojan', 'ss']);
  assert.ok(result.nodes.every((node) => typeof node.name === 'string' && node.server && node.port));
});

test('maps VLESS Reality, WS, gRPC, TLS, and flow fields without dropping them', () => {
  const input = [
    `vless://${UUID}@reality.example.com:443?security=reality&type=tcp&sni=www.example.com&fp=chrome&pbk=public-key&sid=abcd&flow=xtls-rprx-vision#reality`,
    `vless://${UUID}@ws.example.com:443?security=tls&type=ws&sni=ws.example.com&host=cdn.example.com&path=%2Fconnect&allowInsecure=true#ws`,
    `vless://${UUID}@grpc.example.com:443?security=tls&type=grpc&sni=grpc.example.com&serviceName=edge%2Fapi#grpc`,
  ].join('\n');
  const { nodes, errors } = parseLinks(input);
  assert.deepEqual(errors, []);
  assert.deepEqual(nodes[0]['reality-opts'], { 'public-key': 'public-key', 'short-id': 'abcd' });
  assert.equal(nodes[0].flow, 'xtls-rprx-vision');
  assert.deepEqual(nodes[1]['ws-opts'], {
    path: '/connect',
    headers: { Host: 'cdn.example.com' },
  });
  assert.equal(nodes[1]['skip-cert-verify'], true);
  assert.deepEqual(nodes[2]['grpc-opts'], { 'grpc-service-name': 'edge/api' });
});

test('accepts Reality spx while preserving strict VLESS parameter checks', () => {
  const { nodes, errors } = parseLinks([
    `vless://${UUID}@one.example.com:443?security=reality&pbk=public-key&spx=%2F#one`,
    `vless://${UUID}@two.example.com:443?security=reality&pbk=public-key&spx=%2Fcrawl%3Fpage%3D1#two`,
    `vless://${UUID}@bad.example.com:443?security=reality&pbk=public-key&unknown=value`,
    `vless://${UUID}@bad.example.com:443?security=tls&spx=%2F`,
    `vless://${UUID}@bad.example.com:443?security=reality&pbk=public-key&spx=%2F&spx=%2Fother`,
  ].join('\n'));
  assert.equal(nodes.length, 2);
  assert.deepEqual(errors.map(({ line }) => line), [3, 4, 5]);
  assert.match(errors[0].message, /不支持的参数/);
  assert.match(errors[1].message, /spx.*security=reality/);
  assert.match(errors[2].message, /参数重复/);
  assert.ok(nodes.every((node) => !('spider-x' in node['reality-opts'])));
  const { config } = buildConfig(nodes);
  assert.ok(config.proxies.every((node) => !('spider-x' in node['reality-opts'])));
});

test('accepts non-RFC UUID variant in VLESS and VMess without accepting malformed IDs', () => {
  const { nodes, errors } = parseLinks([
    `vless://${NON_RFC_VARIANT_UUID}@vless.example.com:443?security=reality&pbk=public-key#vless`,
    vmess({ id: NON_RFC_VARIANT_UUID }),
    `vless://cccccccc-cccc-4ccc-eccc-ccccccccccc@bad.example.com:443`,
    vmess({ id: 'cccccccc-cccc-4ccc-xccc-cccccccccccc' }),
    `vless://cccccccc-cccc-0ccc-eccc-cccccccccccc@bad.example.com:443`,
  ].join('\n'));
  assert.deepEqual(nodes.map(({ type, uuid }) => [type, uuid]), [
    ['vless', NON_RFC_VARIANT_UUID],
    ['vmess', NON_RFC_VARIANT_UUID],
  ]);
  assert.deepEqual(errors.map(({ line }) => line), [3, 4, 5]);
  assert.ok(errors.every(({ message }) => /UUID 无效/.test(message)));
  const { config, yaml } = buildConfig(nodes);
  assert.deepEqual(parseYaml(yaml).proxies.map(({ uuid }) => uuid), config.proxies.map(({ uuid }) => uuid));
});

test('parses VMess WS and gRPC transports and TLS fingerprints', () => {
  const { nodes, errors } = parseLinks([
    vmess({ net: 'ws', host: 'cdn.example.com', path: '/ws', sni: 'origin.example.com', fp: 'chrome', alpn: 'h2,http/1.1' }),
    vmess({ id: UUID2, net: 'grpc', serviceName: 'grpc-edge', tls: 'none' }),
  ].join('\n'));
  assert.deepEqual(errors, []);
  assert.equal(nodes[0]['client-fingerprint'], 'chrome');
  assert.deepEqual(nodes[0].alpn, ['h2', 'http/1.1']);
  assert.deepEqual(nodes[0]['ws-opts'], { path: '/ws', headers: { Host: 'cdn.example.com' } });
  assert.deepEqual(nodes[1]['grpc-opts'], { 'grpc-service-name': 'grpc-edge' });
  assert.equal(nodes[1].tls, undefined);
});

test('parses IPv6 servers and UTF-8 or URL-encoded SS credentials', () => {
  const input = [
    `trojan://%E5%AF%86%E7%A0%81@example.com:443?sni=example.com#%E8%8A%82%E7%82%B9`,
    'ss://YWVzLTI1Ni1nY206cGFzc0B3b3Jk@[2001:db8::1]:8388#ipv6',
    `ss://${encodeURIComponent('chacha20-ietf-poly1305:密码@含符号')}@[2001:db8::2]:443#中文名称`,
  ].join('\n');
  const { nodes, errors } = parseLinks(input);
  assert.deepEqual(errors, []);
  assert.equal(nodes[0].password, '密码');
  assert.equal(nodes[0].name, '节点');
  assert.equal(nodes[1].server, '2001:db8::1');
  assert.equal(nodes[1].password, 'pass@word');
  assert.equal(nodes[2].password, '密码@含符号');
  assert.equal(nodes[2].name, '中文名称');
});

test('supports SIP002 v2ray-plugin and simple-obfs; rejects unknown plugin options', () => {
  const { nodes, errors } = parseLinks([
    'ss://YWVzLTI1Ni1nY206cGFzcw==@ss.example.com:443?plugin=v2ray-plugin%3Bmode%3Dwebsocket%3Btls%3Bhost%3Dcdn.example.com%3Bpath%3D%2Fss#v2ray',
    'ss://YWVzLTI1Ni1nY206cGFzcw==@ss.example.com:443?plugin=simple-obfs%3Bobfs%3Dhttp%3Bobfs-host%3Dcdn.example.com#obfs',
    'ss://YWVzLTI1Ni1nY206cGFzcw==@ss.example.com:443?plugin=v2ray-plugin%3Bunknown%3Dx',
  ].join('\n'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /包含不支持的 v2ray-plugin 参数/);
  assert.equal(nodes[0].plugin, 'v2ray-plugin');
  assert.deepEqual(nodes[0]['plugin-opts'], {
    mode: 'websocket',
    tls: true,
    host: 'cdn.example.com',
    path: '/ss',
  });
  assert.equal(nodes[1].plugin, 'obfs');
  assert.deepEqual(nodes[1]['plugin-opts'], { mode: 'http', host: 'cdn.example.com' });
});

test('reports partial failures by source line without returning credentials in errors', () => {
  const secret = 'very-secret-password';
  const { nodes, errors, total } = parseLinks([
    `trojan://${secret}@valid.example.com:443#ok`,
    `vless://not-a-uuid@invalid.example.com:443?password=${secret}#bad`,
    'unknown://bad',
    `vless://${UUID}@other.example.com:443?${secret}=value`,
  ].join('\n'));
  assert.equal(total, 4);
  assert.equal(nodes.length, 1);
  assert.deepEqual(errors.map((error) => error.line), [2, 3, 4]);
  assert.ok(errors.every((error) => !error.message.includes(secret)));
});

test('enforces strict UUID, port, base64, and unsupported-field validation', () => {
  const { nodes, errors } = parseLinks([
    'vless://not-a-uuid@bad.example.com:443#x',
    `trojan://pass@bad.example.com:70000#${'secret'}`,
    'vmess://not-base64!',
    vmess({ unexpected: 'must-not-be-dropped' }),
    `vless://${UUID}@bad.example.com:443?security=quic#unsupported`,
    `vless://${UUID}@bad.example.com:443?security=tls&pbk=only-valid-for-reality`,
  ].join('\n'));
  assert.equal(nodes.length, 0);
  assert.equal(errors.length, 6);
  assert.match(errors[0].message, /UUID/);
  assert.match(errors[1].message, /端口/);
  assert.match(errors[2].message, /Base64/);
  assert.match(errors[3].message, /包含不支持的 VMess 字段/);
  assert.match(errors[4].message, /不支持该 VLESS security 模式/);
  assert.match(errors[5].message, /仅支持 security=reality/);
});

test('deduplicates names and keeps reserved strategy names usable', () => {
  const names = [
    'GLOBAL', 'PROXY', 'DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'PASS-RULE',
    '直连', '广告拦截', 'PROXY', 'pass', 'same', 'same',
  ];
  const { nodes, errors } = parseLinks(names.map((name, index) =>
    `trojan://synthetic@node${index}.example.com:443#${encodeURIComponent(name)}`
  ).join('\n'));
  assert.deepEqual(errors, []);
  assert.deepEqual(nodes.map((node) => node.name), [
    'GLOBAL (2)', 'PROXY (2)', 'DIRECT (2)', 'REJECT (2)', 'REJECT-DROP (2)',
    'COMPATIBLE (2)', 'PASS (2)', 'PASS-RULE (2)', '直连 (2)',
    '广告拦截 (2)', 'PROXY (3)', 'pass (3)', 'same', 'same (2)',
  ]);
  const { config } = buildConfig(nodes);
  const groupNames = new Set(config['proxy-groups'].map(({ name }) => name));
  assert.ok(config.proxies.every(({ name }) => !groupNames.has(name)));
  assert.deepEqual(config['proxy-groups'][0].proxies.slice(0, nodes.length), nodes.map(({ name }) => name));
});

test('ignores blank lines and rejects empty or oversized input safely', () => {
  assert.deepEqual(parseLinks(' \n\n\t'), { nodes: [], errors: [], total: 0 });
  const blankConfig = () => buildConfig([]);
  assert.throws(blankConfig, /至少需要一个有效节点/);
  assert.equal(parseLinks('x'.repeat(500_001)).errors.length, 1);
  const overLimit = Array.from({ length: 501 }, () => 'unknown://bad').join('\n');
  assert.match(parseLinks(overLimit).errors.at(-1).message, /最多支持 500 条链接/);
});

test('emits YAML safely, preserves proxy references, and puts rules in priority order', () => {
  const label = 'quotes: " # ]\n- MATCH,DIRECT';
  const { nodes } = parseLinks(`trojan://pass@safe.example.com:443#${encodeURIComponent(label)}`);
  const { config, yaml } = buildConfig(nodes, { name: 'subscription: "safe"' });
  const parsed = parseYaml(yaml);
  assert.ok(yaml.startsWith(`# subscription-name: ${JSON.stringify('subscription: "safe"')}\n`));
  assert.deepEqual(parsed, config);
  assert.equal(parsed.proxies[0].name, label);
  assert.deepEqual(parsed['proxy-groups'][0].proxies, [label, 'DIRECT']);
  assert.deepEqual(parsed['proxy-groups'], [
    { name: 'PROXY', type: 'select', proxies: [label, 'DIRECT'] },
    { name: '直连', type: 'select', proxies: ['DIRECT', 'PROXY', label] },
    { name: '广告拦截', type: 'select', proxies: ['REJECT', 'DIRECT', 'PROXY'] },
  ]);
  assert.deepEqual(parsed.rules, [
    'RULE-SET,ads,广告拦截',
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
    'RULE-SET,cn,直连',
    'RULE-SET,cn_ip,直连',
    'MATCH,PROXY',
  ]);
  assert.ok(Object.values(parsed['rule-providers']).every((provider) => provider.proxy === 'PROXY'));
  assert.deepEqual(parsed.dns.nameserver, [
    'https://1.1.1.1/dns-query#PROXY',
    'https://8.8.8.8/dns-query#PROXY',
  ]);
  assert.equal(parsed['mixed-port'], 7890);
  assert.equal(parsed['allow-lan'], false);
  assert.equal(parsed.mode, 'rule');
});

test('disables only optional advertisement and China routing rules', () => {
  const { nodes } = parseLinks(`trojan://pass@safe.example.com:443#node`);
  const { config } = buildConfig(nodes, { blockAds: false, directChina: false });
  assert.equal(config['rule-providers'].ads, undefined);
  assert.equal(config['rule-providers'].cn, undefined);
  assert.equal(config['rule-providers'].cn_ip, undefined);
  assert.equal(config.dns['nameserver-policy'], undefined);
  assert.deepEqual(config['proxy-groups'].map(({ name }) => name), ['PROXY']);
  assert.deepEqual(config.rules, [
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
    'MATCH,PROXY',
  ]);
});

test('keeps all provider, rule, and DNS references aligned across toggle combinations', () => {
  const { nodes } = parseLinks(`trojan://pass@safe.example.com:443#node`);
  for (const blockAds of [false, true]) {
    for (const directChina of [false, true]) {
      const { config } = buildConfig(nodes, { blockAds, directChina });
      const providerNames = Object.keys(config['rule-providers']);
      const ruleSets = config.rules
        .filter((rule) => rule.startsWith('RULE-SET,'))
        .map((rule) => rule.split(',')[1]);

      assert.equal(providerNames.includes('ads'), blockAds);
      assert.equal(ruleSets.includes('ads'), blockAds);
      assert.equal(providerNames.includes('cn'), directChina);
      assert.equal(providerNames.includes('cn_ip'), directChina);
      assert.equal(ruleSets.includes('cn'), directChina);
      assert.equal(ruleSets.includes('cn_ip'), directChina);
      assert.deepEqual(
        config['proxy-groups'].map(({ name }) => name),
        ['PROXY', ...(directChina ? ['直连'] : []), ...(blockAds ? ['广告拦截'] : [])],
      );
      assert.ok(config.rules.filter((rule) => rule.includes(',private,') || rule.startsWith('IP-CIDR'))
        .every((rule) => rule.includes(',DIRECT')));
      assert.ok(config.rules.every((rule) => {
        const parts = rule.split(',');
        const target = parts.at(-1) === 'no-resolve' ? parts.at(-2) : parts.at(-1);
        return target === 'DIRECT' || config['proxy-groups'].some(({ name }) => name === target);
      }));
      assert.ok(Object.values(config['rule-providers']).every((provider) => provider.proxy === 'PROXY'));
      assert.ok(config.dns.nameserver.every((server) => server.endsWith('#PROXY')));
      assert.equal(
        Object.hasOwn(config.dns['nameserver-policy'] || {}, 'rule-set:cn'),
        directChina,
      );
      for (const name of ruleSets) assert.ok(providerNames.includes(name), `missing provider ${name}`);
      for (const name of providerNames) {
        if (name !== 'private') assert.ok(ruleSets.includes(name), `unused provider ${name}`);
      }
    }
  }
});

test('refuses invalid node lists instead of generating broken references', () => {
  for (const name of [
    'GLOBAL', 'PROXY', 'DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'PASS-RULE',
    '直连', '广告拦截', 'pass-rule',
  ]) {
    assert.throws(() => buildConfig([{ type: 'ss', name }], {
      blockAds: false, directChina: false,
    }), /名称必须唯一/, name);
  }
  assert.throws(() => buildConfig([{ type: 'vmess', name: 'dup' }, { type: 'vless', name: 'DUP' }]), /名称必须唯一/);
  assert.throws(() => buildConfig([{ type: 'unknown', name: 'node' }]), /节点类型无效/);
});
