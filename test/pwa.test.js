const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../server');
const { parseCertificateInput } = require('../lib/certificate');
const { loadAuthConfig } = require('../lib/auth');
const { createCert, noAuth } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('the web app manifest is installable and points at real files', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name && manifest.short_name && manifest.start_url && manifest.scope);
  const sizes = manifest.icons.map(i => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'has 192 and 512 icons');
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'), 'has a maskable icon');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(PUBLIC, icon.src)), `${icon.src} exists`);
});

test('PNG icons have the dimensions the manifest claims', () => {
  for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const png = fs.readFileSync(path.join(PUBLIC, 'icons', file));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test('both pages link the manifest and register the service worker; every precached file exists', () => {
  for (const page of ['index.html', 'login.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    assert.match(html, /rel="manifest" href="manifest\.webmanifest"/, page);
    assert.match(html, /src="pwa\.js"/, page);
    assert.match(html, /name="theme-color"/, page);
  }
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const precache = JSON.parse(sw.match(/PRECACHE = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const file of precache) assert.ok(fs.existsSync(path.join(PUBLIC, file)), `${file} exists`);
  assert.match(fs.readFileSync(path.join(PUBLIC, 'pwa.js'), 'utf8'), /register\('sw\.js'\)/);
});

test('the service worker never intercepts API or auth requests', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  assert.match(sw, /startsWith\('\/api\/'\)/);
  assert.match(sw, /startsWith\('\/auth\/'\)/);
});

test('manifest, service worker and offline page are served without signing in', async t => {
  const auth = loadAuthConfig({ ADMIN_PASSWORD: 'admin-password-1', SESSION_SECRET: 'x'.repeat(40) });
  const { server, base } = await listen(createApp({ auth, enableRateLimit: false }));
  t.after(() => new Promise(r => server.close(r)));
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /manifest\+json|json/);
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal(sw.headers.get('cache-control'), 'no-cache', 'the worker is always revalidated so updates reach users');
  assert.equal((await fetch(`${base}/offline.html`)).status, 200);
  assert.equal((await fetch(`${base}/icons/icon-192.png`)).status, 200);
});

test('in-app Back: views are pushed to history and popstate restores them', () => {
  const script = fs.readFileSync(path.join(PUBLIC, 'script.js'), 'utf8');
  assert.match(script, /history\.pushState/);
  assert.match(script, /addEventListener\('popstate'/);
  assert.match(script, /history\.back\(\)/);
  assert.match(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), /id="backBtn"/);
});

test('a .crt file parses whether it is PEM or DER, for RSA and EC keys', async () => {
  const rsa = await createCert({ name: 'CN=rsa.crt.test' });
  const pem = Buffer.from(rsa.pem);
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), pem]);
  const withBagText = Buffer.concat([Buffer.from('Bag Attributes\r\n  friendlyName: x\r\nsubject=CN = rsa.crt.test\r\n'), pem]);
  for (const [label, buffer] of [['PEM', pem], ['DER', rsa.der], ['PEM with BOM', withBom], ['PEM with leading text', withBagText]]) {
    const result = await parseCertificateInput({ buffer, originalName: 'server.crt' });
    assert.equal(result.error, null, `${label}: ${result.error}`);
    assert.equal(result.certs.length, 1, label);
  }

  const x509 = require('@peculiar/x509');
  const keys = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const ec = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01', name: 'CN=ec.crt.test', notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 86400000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, keys
  });
  const result = await parseCertificateInput({ buffer: Buffer.from(ec.rawData), originalName: 'ec.crt' });
  assert.equal(result.error, null, 'DER EC certificate in a .crt file');
  assert.equal(result.certs.length, 1);
});

test('uploading a DER .crt over HTTP returns its report', async t => {
  const { server, base } = await listen(createApp({ auth: noAuth, enableRateLimit: false }));
  t.after(() => new Promise(r => server.close(r)));
  const cert = await createCert({ name: 'CN=upload.crt.test' });
  const form = new FormData();
  form.append('certificate', new Blob([cert.der]), 'upload.crt');
  const res = await fetch(`${base}/api/validate-certificate`, { method: 'POST', body: form });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.error, null);
  assert.equal(body.certs.length, 1);
});
