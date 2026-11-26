/*
 * 浏览器端实测：保存静音后，审听页在当前试听段混音变化时自动取新 WAV。
 *
 * 前置：被测服务已在 BASE 运行（默认 http://127.0.0.1:8000，与 Compose 一致）。
 * 运行：node tests/e2e_swap.js
 *
 * 覆盖：
 *   1. 改音期间播放中切换：进度沿用、继续播放；
 *   2. 改音期间暂停中切换：沿用暂停与进度；
 *   3. 拖动后切换：沿用拖动后的进度；
 *   4. 连续改音：只落到页面已知的最新混音，不落到中间版本；
 *   5. 切换期间点了别段：旧请求成功也不切回去；
 *   6. 换集：旧请求成功也不切回去；
 *   7. 加载失败：保留原音频并可重试；
 *   8. 新混音载入后未播放前不能确认；播放后可确认。
 */

const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8000';
const RATE = 44100;
const SEG = 5 * RATE;          // 5 秒一段
const SEG1 = [SEG, 2 * SEG];   // 第 2 段（0 基）的采样区间

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : ' | ' + (extra ?? '')));
}

async function api(path, opts) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function loadSample() {
  const r = await api('/api/load_sample', { method: 'POST' });
  if (r.status !== 200) throw new Error('load_sample failed: ' + JSON.stringify(r.body));
  return r.body;
}

async function getState() {
  return (await api('/api/state')).body;
}

async function saveMute(start, end) {
  const r = await api('/api/mutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ B: [[start, end]] }),
  });
  if (r.status !== 200) throw new Error('mutes failed: ' + JSON.stringify(r.body));
  return r.body;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeout = 15000, label = 'condition', debug = null) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) {
      if (debug) console.log('DEBUG(' + label + '):', JSON.stringify(await debug()));
      throw new Error('timeout waiting for ' + label);
    }
    await sleep(100);
  }
}

// 页面内小工具
const PLAYER_INFO = `(() => {
  const p = document.querySelector('#player');
  return {
    hasSrc: !!p.getAttribute('src'),
    paused: p.paused,
    currentTime: p.currentTime,
    duration: Number.isFinite(p.duration) ? p.duration : null,
    label: document.querySelector('#playingLabel').textContent,
    swapMsg: document.querySelector('#swapMsg').textContent,
    retryShown: !document.querySelector('#btnSwapRetry').classList.contains('hidden'),
  };
})()`;

async function playerInfo(page) { return page.evaluate(PLAYER_INFO); }

async function segStatus(page, i) {
  return page.evaluate(i => {
    const tr = document.querySelectorAll('#segTable tbody tr')[i];
    return {
      status: tr.children[3].textContent.trim(),
      hash: tr.children[4].getAttribute('title'),
      confirmDisabled: tr.querySelectorAll('button')[1].disabled,
    };
  }, i);
}

async function hashOf(i) {
  const r = await fetch(`${BASE}/api/segment/${i}.wav`);
  await r.arrayBuffer();
  return r.headers.get('X-Mix-Hash');
}

async function audition(page, i) {
  await page.evaluate(i => document.querySelectorAll('#segTable tbody tr')[i]
    .querySelectorAll('button')[0].click(), i);
  await waitFor(async () => {
    const info = await playerInfo(page);
    return info.hasSrc && info.duration !== null;
  }, 15000, 'segment loaded');
  await waitFor(async () => !(await playerInfo(page)).paused, 10000, 'playback started');
}

async function main() {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  // 屏蔽 alert 阻塞
  page.on('dialog', d => d.dismiss());

  await loadSample();
  await page.goto(BASE + '/');
  await waitFor(async () => (await page.locator('#main').isVisible()), 10000, 'page loaded');

  // ------------------------------------------------------------------ 1
  console.log('\n== 1. 播放中改音：自动切新混音、沿用进度、继续播放 ==');
  await audition(page, 1);
  await page.evaluate(() => { const p = document.querySelector('#player'); p.currentTime = 1.5; });
  await waitFor(async () => Math.abs((await playerInfo(page)).currentTime - 1.5) < 0.6, 5000, 'seek 1.5');
  const oldHash1 = (await getState()).segments[1].hash;
  const r1 = await saveMute(SEG1[0] + 1000, SEG1[0] + 2000);   // 第 2 段内容变化
  const newHash1 = r1.state.segments[1].hash;
  check('改音后段 2 混音哈希变化', newHash1 !== oldHash1);
  const info1 = await waitFor(async () => {
    const info = await playerInfo(page);
    return info.label.includes(newHash1.slice(0, 10)) && info.duration !== null ? info : null;
  }, 15000, 'swap to new hash (playing)');
  const info1b = await waitFor(async () => {
    const info = await playerInfo(page);
    return !info.paused && info.currentTime > 1.0 ? info : null;
  }, 10000, 'resume playback after swap');
  check('自动切到新混音', info1.label.includes(newHash1.slice(0, 10)), info1.label);
  check('切换后继续播放', info1b.paused === false, info1b);
  check('切换沿用原进度(≈1.5s)', Math.abs(info1b.currentTime - 1.5) < 2.0, info1b.currentTime);
  check('切换提示成功', info1.swapMsg.includes('已切到第 2 段的新混音'), info1.swapMsg);

  // ------------------------------------------------------------------ 2
  console.log('\n== 2. 暂停中改音：切新混音后仍暂停，进度沿用 ==');
  await page.evaluate(() => document.querySelector('#player').pause());
  await waitFor(async () => (await playerInfo(page)).paused, 5000, 'paused');
  await page.evaluate(() => { document.querySelector('#player').currentTime = 2.4; });
  await waitFor(async () => Math.abs((await playerInfo(page)).currentTime - 2.4) < 0.5, 5000, 'seek 2.4');
  const r2 = await saveMute(SEG1[0] + 3000, SEG1[0] + 4000);
  const newHash2 = r2.state.segments[1].hash;
  const info2 = await waitFor(async () => {
    const info = await playerInfo(page);
    return info.label.includes(newHash2.slice(0, 10)) && info.duration !== null
           && Math.abs(info.currentTime - 2.4) < 0.8 ? info : null;
  }, 15000, 'swap while paused, progress restored');
  check('暂停中自动切到新混音', info2.label.includes(newHash2.slice(0, 10)), info2.label);
  check('切换后保持暂停', info2.paused === true, info2);
  check('暂停切换沿用进度(≈2.4s)', Math.abs(info2.currentTime - 2.4) < 0.8, info2.currentTime);

  // ------------------------------------------------------------------ 3
  console.log('\n== 3. 拖动到别处后再改音：沿用拖动后的进度 ==');
  await page.evaluate(() => document.querySelector('#player').play());
  await waitFor(async () => !(await playerInfo(page)).paused, 5000, 'playing again');
  await page.evaluate(() => { document.querySelector('#player').currentTime = 0.9; });   // 往回拖
  await waitFor(async () => Math.abs((await playerInfo(page)).currentTime - 0.9) < 0.5, 5000, 'seek 0.9');
  const r3 = await saveMute(SEG1[0] + 5000, SEG1[0] + 6000);
  const newHash3 = r3.state.segments[1].hash;
  await page.evaluate(() => refresh());   // 立即同步，缩短等待（进度会继续前进）
  // 播放中切换：切换后继续播放，进度从拖动后的位置继续，而不是从 0 重来
  const info3 = await waitFor(async () => {
    const info = await playerInfo(page);
    return info.label.includes(newHash3.slice(0, 10)) ? info : null;
  }, 15000, 'swap after drag', () => playerInfo(page));
  check('拖动后改音仍自动切到新混音', info3.label.includes(newHash3.slice(0, 10)), info3.label);
  check('沿用拖动后的进度（未从 0 重来）', info3.currentTime >= 0.9, info3.currentTime);
  check('切换后继续播放', info3.paused === false, info3);

  // ------------------------------------------------------------------ 4
  console.log('\n== 4. 连续改音：拉取期间仍可播放/拖动，只落到页面已知的最新混音 ==');
  // 记录播放器每次实际挂载的哈希，检查绝不落到中间版本
  await page.evaluate(() => {
    window.__applied = [];
    const orig = applySource;
    applySource = function (...args) {
      window.__applied.push(args[1]);
      return orig.apply(this, args);
    };
  });
  // 让 /api/segment 的响应延迟，制造"旧请求在空中"的窗口
  let delayNextSegment = 0;
  await page.route('**/api/segment/*.wav', async route => {
    try {
      if (delayNextSegment > 0) {
        delayNextSegment--;
        await sleep(1200);
      }
      await route.continue();
    } catch (e) { /* unroute 时在途请求已自动放行 */ }
  });
  delayNextSegment = 1;
  const r4a = await saveMute(SEG1[0] + 7000, SEG1[0] + 8000);
  const hash4a = r4a.state.segments[1].hash;
  await page.evaluate(() => refresh());       // 页面立即知道 4a，发起拉取（被延迟）
  await sleep(300);
  // 拉取在途：原播放器仍可播放、拖动
  const mid = await playerInfo(page);
  const tMid = mid.currentTime;
  await sleep(400);
  const mid2 = await playerInfo(page);
  check('拉取期间原音频仍在播放', mid2.paused === false, mid2);
  check('拉取期间进度继续前进', mid2.currentTime > tMid, `${tMid} -> ${mid2.currentTime}`);
  await page.evaluate(() => { document.querySelector('#player').currentTime = 3.0; });
  const mid3 = await waitFor(async () => {
    const info = await playerInfo(page);
    return Math.abs(info.currentTime - 3.0) < 0.7 ? info : null;
  }, 4000, 'drag during fetch');
  check('拉取期间仍可拖动', Math.abs(mid3.currentTime - 3.0) < 0.7, mid3.currentTime);
  // 连续第二次改音（4b），页面应当只落到 4b
  const r4b = await saveMute(SEG1[0] + 9000, SEG1[0] + 10000);
  const hash4b = r4b.state.segments[1].hash;
  await page.evaluate(() => refresh());
  const info4 = await waitFor(async () => {
    const info = await playerInfo(page);
    return info.label.includes(hash4b.slice(0, 10)) && !info.paused ? info : null;
  }, 20000, 'converge to newest mix');
  check('最终落到最新混音', info4.label.includes(hash4b.slice(0, 10)), info4.label);
  check('最新混音在播放', info4.paused === false, info4);
  check('沿用拉取期间的拖动位置(≈3.0s)', Math.abs(info4.currentTime - 3.0) < 2.0, info4.currentTime);
  const applied = await page.evaluate(() => window.__applied);
  check('从未挂载中间版本 4a', !applied.includes(hash4a), applied.map(h => h.slice(0, 8)));
  check('最终挂载的是 4b', applied[applied.length - 1] === hash4b, applied.map(h => h.slice(0, 8)));
  await page.unroute('**/api/segment/*.wav');

  // ------------------------------------------------------------------ 5
  console.log('\n== 5. 切换请求在途时点了别段：旧请求成功也不切回去 ==');
  delayNextSegment = 0;
  await page.route('**/api/segment/1.wav', async route => {
    try { await sleep(1500); await route.continue(); } catch (e) { /* 已放行 */ }
  });
  const r5 = await saveMute(SEG1[0] + 11000, SEG1[0] + 12000);   // 触发第 2 段自动切换
  const hash5seg1 = r5.state.segments[1].hash;
  await sleep(300);                        // 让切换请求进入在途
  await page.evaluate(() => document.querySelectorAll('#segTable tbody tr')[3]
    .querySelectorAll('button')[0].click());   // 立刻点第 4 段试听
  await waitFor(async () => (await playerInfo(page)).label.includes('第 4 段'), 15000, 'segment 4 playing');
  await sleep(2500);                       // 等旧请求返回（已成功）
  const info5 = await playerInfo(page);
  check('仍在第 4 段', info5.label.includes('第 4 段'), info5.label);
  check('旧请求未把播放器切回第 2 段', !info5.label.includes(hash5seg1.slice(0, 10)), info5.label);
  await page.unroute('**/api/segment/1.wav');

  // ------------------------------------------------------------------ 6
  console.log('\n== 6. 换集：旧集请求成功也不切回去 ==');
  await page.route('**/api/segment/3.wav', async route => {
    try { await sleep(1500); await route.continue(); } catch (e) { /* 已放行 */ }
  });
  // 通过另一个"窗口"改音触发第 4 段（当前段）自动切换，并让请求挂住
  const r6 = await saveMute(3 * SEG + 1000, 3 * SEG + 2000);
  await sleep(300);
  const fresh = await api('/api/load_sample', { method: 'POST' });   // 换集（新 episode_id）
  check('换集成功且 episode_id 递增', fresh.status === 200 && r6.state.episode_id !== fresh.body.episode_id,
        `${r6.state.episode_id} -> ${fresh.body.episode_id}`);
  await sleep(2500);                        // 等旧请求成功返回
  await page.evaluate(() => refresh());     // 页面感知换集
  await sleep(300);
  const info6 = await playerInfo(page);
  check('换集后播放器已解除旧集绑定', !info6.hasSrc, info6);
  check('换集提示可见', info6.swapMsg.includes('剧集已更换') || info6.label.includes('剧集已更换'),
        info6.swapMsg + ' | ' + info6.label);
  await page.unroute('**/api/segment/3.wav');

  // ------------------------------------------------------------------ 7
  console.log('\n== 7. 加载失败：保留原音频，可重试 ==');
  await page.goto(BASE + '/');
  await waitFor(async () => (await page.locator('#main').isVisible()), 10000, 'page loaded');
  await audition(page, 4);
  await page.evaluate(() => { document.querySelector('#player').pause(); });
  await waitFor(async () => (await playerInfo(page)).paused, 5000, 'paused');
  const before7 = await playerInfo(page);
  let failOnce = true;
  await page.route('**/api/segment/4.wav', async route => {
    try {
      if (failOnce) { failOnce = false; await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"模拟故障"}' }); }
      else await route.continue();
    } catch (e) { /* 已放行 */ }
  });
  const r7 = await saveMute(4 * SEG + 1000, 4 * SEG + 2000);
  const newHash7 = r7.state.segments[4].hash;
  const info7 = await waitFor(async () => {
    const info = await playerInfo(page);
    return info.retryShown ? info : null;
  }, 20000, 'retry shown');
  check('失败后保留原音频（src 仍在、仍暂停）', info7.hasSrc && info7.paused, info7);
  check('失败提示要求重试', info7.swapMsg.includes('加载失败'), info7.swapMsg);
  check('提示中有重试按钮', info7.retryShown, info7);
  check('失败后未切换到新哈希', !info7.label.includes(newHash7.slice(0, 10)), info7.label);
  await page.evaluate(() => document.querySelector('#btnSwapRetry').click());
  const info7b = await waitFor(async () => {
    const info = await playerInfo(page);
    return info.label.includes(newHash7.slice(0, 10)) ? info : null;
  }, 20000, 'retry succeeded');
  check('重试后切到新混音', info7b.label.includes(newHash7.slice(0, 10)), info7b.label);
  check('重试后仍保持暂停', info7b.paused, info7b);
  await page.unroute('**/api/segment/4.wav');

  // ------------------------------------------------------------------ 8
  console.log('\n== 8. 新混音未播放前不能确认；播放后可确认 ==');
  // 当前第 5 段已停在新混音、尚未播放（上面 paused 状态）
  let st = await segStatus(page, 4);
  check('未播放新混音时确认按钮禁用', st.confirmDisabled === true, st);
  await page.evaluate(() => document.querySelector('#player').play());
  await waitFor(async () => !(await playerInfo(page)).paused, 5000, 'playing');
  await waitFor(async () => !(await segStatus(page, 4)).confirmDisabled, 5000, 'confirm enabled');
  st = await segStatus(page, 4);
  check('播放后可确认', st.confirmDisabled === false, st);
  await page.evaluate(() => document.querySelectorAll('#segTable tbody tr')[4]
    .querySelectorAll('button')[1].click());
  await waitFor(async () => (await segStatus(page, 4)).status.includes('已通过'), 10000, 'confirmed');

  // 确认仍匹配服务端当前混音：播放并确认后，他处改音会让通过失效；
  // 页面若仍用旧播放版本的哈希确认，服务端必须拒绝。
  const before8 = (await getState()).segments[2];
  let staleSegHash = null;
  await page.evaluate(() => document.querySelectorAll('#segTable tbody tr')[2]
    .querySelectorAll('button')[0].click());
  await waitFor(async () => (await playerInfo(page)).label.includes('第 3 段')
    && !(await playerInfo(page)).paused, 15000, 'segment 3 playing');
  staleSegHash = (await getState()).segments[2].hash;
  await waitFor(async () => !(await segStatus(page, 2)).confirmDisabled, 10000, 'seg3 confirm enabled');
  await page.evaluate(() => document.querySelectorAll('#segTable tbody tr')[2]
    .querySelectorAll('button')[1].click());
  await waitFor(async () => (await segStatus(page, 2)).status.includes('已通过'), 10000, 'segment 3 confirmed');
  const r8 = await saveMute(2 * SEG + 1000, 2 * SEG + 2000);
  check('他处改音使第 3 段失效', r8.state.segments[2].hash !== staleSegHash
        && r8.state.segments[2].passed === false);
  // 直接回放旧哈希：服务端仍须拒绝（页面按钮本身也因"未播放新版本"而禁用）
  const stale = await api('/api/confirm/2', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash: staleSegHash }),
  });
  check('用旧版本哈希确认被服务端拒绝(409)', stale.status === 409, stale);
  check('服务端当前混音未变', (await getState()).segments[2].passed === false);
  check('未播放新版本时页面确认按钮禁用', (await segStatus(page, 2)).confirmDisabled === true);

  // ------------------------------------------------------------------ 9
  console.log('\n== 9. 只有当前试听段的哈希变化才取新 WAV ==');
  await page.goto(BASE + '/');
  await waitFor(async () => (await page.locator('#main').isVisible()), 10000, 'page loaded');
  const segReqs = [];
  await page.route('**/api/segment/*.wav', async route => {
    const m = route.request().url().match(/segment\/(\d+)\.wav/);
    segReqs.push(Number(m[1]));
    try { await route.continue(); } catch (e) { /* 已放行 */ }
  });
  await audition(page, 0);                       // 试听第 1 段
  await page.evaluate(() => { document.querySelector('#player').pause(); });
  const baseline = segReqs.length;
  // 改第 5 段（与当前试听段无关）：不应触发任何新取 WAV
  const r9a = await saveMute(4 * SEG + 1000, 4 * SEG + 2000);
  await page.evaluate(() => refresh());
  await sleep(1200);
  check('改其他段时不取当前段 WAV', segReqs.length === baseline, segReqs);
  check('当前段播放器未变', (await playerInfo(page)).label.includes((await getState()).segments[0].hash.slice(0, 10)));
  // 当前段保存静音但样本值无变化（重复设置同一区间）：哈希不变，也不取
  const r9pre = await saveMute(1000, 2000);      // 第一次真正变化
  await page.evaluate(() => refresh());
  await waitFor(async () => {
    const cur0 = (await getState()).segments[0];
    return (await playerInfo(page)).label.includes(cur0.hash.slice(0, 10)) ? true : null;
  }, 15000, 'first current-seg swap');
  const afterFirst = segReqs.length;
  const r9same = await saveMute(1000, 2000);     // 再设同一区间：混音不变
  check('重复设置同一静音区间不改变混音哈希',
        r9same.state.segments[0].hash === r9pre.state.segments[0].hash);
  await page.evaluate(() => refresh());
  await sleep(1200);
  check('哈希未变时不取新 WAV', segReqs.length === afterFirst, segReqs);
  // 改当前段且有实际变化：取新 WAV
  const r9b = await saveMute(3000, 4000);
  const hash9 = r9b.state.segments[0].hash;
  await page.evaluate(() => refresh());
  await waitFor(async () => {
    const info = await playerInfo(page);
    return info.label.includes(hash9.slice(0, 10)) ? info : null;
  }, 15000, 'current segment swapped');
  check('当前段实际变化时取新 WAV', segReqs.includes(0), segReqs);
  check('每次哈希变化只取一次（初次试听 + 两次切换 = 3 次）',
        segReqs.filter(x => x === 0).length === 3, segReqs);
  await page.unroute('**/api/segment/*.wav');

  // ------------------------------------------------------------------ 10
  console.log('\n== 10. 拉取期间暂停并拖动：切换后保持暂停并沿用位置 ==');
  await page.goto(BASE + '/');
  await waitFor(async () => (await page.locator('#main').isVisible()), 10000, 'page loaded');
  await audition(page, 0);                       // 第 1 段，正在播放
  let release;
  const gate = new Promise(r => { release = r; });
  await page.route('**/api/segment/0.wav', async route => {
    try { await gate; await route.continue(); } catch (e) { /* 已放行 */ }
  });
  const r10 = await saveMute(3000, 4000);
  const hash10 = r10.state.segments[0].hash;
  await page.evaluate(() => refresh());          // 发起拉取，挂在 gate 上
  await sleep(300);
  // 拉取在途：暂停 + 拖动
  await page.evaluate(() => { document.querySelector('#player').pause(); });
  await waitFor(async () => (await playerInfo(page)).paused, 5000, 'paused during fetch');
  await page.evaluate(() => { document.querySelector('#player').currentTime = 1.7; });
  await waitFor(async () => Math.abs((await playerInfo(page)).currentTime - 1.7) < 0.6,
                5000, 'seek during fetch');
  release();
  const info10 = await waitFor(async () => {
    const info = await playerInfo(page);
    return info.label.includes(hash10.slice(0, 10)) && info.duration !== null ? info : null;
  }, 15000, 'swap after pause during fetch');
  check('拉取期间暂停后，切换仍完成', info10.label.includes(hash10.slice(0, 10)), info10.label);
  check('切换后保持暂停', info10.paused === true, info10);
  check('沿用拉取期间的暂停位置(≈1.7s)', Math.abs(info10.currentTime - 1.7) < 0.8, info10.currentTime);
  await page.unroute('**/api/segment/0.wav');

  check('页面无 JS 异常', errors.length === 0, errors.join('; '));

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) { console.log('失败项：'); failed.forEach(f => console.log(' -', f.name)); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
