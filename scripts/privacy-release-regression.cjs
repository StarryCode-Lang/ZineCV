const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const initialPath = path.join(root, "src/domain/initial-resume.ts");
const source = ts.createSourceFile(
  initialPath,
  fs.readFileSync(initialPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const initial = source.statements
  .flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? [...statement.declarationList.declarations]
      : [],
  )
  .find(
    (declaration) => declaration.name.getText(source) === "initialResume",
  )?.initializer;

function assertBlank(node, key = "") {
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      assert(
        ts.isPropertyAssignment(property),
        `Unexpected initial property ${key}`,
      );
      assertBlank(property.initializer, property.name.getText(source));
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    assert.equal(
      node.elements.length,
      0,
      `Public default ${key} must be empty`,
    );
    return;
  }
  assert(ts.isStringLiteral(node), `Unexpected public default ${key}`);
  assert.equal(
    node.text,
    key === "ageMode" ? "age" : "",
    `Public default ${key} must be blank`,
  );
}

assert(initial, "initialResume must be a literal, auditable object");
assertBlank(initial);

const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], {
  cwd: root,
})
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
assert(
  !tracked.some((file) => file.startsWith(".data/")),
  "User version data must not be tracked",
);
assert(
  !tracked.some((file) => /\.(?:pdf|docx|jpe?g|png|webp)$/i.test(file)),
  "Document and screenshot assets require a separate publication review",
);

const dist = path.join(root, "dist");
assert(
  fs.existsSync(path.join(dist, "index.html")),
  "Build the app before running the browser privacy check",
);
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
};
const server = http.createServer((request, response) => {
  const requestPath = decodeURIComponent(
    new URL(request.url || "/", "http://127.0.0.1").pathname,
  );
  const candidate = path.resolve(dist, `.${requestPath}`);
  const file =
    candidate.startsWith(`${dist}${path.sep}`) &&
    fs.existsSync(candidate) &&
    fs.statSync(candidate).isFile()
      ? candidate
      : path.join(dist, "index.html");
  response.setHeader(
    "Content-Type",
    mime[path.extname(file)] || "application/octet-stream",
  );
  response.end(fs.readFileSync(file));
});

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const fresh = await browser.newContext();
    const freshPage = await fresh.newPage();
    await freshPage.goto(url);
    await freshPage.locator(".resume-pages").waitFor();
    assert.equal(
      (await freshPage.locator(".resume-pages").innerText()).trim(),
      "",
      "Fresh public preview must be blank",
    );
    await freshPage.waitForFunction(
      () => localStorage.getItem("resume-diy-state") !== null,
    );
    const publicDraft = await freshPage.evaluate(() =>
      JSON.parse(localStorage.getItem("resume-diy-state")),
    );
    assert.equal(publicDraft.basic.name, "");
    assert.equal(publicDraft.education.length, 0);
    await fresh.close();

    const returning = await browser.newContext();
    await returning.addInitScript(() => {
      localStorage.setItem(
        "resume-diy-state",
        JSON.stringify({
          basic: { name: "示例用户", ageMode: "age" },
          education: [],
          skills: [],
          work: [],
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
    const returningPage = await returning.newPage();
    await returningPage.goto(url);
    await returningPage
      .getByText("示例用户", { exact: true })
      .first()
      .waitFor();
    assert(
      (await returningPage.locator(".resume-pages").innerText()).includes(
        "示例用户",
      ),
      "Existing local draft must be restored",
    );
    await returning.close();
    console.log(
      "PASS: public default is blank; isolated saved draft is restored; user version files remain untracked",
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
