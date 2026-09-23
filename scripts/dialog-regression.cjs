const fs = require("fs");
const http = require("http");
const path = require("path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

process.chdir(path.resolve(__dirname, ".."));
const output = path.resolve(".artifacts/dialogs");
fs.mkdirSync(output, { recursive: true });

function serve(root) {
  const resolvedRoot = path.resolve(root);
  const server = http.createServer((request, response) => {
    let file;
    try {
      const requestPath = decodeURIComponent(
        request.url.split("?")[0],
      ).replace(/^[\\/]+/, "");
      file = path.resolve(resolvedRoot, requestPath);
    } catch {
      response.writeHead(400);
      response.end("Bad request");
      return;
    }
    const relativePath = path.relative(resolvedRoot, file);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(resolvedRoot, "index.html");
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
      }[path.extname(file)] || "application/octet-stream",
    );
    response.end(fs.readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

async function main() {
  const checks = [];
  const errors = [];
  const failedFonts = [];
  const browser = await chromium.launch({ headless: true });
  const server = await serve(path.resolve("dist"));
  const port = server.address().port;
  const traversalResponse = await new Promise((resolve, reject) => {
    const request = http.get(
      { hostname: "127.0.0.1", port, path: "/%2e%2e/package.json" },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, body }),
        );
      },
    );
    request.on("error", reject);
  });
  assert.deepEqual(traversalResponse, { status: 403, body: "Forbidden" });
  checks.push("local static server rejects path traversal outside dist");
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => {
    if (request.url().includes("/fonts/")) failedFonts.push(request.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      "resume-diy-state",
      JSON.stringify({
        basic: { name: "Dialog Regression", ageMode: "age" },
        education: [],
        skills: [],
        work: [
          {
            id: "dialog-regression-entry",
            title: "Synthetic dialog fixture",
            role: "",
            department: "",
            city: "",
            start: "",
            end: "",
            html: "<p>Local regression fixture.</p>",
          },
        ],
        projects: [],
        orgs: [],
        research: [],
        awards: [],
        other: [],
        portfolio: [],
        custom: [],
        summary: "",
      }),
    );
  });

  const activeText = () =>
    page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  const activeIsInsideDialog = () =>
    page.evaluate(() =>
      Boolean(
        document
          .querySelector('[role="alertdialog"]')
          ?.contains(document.activeElement),
      ),
    );

  try {
    await page.goto(`http://127.0.0.1:${port}`);
    await page.evaluate(() => document.fonts.ready);
    const entry = page.locator(".entry-card").first();
    const header = entry.locator(".entry-header");
    const deleteButton = entry.getByRole("button", {
      name: "删除经历",
      exact: true,
    });
    const initialClass = await entry.getAttribute("class");

    await deleteButton.focus();
    await deleteButton.press("Enter");
    await page.getByRole("alertdialog").waitFor();
    assert.equal(await activeText(), "取消");
    assert.equal(await activeIsInsideDialog(), true);
    assert.equal(await entry.getAttribute("class"), initialClass);
    assert.equal(
      await page.evaluate(() => document.elementFromPoint(8, 8)?.className),
      "dialog-backdrop",
    );

    await page.keyboard.press("Shift+Tab");
    assert.equal(await activeText(), "删除经历");
    await page.keyboard.press("Tab");
    assert.equal(await activeText(), "取消");
    await page.keyboard.press("Escape");
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
      "删除经历",
    );
    checks.push(
      "keyboard focus trap, backdrop shielding, Esc close and trigger restoration",
    );

    await header.focus();
    await header.press("Enter");
    assert.match(await entry.getAttribute("class"), /expanded/);
    await deleteButton.focus();
    await deleteButton.press("Enter");
    await page.getByRole("alertdialog").waitFor();
    assert.match(await entry.getAttribute("class"), /expanded/);
    await page.keyboard.press("Escape");
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
    assert.match(await entry.getAttribute("class"), /expanded/);
    checks.push(
      "entry action keyboard does not bubble into an extra card toggle",
    );

    assert.deepEqual(errors, []);
    assert.deepEqual(failedFonts, []);
    const result = { status: "PASS", checks, pageErrors: errors, failedFonts };
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  fs.writeFileSync(
    path.join(output, "failure.json"),
    JSON.stringify(
      { status: "FAIL", error: String(error), stack: error.stack },
      null,
      2,
    ),
  );
  console.error(error);
  process.exitCode = 1;
});
