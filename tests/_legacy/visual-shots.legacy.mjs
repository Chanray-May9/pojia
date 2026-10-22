// tests/visual-shots.mjs — 验收项 9：无头 Edge 截图（1440x900 / 390x844 的首页、分类页、帖子页）
// 用法：node tests/visual-shots.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  QA_DIR,
  EDGE,
  NODE,
  startServer,
  Client,
  makeCtx,
  registerViaContract,
  loginViaContract,
  createPostViaContract,
  replyViaContract,
  sleep,
} from './helpers.mjs';

const PORT = 4315;
const OUT = QA_DIR;
mkdirSync(OUT, { recursive: true });

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function screenshot({ url, outPath, width, height, profileDir }) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    '--virtual-time-budget=4000',
    '--hide-scrollbars',
    `--screenshot=${outPath}`,
    url,
  ];
  const started = Date.now();
  const child = spawn(EDGE, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', () => {});
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve('timeout');
    }, 60000);
    child.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  // 等文件落盘
  for (let i = 0; i < 20 && !existsSync(outPath); i++) await sleep(150);
  const exists = existsSync(outPath);
  const bytes = exists ? readFileSync(outPath) : null;
  return {
    url,
    outPath,
    viewport: `${width}x${height}`,
    exitCode: code,
    ms: Date.now() - started,
    exists,
    bytes: bytes ? bytes.length : 0,
    size: bytes ? pngSize(bytes) : null,
    stderrTail: stderr.slice(-500),
    PASS: Boolean(exists && bytes && bytes.length > 8000 && pngSize(bytes)?.width === width && pngSize(bytes)?.height === height),
  };
}

const main = async () => {
  if (!existsSync(EDGE)) throw new Error(`未找到 Edge: ${EDGE}`);
  if (!existsSync(path.join(ROOT, 'server.mjs'))) throw new Error('server.mjs 不存在，站点未就绪');

  const srv = await startServer({ port: PORT, dbFile: 'test-visual.db' });
  const results = [];
  const profileDir = path.join(QA_DIR, `edge-profile-${process.pid}`);
  try {
    const client = new Client(srv.base);
    const ctx = makeCtx('visual', {
      title: '如何评估一个越狱提示词的鲁棒性',
      body:
        '这是一篇用于视觉验收的帖子正文。我们在做提示词注入与越狱方向的红队评估，' +
        '需要关注模型在多层角色扮演、编码混淆与工具调用场景下的稳定性。\n\n' +
        '第一步：构造基线用例；第二步：加入对抗性扰动；第三步：对比拒绝率与信息泄漏率。' +
        '本段文字较长，用于观察帖子页正文排版、行高、中文字体渲染与代码块样式。',
    });
    await registerViaContract(client, ctx);
    await loginViaContract(client, ctx);
    const post = await createPostViaContract(client, ctx);
    await replyViaContract(client, post.postPath, '这是一条用于视觉验收的回帖，检查楼层排版与作者信息对齐。', ctx);

    // 再补几帖，让首页/分类列表更接近真实密度
    for (const [i, cat] of ['injection', 'redteam', 'defense', 'tooling'].entries()) {
      const extra = makeCtx('visual', {
        title: ['Claude 工具调用注入面梳理', '红队演练复盘：从钓鱼到横向', '防御侧检测规则编写指南', '自建评测工具链记录'][i],
        body: `用于视觉验收的分类列表帖 ${i + 1}。这里放一段中等长度的正文，检查列表卡片标题折行、摘要截断与元信息排版是否稳定。`,
      });
      await createPostViaContract(client, extra, { category: cat });
    }

    const pages = [
      { name: 'home', url: `${srv.base}/` },
      { name: 'category', url: `${srv.base}/c/jailbreak` },
      { name: 'post', url: `${srv.base}${post.postPath}` },
    ];
    const viewports = [
      { tag: 'desktop', width: 1440, height: 900 },
      { tag: 'mobile', width: 390, height: 844 },
    ];
    for (const vp of viewports) {
      for (const page of pages) {
        const outPath = path.join(OUT, `${vp.tag}-${page.name}.png`);
        const r = await screenshot({
          url: page.url,
          outPath,
          width: vp.width,
          height: vp.height,
          profileDir: path.join(profileDir, `${vp.tag}-${page.name}`),
        });
        results.push(r);
        console.log(`[${r.PASS ? 'PASS' : 'FAIL'}] ${vp.tag}-${page.name} ${r.viewport} ${r.bytes}B ${r.size ? r.size.width + 'x' + r.size.height : '?'} ${r.ms}ms`);
        if (!r.PASS) console.log('   stderr:', r.stderrTail);
      }
    }
  } finally {
    await srv.stop();
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    node: NODE,
    edge: EDGE,
    base: `http://127.0.0.1:${PORT}`,
    note: '截图为 viewport 尺寸（非整页），用于人工检查布局重叠/横向溢出/中文字体/移动端导航。',
    results,
  };
  const manifestPath = path.join(OUT, 'shots.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\nmanifest: ${manifestPath}`);
  const failed = results.filter((r) => !r.PASS);
  if (failed.length) {
    console.error(`截图失败 ${failed.length} 张`);
    process.exitCode = 1;
  } else {
    console.log('全部截图生成成功');
  }
};

main().catch((e) => {
  console.error('视觉验收脚本失败:', e);
  process.exitCode = 1;
});
