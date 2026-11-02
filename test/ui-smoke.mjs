/**
 * 浏览器端 UI 冒烟测试（puppeteer-core + 本机 Chrome）：
 * 两个页面建房、加入、开局、写线索、拦截、破译、结算，并截图。
 *
 * 用法：先启动服务（PORT=3010），再 node test/ui-smoke.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.BASE || 'http://127.0.0.1:3010';
const SHOTS = path.join(ROOT, '.shots');
const WAIT = { polling: 100, timeout: 10000 };

const CHROME =
  process.env.CHROME_PATH ||
  [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

if (!CHROME) {
  console.log('未找到 Chrome，跳过 UI 冒烟测试；可用 CHROME_PATH 指定浏览器路径');
  process.exit(0);
}

fs.mkdirSync(SHOTS, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

async function shot(page, name) {
  await page.bringToFront();
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  console.log('截图：', `${name}.png`);
}

async function waitFn(page, fn, label) {
  try {
    await page.waitForFunction(fn, WAIT);
  } catch (error) {
    console.log(`等待失败：${label}`);
    console.log(await page.evaluate(() => document.body.innerText));
    throw error;
  }
}

async function waitSel(page, selector) {
  try {
    await page.waitForFunction((sel) => Boolean(document.querySelector(sel)), WAIT, selector);
  } catch (error) {
    console.log(`等待失败：${selector}`);
    console.log(await page.evaluate(() => document.body.innerText));
    throw error;
  }
}

async function setValue(page, selector, value) {
  const ok = await page.evaluate(
    (sel, next) => {
      const element = document.querySelector(sel);
      if (!element) return false;
      element.value = next;
      return true;
    },
    selector,
    value
  );
  assert(ok, `找不到 ${selector}`);
}

async function jsClick(page, selector) {
  const clicked = await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return false;
    element.click();
    return true;
  }, selector);
  assert(clicked, `找不到可点击元素：${selector}`);
}

async function confirmModal(page) {
  await waitSel(page, '.modal-overlay');
  await jsClick(page, '[data-modal="ok"]');
  await waitFn(page, () => !document.querySelector('.modal-overlay'), '关闭确认弹窗');
}

async function fillClues(page, clues) {
  const count = await page.evaluate((list) => {
    const inputs = document.querySelectorAll('.clue-input');
    if (inputs.length !== 3) return 0;
    inputs.forEach((input, index) => {
      input.value = list[index];
    });
    return inputs.length;
  }, clues);
  assert(count === 3, '应该有 3 个线索输入框');
}

async function pickCode(page, code) {
  const count = await page.evaluate((list) => {
    const selects = document.querySelectorAll('.code-pick');
    if (selects.length !== 3) return 0;
    selects.forEach((select, index) => {
      select.value = String(list[index]);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return selects.length;
  }, code);
  assert(count === 3, '应该有 3 个密码选择框');
}

const errors = [];
const browser = await puppeteer.launch({
  headless: true,
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  protocolTimeout: 30000,
  defaultViewport: { width: 1280, height: 1000 },
});

try {
  const pageA = await browser.newPage();
  await pageA.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  pageA.on('pageerror', (error) => errors.push(`A pageerror: ${error.message}`));
  pageA.on('console', (message) => {
    if (message.type() === 'error') errors.push(`A console: ${message.text()}`);
  });

  await pageA.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitFn(
    pageA,
    () => !document.querySelector('#view-home').classList.contains('hidden'),
    'A 首页显示'
  );
  await setValue(pageA, '#input-name', '甲');
  await pageA.select('#select-ai', 'off');
  await jsClick(pageA, '[data-action="create"]');
  await waitSel(pageA, '.room-code');
  const roomId = await pageA.$eval('.room-code', (element) => element.textContent.trim());
  console.log('A 创建房间：', roomId);

  const pageB = await browser.newPage();
  await pageB.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  pageB.on('pageerror', (error) => errors.push(`B pageerror: ${error.message}`));
  pageB.on('console', (message) => {
    if (message.type() === 'error') errors.push(`B console: ${message.text()}`);
  });

  await pageB.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitFn(
    pageB,
    () => !document.querySelector('#view-home').classList.contains('hidden'),
    'B 首页显示'
  );
  await setValue(pageB, '#input-name', '乙');
  await setValue(pageB, '#input-code', roomId);
  await jsClick(pageB, '[data-action="join"]');
  console.log('B 加入房间');

  await waitFn(
    pageA,
    () => document.querySelectorAll('.player-row').length === 2,
    '房间内两名玩家'
  );
  await shot(pageA, 'room');

  await jsClick(pageA, '[data-action="start"]');
  await confirmModal(pageA);
  await waitFn(
    pageA,
    () => !document.querySelector('#view-game').classList.contains('hidden'),
    '进入游戏界面'
  );
  await waitSel(pageA, '.clue-input');
  await waitSel(pageB, '.clue-input');
  await shot(pageA, 'game-encrypt');
  console.log('进入加密阶段');

  await fillClues(pageA, ['雾里的灯', '甜的东西', '上上下下']);
  await jsClick(pageA, '[data-action="submit-clues"]');
  await confirmModal(pageA);
  await waitFn(pageA, () => !document.querySelector('.clue-input'), 'A 提交线索');

  await fillClues(pageB, ['夜里的光', '很甜', '一层一层']);
  await jsClick(pageB, '[data-action="submit-clues"]');
  await confirmModal(pageB);
  console.log('双方提交线索');

  await waitSel(pageA, '[data-action="submit-intercept"]');
  await waitSel(pageB, '[data-action="submit-intercept"]');
  await shot(pageA, 'game-intercept');

  await pageB.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await shot(pageB, 'game-intercept-mobile');
  await pageB.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });

  await pickCode(pageA, [1, 2, 3]);
  await jsClick(pageA, '[data-action="submit-intercept"]');
  await confirmModal(pageA);
  await waitFn(
    pageA,
    () => !document.querySelector('[data-action="submit-intercept"]'),
    'A 提交拦截'
  );

  await pickCode(pageB, [1, 2, 3]);
  await jsClick(pageB, '[data-action="submit-intercept"]');
  await confirmModal(pageB);
  console.log('双方提交拦截');

  await waitSel(pageA, '[data-action="submit-decode"]');
  await waitSel(pageB, '[data-action="submit-decode"]');

  await pickCode(pageA, [4, 3, 2]);
  await jsClick(pageA, '[data-action="submit-decode"]');
  await confirmModal(pageA);
  await waitSel(pageB, '[data-action="submit-decode"]');

  await pickCode(pageB, [4, 3, 2]);
  await jsClick(pageB, '[data-action="submit-decode"]');
  await confirmModal(pageB);

  await waitSel(pageA, '.reveal-grid');
  await shot(pageA, 'game-reveal');
  console.log('进入结算');

  const text = await pageA.$eval('body', (element) => element.innerText);
  assert(text.includes('本轮结算'), '结算页应显示“本轮结算”');
  assert(text.includes('线索档案'), '结算页应显示线索档案');
  assert(text.includes('A 队') && text.includes('B 队'), '结算页应显示两队');

  await jsClick(pageA, '[data-action="next-round"]');
  await waitSel(pageA, '.clue-input');
  console.log('下一轮正常进入加密阶段');

  assert(errors.length === 0, `浏览器控制台报错：\n${errors.join('\n')}`);
  console.log('\n✅ UI 冒烟测试通过');
} finally {
  await browser.close();
}
