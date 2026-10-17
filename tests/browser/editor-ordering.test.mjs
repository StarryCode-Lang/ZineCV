import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from './fixtures/browser-test-server.mjs';

test('entry and module ordering handle quick release, cancel, keyboard, emulated touch and edge scrolling without content loss', { timeout: 90_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, '../..'));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, hasTouch: true, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`, { waitUntil: 'commit' });
    await page.waitForFunction(() => typeof window.$RefreshReg$ === 'function');
    await page.evaluate(() => import('/tests/browser/fixtures/mount-editor-ordering.tsx'));
    const editor = page.locator('#root');
    const state = async () => JSON.parse(await page.getByTestId('order-state').textContent());
    const entry = id => editor.locator(`[data-editor-entry-id="${id}"]`);
    const handle = id => entry(id).getByRole('button', { name: '拖动经历排序', exact: true });
    await handle('entry-0').waitFor();
    const baseline = await state();
    const checkContents = async () => {
      const current = await state();
      assert.deepEqual([...current.resume.work].sort((a,b)=>a.id.localeCompare(b.id)), [...baseline.resume.work].sort((a,b)=>a.id.localeCompare(b.id)));
    };
    await handle('entry-0').press('ArrowDown');
    assert.equal((await state()).resume.work[1].id, 'entry-0');
    assert.equal(await handle('entry-0').evaluate(node => node === document.activeElement), true);
    await handle('entry-0').press('ArrowUp');
    assert.deepEqual((await state()).resume.work, baseline.resume.work);
    const drag = async (from, to, cancel = false) => {
      await handle(from).scrollIntoViewIfNeeded();
      const a = await handle(from).boundingBox(), b = await entry(to).boundingBox();
      await page.mouse.move(a.x+a.width/2, a.y+a.height/2);
      await page.mouse.down();
      await page.mouse.move(b.x+40, b.y+b.height*.85);
      if (cancel) await page.keyboard.press('Escape');
      await page.mouse.up();
    };
    await drag('entry-0', 'entry-1');
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="order-state"]').textContent).resume.work[1].id === 'entry-0');
    const beforeCancel = await state();
    await drag('entry-1', 'entry-2', true);
    assert.deepEqual(await state(), beforeCancel);
    await checkContents();

    const cdp = await context.newCDPSession(page);
    const start = await handle('entry-1').boundingBox(), end = await entry('entry-2').boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x+10, y: start.y+10 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: end.x+40, y: end.y+end.height*.85 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="order-state"]').textContent).resume.work[2].id === 'entry-1');
    await checkContents();
    const first = (await state()).resume.work[0].id;
    await handle(first).scrollIntoViewIfNeeded();
    const a = await handle(first).boundingBox(), scroll = await editor.locator('.editor-scroll').boundingBox();
    const beforeScroll = await editor.locator('.editor-scroll').evaluate(node => node.scrollTop);
    await page.mouse.move(a.x+8,a.y+8); await page.mouse.down();
    await page.mouse.move(scroll.x+80,scroll.y+scroll.height-8);
    await page.waitForFunction(before => document.querySelector('#root .editor-scroll').scrollTop > before+80, beforeScroll);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await checkContents();

    await editor.locator('[data-editor-module="work"] .module-collapse-button').click();
    const education = editor.locator('[data-editor-module="education"]');
    await education.scrollIntoViewIfNeeded();
    const eh = await education.locator('.section-heading').boundingBox();
    const wh = await editor.locator('[data-editor-module="work"]').boundingBox();
    await page.mouse.move(eh.x+100,eh.y+eh.height/2); await page.mouse.down();
    await page.mouse.move(wh.x+100,wh.y+8); await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="order-state"]').textContent).order[0] === 'education');
    await checkContents();

    // Module dragging must scroll the actual editor at its edge as well.
    await editor.locator('[data-editor-module="work"] .module-collapse-button').click();
    const moduleHeading = editor.locator('[data-editor-module="work"] .section-heading');
    await moduleHeading.scrollIntoViewIfNeeded();
    const mh = await moduleHeading.boundingBox();
    const ms = await editor.locator('.editor-scroll').boundingBox();
    const scrollBeforeModuleDrag = await editor.locator('.editor-scroll').evaluate(node => node.scrollTop);
    const orderBeforeCancel = (await state()).order;
    await page.mouse.move(mh.x+100,mh.y+mh.height/2); await page.mouse.down();
    await page.mouse.move(ms.x+90,ms.y+ms.height-8);
    await page.waitForFunction(before => document.querySelector('#root .editor-scroll').scrollTop > before+60, scrollBeforeModuleDrag);
    await moduleHeading.dispatchEvent('pointercancel', { pointerId: 1, bubbles: true }); await page.mouse.up();
    assert.deepEqual((await state()).order, orderBeforeCancel);
    await checkContents();
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await server.close(); }
});
