/** Device names for the Settings device list. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceInfo, deviceLabel } from "../../src/lib/device.ts";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0",
};

test("phones are named with their browser, and Chrome-based browsers aren't all called Chrome", () => {
  assert.equal(deviceLabel(UA.iphoneSafari), "iPhone · Safari");
  assert.equal(deviceLabel(UA.iphoneChrome), "iPhone · Chrome");
  assert.equal(deviceLabel(UA.androidChrome), "Android phone · Chrome");
  assert.equal(deviceLabel(UA.androidSamsung), "Android phone · Samsung Internet");
  assert.equal(deviceLabel(UA.windowsEdge), "Windows PC · Edge");
  assert.equal(deviceLabel(UA.macFirefox), "Mac · Firefox");
});

test("phones and tablets count as mobile, computers don't", () => {
  assert.equal(deviceInfo(UA.iphoneSafari).mobile, true);
  assert.equal(deviceInfo(UA.androidChrome).mobile, true);
  assert.equal(deviceInfo(UA.windowsEdge).mobile, false);
});

test("an empty or unknown user agent still gets a name", () => {
  assert.equal(deviceLabel(""), "Unknown device");
  assert.equal(deviceLabel(null), "Unknown device");
  assert.equal(deviceLabel("curl/8.5.0"), "Script");
});
