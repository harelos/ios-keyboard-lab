// On a real iOS Simulator (Safari): does a tap that lands in a frame open the keyboard for a field in the page around it?
// mode=async = Foundry's old way (the field is focused 0.5 s after the tap), mode=sync = the new way (focused in the tap's
// touchend), one=1 = one field that changes to a password field while it has the keyboard. Native taps through Appium.
import { remote } from 'webdriverio';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const RUNTIME = opt('runtime', 'iOS 26.5'), DEVICE = opt('device', 'iPhone 17'), OUT = path.resolve(opt('out', 'out'));
const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const srv = spawn('python3', ['-m', 'http.server', '8000', '--bind', '127.0.0.1'], { cwd: path.resolve('page'), stdio: 'ignore' });
const rts = JSON.parse(sh('xcrun simctl list runtimes -j')).runtimes.filter((r) => r.isAvailable !== false);
const rt = rts.find((r) => r.name === RUNTIME) || rts.find((r) => r.name.startsWith(RUNTIME)) || rts.filter((r) => r.name.startsWith('iOS')).pop();
const dt = JSON.parse(sh('xcrun simctl list devicetypes -j')).devicetypes.find((d) => d.name === DEVICE);
const udid = sh(`xcrun simctl create "kb ${DEVICE}" "${dt.identifier}" "${rt.identifier}"`);
sh(`xcrun simctl boot ${udid}`);
sh(`xcrun simctl bootstatus ${udid} -b`);
const R = { device: DEVICE, runtime: rt.name, cases: [] };
let driver;
try {
  driver = await remote({
    hostname: '127.0.0.1', port: 4723, path: '/', logLevel: 'error', connectionRetryTimeout: 1200000, connectionRetryCount: 1,
    capabilities: {
      platformName: 'iOS', browserName: 'Safari', 'appium:automationName': 'XCUITest', 'appium:udid': udid, 'appium:platformVersion': rt.version,
      'appium:deviceName': DEVICE, 'appium:language': 'en', 'appium:locale': 'en_US', 'appium:newCommandTimeout': 600,
      'appium:wdaLaunchTimeout': 900000, 'appium:wdaConnectionTimeout': 900000, 'appium:derivedDataPath': process.env.WDA_DIR,
      'appium:webviewConnectTimeout': 45000, 'appium:simulatorStartupTimeout': 600000, 'appium:connectHardwareKeyboard': false,
      'appium:safariInitialUrl': 'about:blank', 'appium:safariIgnoreFraudWarning': true,
      ...(process.env.WDA_APP ? { 'appium:usePreinstalledWDA': true, 'appium:prebuiltWDAPath': process.env.WDA_APP } : {}),
    },
  });
  await driver.setTimeout({ pageLoad: 60000, script: 30000 });
  const web = await driver.getContext();
  const native = async (fn) => { await driver.switchContext('NATIVE_APP'); try { return await fn(); } finally { await driver.switchContext(web); } };
  const kb = () => native(async () => ({
    shown: await driver.isKeyboardShown().catch((e) => 'err ' + String(e.message).slice(0, 60)),
    keyboards: (await driver.$$('//XCUIElementTypeKeyboard')).length,
    secure: (await driver.$$('//XCUIElementTypeSecureTextField')).length,
  }));
  const tapAt = (x, y) => native(() => driver.execute('mobile: tap', { x, y }));
  for (const c of [{ mode: 'async' }, { mode: 'sync' }, { mode: 'sync', one: '1' }]) {
    const tag = c.mode + (c.one ? '-one' : ''), C = { case: tag, steps: [] };
    R.cases.push(C);
    await driver.url('http://127.0.0.1:8000/parent.html?mode=' + c.mode + (c.one ? '&one=1' : ''));
    for (let i = 0; i < 40; i++) {
      const ok = await driver.execute('var f=document.getElementById("f");return !!(f&&f.contentDocument&&f.contentDocument.getElementById("em"))').catch(() => false);
      if (ok) break;
      await sleep(500);
    }
    await sleep(1200);
    if (!R.tipClosed) {
      await native(async () => { const x = await driver.$('//XCUIElementTypeButton[(@label="Close" or @name="Close") and not(ancestor::XCUIElementTypeWebView)]'); if (await x.isExisting()) await x.click(); }).catch(() => {});
      R.tipClosed = true;
      await sleep(800);
    }
    const pos = await driver.execute('var f=document.getElementById("f"),d=f.contentDocument,fr=f.getBoundingClientRect();function c(id){var r=d.getElementById(id).getBoundingClientRect();return {x:fr.left+r.left+r.width/2,y:fr.top+r.top+r.height/2}}return {em:c("em"),pw:c("pw"),lnk:c("lnk"),ih:innerHeight,vv:visualViewport.height}');
    const wv = await native(async () => { const e = await driver.$('//XCUIElementTypeWebView'); return Object.assign({}, await e.getLocation(), await e.getSize()); });
    C.pos = pos; C.webview = wv;
    const step = async (name, id, wait) => {
      await tapAt(Math.round(wv.x + pos[id].x), Math.round(wv.y + pos[id].y));
      await sleep(wait);
      const k = await kb();
      const w = await driver.execute('var a=document.activeElement;return {active:a&&a.id,type:document.getElementById("ftx").type,ftx:document.getElementById("ftx").value,fpw:document.getElementById("fpw").value,vv:Math.round(visualViewport.height),events:events.slice()}');
      await driver.saveScreenshot(path.join(OUT, `${tag}-${name}.png`)).catch(() => {});
      const s = Object.assign({ step: name }, k, w);
      C.steps.push(s);
      console.log(tag, name, JSON.stringify(s).slice(0, 400));
      return s;
    };
    const s1 = await step('1-tap-email', 'em', 1800);
    if (s1.keyboards) {      // type on the real keyboard
      for (const ch of ['a', 'b']) await native(async () => { const k = await driver.$(`//XCUIElementTypeKey[@name="${ch}"]`); if (await k.isExisting()) await k.click(); });
      await sleep(600);
      C.typed = await driver.execute('return {ftx:document.getElementById("ftx").value,active:document.activeElement&&document.activeElement.id}');
      console.log(tag, 'typed', JSON.stringify(C.typed));
    }
    await step('2-tap-password', 'pw', 1800);
    await step('3-tap-link', 'lnk', 1600);
  }
} catch (e) {
  R.error = String((e && e.stack) || e).slice(0, 2000);
  console.log('ERROR', R.error.slice(0, 500));
  try { await driver.saveScreenshot(path.join(OUT, '99-error.png')); } catch {}
} finally {
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 1));
  try { if (driver) await driver.deleteSession(); } catch {}
  try { sh(`xcrun simctl shutdown ${udid}`); sh(`xcrun simctl delete ${udid}`); } catch {}
  srv.kill();
}
