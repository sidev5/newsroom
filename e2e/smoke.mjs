// One browser smoke test of the production build against a local mock of Supabase (e2e/mock-supabase.mjs):
//   an employee submits a story -> an editor signs in and approves it -> it appears on the homepage -> the digest preview shows it.
// Run with `npm run e2e`. It always builds the app first (a reused build would serve the cached pages of an earlier run), starts it on E2E_PORT (default 3199)
// and drives it with Chrome through playwright-core. Chrome is found automatically; set E2E_CHROME to its path if it is not.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { ADMIN, startMock } from "./mock-supabase.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 54399);
const PORT = Number(process.env.E2E_PORT ?? 3199);
const SITE = `http://127.0.0.1:${PORT}`;
const next = join(root, "node_modules", "next", "dist", "bin", "next");

const env = {
  ...process.env,
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "mock-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "mock-service-key",
  CRON_SECRET: "e2e-secret-0123456789abcdefghijkl",
  ADMIN_EMAILS: ADMIN.email,
  ALLOWED_EMAIL_DOMAINS: "example.com",
  SITE_URL: SITE,
  EMAIL_PROVIDER: "none",
  CSP_MODE: "report-only",
};
for (const k of ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "SMTP_HOST", "APP_URL"]) delete env[k];

const chrome = [process.env.E2E_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));

let server;
let mock;
let browser;
const stop = async () => {
  await browser?.close().catch(() => {});
  if (server?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
    else server.kill("SIGTERM");
  }
  await mock?.close().catch(() => {});
};

const step = (msg) => console.log(`\n• ${msg}`);
function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the server did not answer at ${url} within ${ms / 1000} s`);
}

async function main() {
  if (!chrome) throw new Error("Chrome was not found: set E2E_CHROME to the path of chrome.exe / chrome / msedge");
  mock = await startMock({ port: MOCK_PORT });

  {
    step("building the app against the mock (a few minutes)");
    // A clean build: the data cache in .next/cache would otherwise carry stories from an earlier run into this one.
    rmSync(join(root, ".next"), { recursive: true, force: true });
    // Asynchronous on purpose: the build fetches the homepage's data from the mock, which lives in this process.
    const code = await new Promise((resolve) => spawn(process.execPath, [next, "build"], { cwd: root, env, stdio: "inherit" }).on("exit", resolve));
    if (code !== 0) throw new Error("next build failed");
  }
  step(`starting the app on ${SITE}`);
  server = spawn(process.execPath, [next, "start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
  await waitFor(`${SITE}/submit`);

  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  // In report-only mode Chrome logs every violation as "[Report Only] Refused to ..."; none may appear on any page of the flow.
  const violations = [];
  page.on("console", (m) => { if (/content security policy|\[report only\]/i.test(m.text())) violations.push(`${page.url()}: ${m.text().slice(0, 200)}`); });

  const TITLE = "Pilot line reaches first production milestone";
  const PARAGRAPH = `${"The pilot line reached its first production milestone this quarter, with output rising steadily while unit costs fell. ".repeat(3)}Suppliers in the region are expanding capacity to keep up.`;
  const CODE = "const line = { output: 120 };\n\tconsole.log(line.output);";

  step("an employee writes a story with blocks");
  await page.goto(`${SITE}/submit`);
  check(await page.getByRole("link", { name: /skip to/i }).count() > 0, "the skip-to-content link is on the page");
  check((await page.locator("body").innerText()).toLowerCase().includes("ip"), "the privacy notice is on the form page");
  check((await page.locator("header").first().innerText()).includes("Write"), "the page header says Write");
  await page.fill("#title", TITLE);
  await page.selectOption("#sector", "ev");
  const addBlock = async (label, afterIndex) => {
    await page.getByRole("button", { name: afterIndex === 0 ? "Add a block at the start" : `Add a block after block ${afterIndex}` }).click();
    await page.getByRole("menuitem", { name: label }).click();
  };
  await addBlock("Paragraph", 0);
  await page.locator('textarea[id^="field-"]').first().fill(PARAGRAPH);
  await addBlock("Heading (H2)", 1);
  await page.locator('input[id^="field-"]').first().fill("Why it matters");
  await addBlock("Code", 2);
  await page.getByLabel("Code", { exact: true }).fill(CODE);
  await page.getByLabel("File name (optional)").fill("line.js");
  // a block can be added between two others, and moved
  await addBlock("Paragraph", 1);
  check((await page.locator("section[aria-label^='Paragraph']").count()) === 2, "a block was added between two others");
  await page.getByRole("button", { name: /^Move Paragraph 2 down$/ }).click();
  check((await page.locator("ol > li section").first().getAttribute("aria-label"))?.startsWith("Paragraph"), "blocks can be moved");
  await page.getByRole("button", { name: /^Delete Paragraph/ }).last().click();
  check((await page.locator("section[aria-label^='Paragraph']").count()) === 1, "a block can be deleted");

  await page.getByRole("button", { name: "Preview" }).click();
  const preview = page.getByRole("region", { name: "Preview of your story" });
  check((await preview.innerText()).includes("Why it matters") && (await preview.innerText()).includes("line.js"), "the preview shows the blocks as they will look");
  await page.getByRole("button", { name: "Back to editing" }).click();

  await page.fill("#firstName", "Ada");
  await page.fill("#lastName", "Lovelace");
  await page.fill("#email", "ada@example.com");
  await page.selectOption("#authorDepartment", { index: 1 });
  await page.check('input[name="showName"]');
  await page.check('input[name="ownWork"]');
  await page.check('input[name="noConfidential"]');
  check(await page.evaluate(() => Boolean(window.localStorage.getItem("newsroom-write-draft-v1"))) || (await page.waitForTimeout(900), await page.evaluate(() => Boolean(window.localStorage.getItem("newsroom-write-draft-v1")))), "a draft was saved in the browser");
  await page.getByRole("button", { name: /submit for review/i }).click();
  await page.waitForURL(/\/submit\/thanks/);
  check(true, "the thank-you page opened");
  check(await page.evaluate(() => window.localStorage.getItem("newsroom-write-draft-v1")) === null, "the draft was cleared after sending");
  const stored = mock.tables.articles;
  check(stored.length === 1 && stored[0].status === "pending_review" && stored[0].origin === "employee", "one employee story is waiting for review");
  check(stored[0].body_format === "blocks" && stored[0].body_blocks?.blocks?.map((b) => b.type).join() === "paragraph,heading,code", "it is stored as blocks, in the order written");
  check(stored[0].body_blocks.blocks[2].code === CODE, "the code is stored exactly, tab included");
  check(mock.tables.article_submitters.length === 1 && mock.tables.article_submitters[0].email === "ada@example.com", "its submitter row is stored");
  step("the story is not on the homepage yet");
  const scripts = new Set();
  const onResponse = (r) => { if (r.url().endsWith(".js") || r.url().includes(".js?")) scripts.add(r.url()); };
  page.on("response", onResponse);
  await page.goto(`${SITE}/`);
  check(!(await page.content()).includes(TITLE), "the homepage does not show an unapproved story");
  await page.waitForTimeout(1500);
  page.off("response", onResponse);
  let carriesHighlighter = false;
  for (const url of scripts) if ((await (await fetch(url)).text()).includes("hljs-")) carriesHighlighter = true;
  check(scripts.size > 0 && !carriesHighlighter, "the homepage does not load the syntax highlighter");

  step("an editor signs in");
  await page.goto(`${SITE}/admin/review`);
  await page.waitForURL(/\/admin\/login/);
  check(true, "a signed-out visitor to /admin/review is sent to the login page");
  await page.fill('input[name="email"]', ADMIN.email);
  await page.fill('input[name="password"]', ADMIN.password);
  await page.locator("form button").first().click();
  await page.waitForURL(/\/admin\/review/);
  check(true, "the editor is on the review page");

  step("the editor approves the story");
  await page.getByText(TITLE).first().click();
  await page.getByRole("button", { name: "Approve and publish" }).first().click();
  await page.waitForTimeout(1500);
  const live = mock.tables.articles[0];
  check(live.status === "published" && Boolean(live.published_at), "the story is published");
  check(mock.tables.review_log.some((r) => r.action === "approve" && r.actor_email === ADMIN.email), "the approval is in the audit log with the editor's address");

  step("it appears on the homepage");
  let onHome = false;
  for (let i = 0; i < 10 && !onHome; i++) {
    await page.goto(`${SITE}/`);
    onHome = (await page.content()).includes(TITLE);
    if (!onHome) await page.waitForTimeout(1000);
  }
  check(onHome, "the homepage lists the approved story");
  await page.goto(`${SITE}/article/${live.slug}`);
  check((await page.locator("body").innerText()).includes("Ada Lovelace"), "its article page names the author");
  await page.waitForSelector(".hljs-keyword", { timeout: 15000 });
  check(true, "its code block is highlighted (the highlighter loaded when the block appeared)");
  const bodyText = await page.locator("body").innerText();
  check(bodyText.includes("Why it matters") && /min read/.test(bodyText), "the story is drawn as blocks, with its reading time");
  check((await page.locator("pre code").first().innerText()).includes("\tconsole.log"), "the code keeps its tab");
  check((await page.getByRole("button", { name: /^Copy the JavaScript code/ }).count()) === 1, "the code block has a Copy button");
  await page.getByText("Likes and comments are not switched on for this site yet.").waitFor();
  check(true, "likes and comments say they are off while mail and the company domain list are not set up");
  check(!(await page.content()).includes("ada@example.com"), "the author's email address is nowhere on the public page");

  step("the slide-in reader on the dashboard shows the blocks");
  await page.goto(`${SITE}/`);
  await page.getByText(TITLE).first().click();
  const reader = page.getByRole("complementary", { name: "Story reader" });
  await reader.getByText("Why it matters").waitFor({ timeout: 20000 });
  check(true, "the reader opened with the story's heading");
  await reader.locator(".hljs-keyword").first().waitFor({ timeout: 20000 });
  check(true, "its code is highlighted inside the reader (the highlighter loaded only now)");
  check((await reader.innerText()).includes("min read"), "the reader shows the reading time");
  check((await reader.getByRole("button", { name: /^Copy the JavaScript code/ }).count()) === 1, "the reader's code block has a Copy button");
  check((await reader.getByRole("img").count()) === 0, "the reader's frame is unchanged: the department photo is not repeated above a Write story");

  step("an AI-written blocks story is drawn with its cover, credits and sources, and has no likes or comments");
  const aiBlocks = [
    { id: "b1", type: "paragraph", text: "An AI-written explainer starts here, summarising one source." },
    { id: "b2", type: "heading", level: 2, text: "How it works" },
    { id: "b3", type: "image", src: "https://images.unsplash.com/photo-1?ixid=x", alt: "A server room", caption: "Racks of servers", credit: "Ada Lovelace", creditUrl: "https://unsplash.com/@ada?utm_source=ai_newsroom&utm_medium=referral" },
    { id: "b4", type: "code", language: "python", code: "print('hello')" },
    { id: "b5", type: "heading", level: 2, text: "Sources" },
    { id: "b6", type: "link", url: "https://example.com/original", title: "The original source", description: "The original source, published 10 October 2026" },
  ];
  mock.tables.articles.push({
    id: "ai-1", slug: "ai-explainer-1", headline: "An AI explainer", body: "An AI-written explainer starts here, summarising one source.", summary: "An AI explainer.", status: "published",
    published_at: new Date().toISOString(), created_at: new Date().toISOString(), origin: "ai", body_format: "blocks", body_blocks: { v: 1, blocks: aiBlocks },
    image_url: "/images/defaults/software.svg", image_alt: null, department_id: "dept-ev", source_urls: ["https://example.com/original"], source_published_at: "2026-10-10T08:00:00Z",
  });
  await page.goto(`${SITE}/article/ai-explainer-1`);
  const ai = await page.locator("body").innerText();
  check(ai.includes("How it works") && ai.includes("The original source") && /min read/.test(ai), "the AI story is drawn as blocks, with its sources link and reading time");
  check(ai.includes("Photo by") && ai.includes("Ada Lovelace"), "its picture carries the photographer's credit");
  check((await page.locator("main figure img").count()) >= 2, "it has its cover photo as well as the picture in the text");
  await page.locator("pre code").first().waitFor();
  check(!ai.includes("Comments (") && !ai.includes("Sign in to like"), "an AI-written story has no likes or comments");

  step("the digest preview shows it");
  await page.goto(`${SITE}/admin/digest`);
  await page.getByRole("button", { name: /create this week/i }).click();
  await page.waitForSelector('iframe[title="Email preview"]');
  const html = (await page.locator('iframe[title="Email preview"]').getAttribute("srcdoc")) ?? "";
  check(html.includes(TITLE), "the email preview contains the approved story");

  step("the security headers are on the public pages");
  const res = await page.goto(`${SITE}/`);
  const headers = res.headers();
  check(Boolean(headers["content-security-policy-report-only"] || headers["content-security-policy"]), "a Content-Security-Policy header is sent");
  check(headers["x-content-type-options"] === "nosniff", "X-Content-Type-Options: nosniff is sent");

  const csp = headers["content-security-policy-report-only"] ?? headers["content-security-policy"] ?? "";
  check(/script-src 'self' 'unsafe-inline'/.test(csp) && !/nonce-/.test(csp), "the policy uses no nonce, so the homepage can stay statically cached");
  check(violations.length === 0, `no CSP violations on any page of the flow${violations.length ? `: ${violations.join(" | ")}` : ""}`);
  check(problems.length === 0, `no uncaught browser errors${problems.length ? `: ${problems.join("; ")}` : ""}`);
  console.log("\nSmoke test passed.");
}

main()
  .then(() => stop().then(() => process.exit(0)))
  .catch(async (err) => {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    if (mock) console.error(`(last mock requests)\n${mock.requests.slice(-15).join("\n")}`);
    await stop();
    process.exit(1);
  });
