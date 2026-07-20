import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = new URL("../src/page.js", import.meta.url);
const webuiPath = new URL("../../cloudflare-webui/worker.js", import.meta.url);
const serverPath = new URL("../../server.js", import.meta.url);
const loonPath = new URL("../../../ios-location-spoofer.lnplugin", import.meta.url);

const pages = [
  ["source page", await readFile(sourcePath, "utf8")],
  ["webui artifact", await readFile(webuiPath, "utf8")],
  ["node server page", await readFile(serverPath, "utf8")],
];

for (const [label, content] of pages) {
  test(`${label} exposes favorite controls`, () => {
    assert.match(content, /id="favadd"/);
    assert.match(content, /id="favlistbtn"/);
    assert.match(content, /function addFavorite\(\)/);
    assert.match(content, /function applyFavorite\(/);
    assert.match(content, /localStorage\.getItem\(FAV_KEY\)/);
    assert.match(content, /FAV_MAX\s*=\s*12/);
  });

  test(`${label} loads favorite pin without auto-save`, () => {
    assert.match(content, /function applyFavorite\(it\)\{[\s\S]*?saved\s*=\s*false;[\s\S]*?toast\("已加载收藏，确认后保存"\);\s*\}/);
    assert.doesNotMatch(content, /function applyFavorite\(it\)\{[\s\S]*?commit\(\);[\s\S]*?\}/);
  });
}

test("Loon plugin exposes editable accuracy arguments", async () => {
  const content = await readFile(loonPath, "utf8");
  assert.match(content, /horizontalAccuracy\s*=\s*input,"39"/);
  assert.match(content, /verticalAccuracy\s*=\s*input,"1000"/);
  assert.match(
    content,
    /argument=\[\{enabled\},\{latitude\},\{longitude\},\{altitude\},\{horizontalAccuracy\},\{verticalAccuracy\},\{address\},\{configHost\},\{configToken\},\{configUrl\},\{debug\}\]/,
  );
  assert.match(content, /script-path=https:\/\/raw\.githubusercontent\.com\/mekos2772\/ios-location-spoofer\/main\/location-spoofer\.js/);
});
