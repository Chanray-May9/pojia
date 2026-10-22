// tests/dual.test.mjs — C. 双前端一致性：同一构建、仅 SITE_URL/API_BASE 不同 → 产物逐字节一致
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  QA_DIR,
  startApi,
  seedForum,
  buildDist,
  walkFiles,
  readText,
  normalizeBuildText,
  normalizeBaseAware,
  basePathOf,
  allLinks,
  canonicalOf,
  normalizeUrl,
  locsOf,
  parseLdJson,
} from './helpers.mjs';

const API_PORT = 4413;
const SITE_A = 'http://127.0.0.1:4423/pojia'; // 模拟 GitHub Pages 项目子路径
const SITE_B = 'https://pojia.example.com'; // 模拟 Cloudflare Pages 独立域名
const DIST_A = path.join(QA_DIR, 'dist-dual-a');
const DIST_B = path.join(QA_DIR, 'dist-dual-b');

let srv;
let seed;
let built = false;
let buildError = null;

const TEXT_EXT = new Set(['.html', '.htm', '.xml', '.txt', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest', '.map']);

before(async () => {
  try {
    srv = await startApi({ port: API_PORT, dbFile: 'dual-test.db' });
    seed = await seedForum(srv.base);
    // 两次构建：仅 SITE_URL 不同（API 数据源相同），模拟“同一份代码、两个域名”
    await buildDist({ apiBase: srv.base, siteUrl: SITE_A, outDir: DIST_A });
    await buildDist({ apiBase: srv.base, siteUrl: SITE_B, outDir: DIST_B });
    built = true;
  } catch (e) {
    buildError = e;
  }
});

after(async () => {
  if (srv) await srv.stop();
});

function requireBuild() {
  assert.equal(buildError, null, `双构建失败: ${buildError && buildError.stack}`);
  assert.ok(built, '构建未完成');
}

function isText(rel) {
  return TEXT_EXT.has(path.extname(rel).toLowerCase());
}

test('两份产物文件集合完全一致', async () => {
  requireBuild();
  const a = walkFiles(DIST_A).map((f) => f.rel);
  const b = walkFiles(DIST_B).map((f) => f.rel);
  assert.ok(a.length > 20, `产物文件过少: ${a.length}`);
  assert.deepEqual(b, a, '两份产物的文件列表应完全一致（含路径与顺序）');
});

test('逐文件比较：归一化域名后内容完全一致（唯一差异是域名相关字符串）', async () => {
  requireBuild();
  const filesA = walkFiles(DIST_A);
  const mismatches = [];
  for (const f of filesA) {
    const fileB = path.join(DIST_B, f.rel);
    const bufA = readFileSync(f.abs);
    const bufB = readFileSync(fileB);
    if (!isText(f.rel)) {
      if (!bufA.equals(bufB)) mismatches.push({ rel: f.rel, reason: '二进制资源不一致' });
      continue;
    }
    const normA = normalizeBuildText(bufA.toString('utf8'), { siteUrl: SITE_A, apiBase: srv?.base });
    const normB = normalizeBuildText(bufB.toString('utf8'), { siteUrl: SITE_B, apiBase: srv?.base });
    // 404.html 允许使用 base 路径的 root-relative 链接（任意深度下定位资源所必需）
    const cmpA = f.rel === '404.html' ? normalizeBaseAware(normA, basePathOf(SITE_A)) : normA;
    const cmpB = f.rel === '404.html' ? normalizeBaseAware(normB, basePathOf(SITE_B)) : normB;
    if (cmpA !== cmpB) {
      let idx = 0;
      while (idx < cmpA.length && cmpA[idx] === cmpB[idx]) idx++;
      mismatches.push({
        rel: f.rel,
        reason: '归一化后内容不同',
        at: idx,
        a: cmpA.slice(Math.max(0, idx - 120), idx + 120),
        b: cmpB.slice(Math.max(0, idx - 120), idx + 120),
      });
    }
  }
  assert.deepEqual(
    mismatches,
    [],
    `存在 ${mismatches.length} 个不一致文件:\n${JSON.stringify(mismatches.slice(0, 3), null, 2)}`,
  );
});

test('站点域名只以配置的 SITE_URL 出现：canonical/OG/sitemap 自引用各自域名', async () => {
  requireBuild();
  const homeA = readText(path.join(DIST_A, 'index.html'));
  const homeB = readText(path.join(DIST_B, 'index.html'));
  assert.equal(normalizeUrl(canonicalOf(homeA)), normalizeUrl(`${SITE_A}/`), 'A 版首页 canonical 应为 A 域名');
  assert.equal(normalizeUrl(canonicalOf(homeB)), normalizeUrl(`${SITE_B}/`), 'B 版首页 canonical 应为 B 域名');

  const mapA = locsOf(readText(path.join(DIST_A, 'sitemap.xml')));
  const mapB = locsOf(readText(path.join(DIST_B, 'sitemap.xml')));
  assert.ok(mapA.length > 0 && mapA.length === mapB.length, '两份 sitemap 条目数应一致');
  for (const loc of mapA) assert.ok(loc.startsWith(`${SITE_A}/`), `A 版 sitemap 应使用 A 域名: ${loc}`);
  for (const loc of mapB) assert.ok(loc.startsWith(`${SITE_B}/`), `B 版 sitemap 应使用 B 域名: ${loc}`);
});

test('GitHub Pages 子路径兼容：内部链接均为相对路径（不依赖 /pojia 前缀）', async () => {
  requireBuild();
  const htmlFiles = walkFiles(DIST_A).filter((f) => f.rel.endsWith('.html') && f.rel !== '404.html');
  const offending = [];
  for (const f of htmlFiles) {
    const html = readText(f.abs);
    for (const link of allLinks(html, `${SITE_A}/${f.rel}`)) {
      if (/^https?:/i.test(link.href) || link.href.startsWith('//')) continue;
      if (link.href.startsWith('/')) offending.push({ page: f.rel, href: link.href });
      // 站点绝对 URL 不应出现在 <a> 内部链接里（会破坏子路径/另一域名）
      if (link.href.startsWith(SITE_A) || link.href.startsWith(SITE_B)) {
        offending.push({ page: f.rel, href: link.href, reason: '锚点应为相对路径' });
      }
    }
  }
  assert.deepEqual(offending.slice(0, 10), [], `发现 ${offending.length} 个非相对内部链接`);
});

test('404.html：使用 base 路径定位资源/导航（任意缺失路径下可用，属 404 特例）', async () => {
  requireBuild();
  const html = readText(path.join(DIST_A, '404.html'));
  const bp = basePathOf(SITE_A); // '/pojia/'
  const links = allLinks(html, `${SITE_A}/404.html`);
  assert.ok(links.length >= 3, '404 页应有导航链接');
  const bad = [];
  for (const l of links) {
    if (/^https?:/i.test(l.href) || l.href.startsWith('//') || l.href.startsWith('#')) continue;
    const ok = !l.href.startsWith('/') || l.href.startsWith(bp);
    if (!ok) bad.push(l.href);
  }
  assert.deepEqual(bad, [], `404 页链接应为相对路径或以 base 路径 ${bp} 开头: ${JSON.stringify(bad)}`);
  // 资源（css/js/icon）同样必须 base 路径可用
  const assets = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const a of assets) {
    if (/^https?:/i.test(a) || a.startsWith('#') || a.startsWith('data:')) continue;
    assert.ok(!a.startsWith('/') || a.startsWith(bp), `404 页资源路径应 base-aware: ${a}`);
  }
});

test('两份产物 JSON-LD 均可 parse 且归一化后结构一致', async () => {
  requireBuild();
  for (const dist of [DIST_A, DIST_B]) {
    const htmlFiles = walkFiles(dist).filter((f) => f.rel.endsWith('.html'));
    for (const f of htmlFiles) {
      const ld = parseLdJson(readText(f.abs));
      assert.deepEqual(ld.errors, [], `${path.basename(dist)}/${f.rel} JSON-LD 解析失败: ${JSON.stringify(ld.errors)}`);
    }
  }
});
