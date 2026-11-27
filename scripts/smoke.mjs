// Smoke test for a running pOS: is the Worker up, is the database answering, are the static files and security
// headers right? Read-only by default, so it is safe to run against production right after a deploy.
//
//   npm run smoke                                  http://localhost:8787 (npm run dev:api or npm run preview)
//   npm run smoke -- https://pos.example.com       a deployed Worker (or set SMOKE_URL)
//   npm run smoke -- http://localhost:8787 --write also signs up a throwaway account and calls /api/me with it.
//                                                  Creates a row in the database: only use on local or staging.
//
// Exits 1 if any check fails.
const args = process.argv.slice(2);
const write = args.includes("--write");
const base = (args.find((a) => !a.startsWith("--")) || process.env.SMOKE_URL || "http://localhost:8787").replace(
  /\/+$/,
  "",
);
const https = base.startsWith("https://");

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}
function must(cond, message) {
  if (!cond) throw new Error(message);
}
const get = (path, init) => fetch(base + path, { redirect: "manual", ...init });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Smoke test: ${base}${write ? " (write mode)" : ""}`);

// A deploy can take a few seconds to reach every location, so the first check retries.
await check("GET /api/health: Worker up and D1 answers", async () => {
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await get("/api/health");
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body.ok === true && body.db === true) return;
      last = `status ${res.status}, body ${JSON.stringify(body)}`;
    } catch (e) {
      last = String(e.cause?.code || e.message);
    }
    if (attempt < 4) await sleep(3000);
  }
  throw new Error(last);
});

await check("GET /: the app shell with its security headers", async () => {
  const res = await get("/");
  must(res.status === 200, `status ${res.status}`);
  must((res.headers.get("content-type") || "").includes("text/html"), "not HTML");
  must((await res.text()).includes('id="root"'), "no #root element");
  const h = (n) => res.headers.get(n) || "";
  must(h("x-frame-options") === "DENY", "x-frame-options missing");
  must(h("x-content-type-options") === "nosniff", "x-content-type-options missing");
  must(/default-src 'self'/.test(h("content-security-policy")), "content-security-policy missing");
  if (https) must(h("strict-transport-security"), "strict-transport-security missing");
});

await check("GET /robots.txt: plain text, not the app shell", async () => {
  const res = await get("/robots.txt");
  must(res.status === 200, `status ${res.status}`);
  must(
    (res.headers.get("content-type") || "").includes("text/plain"),
    `content-type ${res.headers.get("content-type")}`,
  );
  must(/User-agent:/i.test(await res.text()), "no User-agent line");
});

await check("GET /manifest.webmanifest: installable PWA", async () => {
  const res = await get("/manifest.webmanifest");
  must(res.status === 200, `status ${res.status}`);
  must((await res.json()).name === "pOS", "unexpected manifest name");
});

await check("GET /sw.js: service worker is never cached", async () => {
  const res = await get("/sw.js");
  must(res.status === 200, `status ${res.status}`);
  must(
    /no-cache|no-store/.test(res.headers.get("cache-control") || ""),
    "cache-control would let browsers keep an old worker",
  );
});

await check("GET /api/auth/config: public API answers", async () => {
  const res = await get("/api/auth/config");
  must(res.status === 200, `status ${res.status}`);
  must(typeof (await res.json()).minPassword === "number", "unexpected body");
});

await check("GET /api/me without a session: refused", async () => {
  const res = await get("/api/me");
  must(res.status === 401, `status ${res.status} (expected 401)`);
  must(/no-store/.test(res.headers.get("cache-control") || ""), "API responses must be no-store");
});

await check("POST without the client header: refused (CSRF guard), nothing is created", async () => {
  const res = await get("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "csrf-check@example.com", name: "x", password: "not-used-never-created" }),
  });
  must(res.status === 403, `status ${res.status} (expected 403)`);
  must(/client header/i.test(await res.text()), "refused for some other reason");
});

if (write) {
  await check("sign up, then GET /api/me with the new session", async () => {
    const email = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const up = await get("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-pos-client": "1" },
      body: JSON.stringify({
        email,
        name: "Smoke Test",
        password: `smoke-${Math.random().toString(36).slice(2)}-test`,
      }),
    });
    const text = await up.text();
    must(up.status === 200, `sign-up status ${up.status}: ${text.slice(0, 120)}`);
    const cookie = /((?:__Host-)?pos_session=[^;]+)/.exec(up.headers.get("set-cookie") || "")?.[1];
    must(cookie, "no session cookie");
    const me = await get("/api/me", { headers: { cookie } });
    must(me.status === 200, `/api/me status ${me.status}`);
    must((await me.json()).user?.email === email, "/api/me returned another user");
    await get("/api/auth/signout", { method: "POST", headers: { cookie, "x-pos-client": "1" } });
  });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
