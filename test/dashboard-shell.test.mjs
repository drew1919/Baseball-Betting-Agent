import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderPage } from "../dist/page.js";

const html = renderPage({ batters: [], pitchers: [] });
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

assert.match(html, /Today's betting dashboard/);
assert.match(html, /id="mobile-today"[^>]+aria-selected="true"/);
assert.match(html, /id="bestBetsGrid"/);
assert.match(html, /id="winnerGrid"/);
assert.match(html, /id="nrfiGrid"/);
assert.match(html, /id="strikeoutGrid"/);
assert.match(html, /id="resultsGrid"/);
assert.match(client, /var mobileView = "today"/);
assert.match(client, /No validated best bet today/);
assert.match(client, /loadTodayDashboard\(false\)/);
assert.match(client, /setWorkspaceView\("chat"\)/);

console.log("Today dashboard shell assertions passed");
