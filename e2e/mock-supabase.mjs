// A small local stand-in for Supabase (PostgREST, GoTrue, Storage) for the smoke test. It understands just the requests this app makes:
// select with filters / order / limit / offset / count / embeds, insert, upsert, update, delete, single-object answers, the password login,
// the user lookup and the storage calls. It keeps everything in memory and is NOT a model of real Supabase: it exists so the real app,
// built for production, can be driven in a browser without a database.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.mock-signature`;

export const ADMIN = { email: "editor@example.com", password: "correct horse battery" };

const DEFAULTS = {
  articles: () => ({ created_at: new Date().toISOString(), published_at: null, summary: null, image_url: null, country_code: null, country_name: null, source_urls: [], origin: "ai" }),
  digests: () => ({ status: "draft", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), article_ids: [] }),
  digest_recipients: () => ({ active: true, created_at: new Date().toISOString() }),
  digest_log: () => ({ created_at: new Date().toISOString() }),
  review_log: () => ({ created_at: new Date().toISOString() }),
  article_submitters: () => ({ submitted_at: new Date().toISOString() }),
};

// Foreign keys used by embedded selects such as departments(name, slug): table name -> column on the parent row.
const FK = { departments: "department_id", sources: "source_id", articles: "article_id" };

export function startMock({ port, log = false }) {
  const tables = {
    departments: [
      { id: "dept-ev", slug: "ev", name: "EV", kind: "company" },
      { id: "dept-batt", slug: "batteries", name: "Batteries", kind: "company" },
      { id: "dept-world", slug: "world", name: "World", kind: "world" },
    ],
    articles: [], article_submitters: [], digests: [], digest_recipients: [], digest_log: [], review_log: [], raw_items: [], sources: [], pipeline_runs: [], agent_runs: [],
  };
  const files = new Map();
  const requests = [];
  const user = { id: "user-1", aud: "authenticated", role: "authenticated", email: ADMIN.email, app_metadata: {}, user_metadata: {}, factors: [], created_at: new Date().toISOString() };

  const session = () => {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: jwt({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", exp: now + 3600, iat: now }),
      token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: randomUUID(), user,
    };
  };

  const parseValue = (v) => (v === "null" ? null : v === "true" ? true : v === "false" ? false : v);
  const same = (a, b) => String(a) === String(b);
  const num = (a, b) => (Number.isNaN(Number(a)) || Number.isNaN(Number(b)) ? String(a).localeCompare(String(b)) : Number(a) - Number(b));

  /** One filter from `col=op.value`; returns a predicate or null when the key is not a filter. */
  function filterOf(key, raw) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) return null;
    let [op, ...rest] = raw.split(".");
    let value = rest.join(".");
    let negate = false;
    if (op === "not") { negate = true; [op, ...rest] = value.split("."); value = rest.join("."); }
    let test;
    if (op === "eq") test = (r) => same(r[key], value);
    else if (op === "neq") test = (r) => !same(r[key], value);
    else if (op === "is") test = (r) => (r[key] ?? null) === parseValue(value);
    else if (op === "in") {
      const list = value.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, ""));
      test = (r) => list.some((x) => same(r[key], x));
    } else if (op === "lt") test = (r) => r[key] != null && num(r[key], value) < 0;
    else if (op === "lte") test = (r) => r[key] != null && num(r[key], value) <= 0;
    else if (op === "gt") test = (r) => r[key] != null && num(r[key], value) > 0;
    else if (op === "gte") test = (r) => r[key] != null && num(r[key], value) >= 0;
    else throw new Error(`mock: unsupported filter ${key}=${raw}`);
    return negate ? (r) => !test(r) : test;
  }

  /** Splits a select list at top-level commas: "id, departments(name, slug)" -> ["id", "departments(name, slug)"]. */
  function splitSelect(s) {
    const out = []; let depth = 0; let cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function project(row, select) {
    if (!select || select === "*") return { ...row };
    const out = {};
    for (const item of splitSelect(select)) {
      const m = /^(?:\w+:)?(\w+)(?:!\w+)?\((.*)\)$/.exec(item);
      if (m) {
        const [, rel, inner] = m;
        const fk = FK[rel];
        const target = (tables[rel] ?? []).find((t) => fk && t.id === row[fk]);
        out[rel] = target ? project(target, inner) : null;
      } else if (item === "*") Object.assign(out, row);
      else out[item] = row[item] ?? null;
    }
    return out;
  }

  function sortRows(list, order) {
    if (!order) return list;
    const keys = order.split(",").map((o) => { const [col, dir, nulls] = o.split("."); return { col, desc: dir === "desc", nullsFirst: nulls === "nullsfirst" }; });
    return [...list].sort((a, b) => {
      for (const k of keys) {
        const x = a[k.col] ?? null, y = b[k.col] ?? null;
        if (x === y) continue;
        if (x === null) return k.nullsFirst ? -1 : 1;
        if (y === null) return k.nullsFirst ? 1 : -1;
        const c = num(x, y);
        if (c) return k.desc ? -c : c;
      }
      return 0;
    });
  }

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  const send = (res, status, data, headers = {}) => {
    const text = data === undefined ? "" : typeof data === "string" ? data : JSON.stringify(data);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(text);
  };

  async function rest(req, res, url, table) {
    const method = req.method;
    const prefer = String(req.headers.prefer ?? "");
    const wantsObject = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
    const rows = (tables[table] ??= []);
    const preds = [];
    for (const [k, v] of url.searchParams) { const f = filterOf(k, v); if (f) preds.push(f); }
    const matching = () => rows.filter((r) => preds.every((p) => p(r)));
    const select = url.searchParams.get("select");
    const answer = (list, status = 200, extra = {}) => {
      const projected = list.map((r) => project(r, select));
      if (wantsObject) {
        if (projected.length !== 1) return send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
        return send(res, status, projected[0], extra);
      }
      return send(res, status, projected, extra);
    };

    if (method === "GET" || method === "HEAD") {
      let list = sortRows(matching(), url.searchParams.get("order"));
      const total = list.length;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = url.searchParams.get("limit");
      list = list.slice(offset, limit == null ? undefined : offset + Number(limit));
      const range = { "content-range": `${list.length ? `${offset}-${offset + list.length - 1}` : "*"}/${total}` };
      if (method === "HEAD") { res.writeHead(200, range); return res.end(); }
      return answer(list, 200, prefer.includes("count=") ? range : {});
    }

    const input = JSON.parse((await body(req)).toString() || "null");
    if (method === "POST") {
      const rowsIn = Array.isArray(input) ? input : [input];
      const onConflict = url.searchParams.get("on_conflict");
      const done = [];
      for (const r of rowsIn) {
        const row = { id: randomUUID(), ...(DEFAULTS[table]?.() ?? {}), ...r };
        if (onConflict) {
          const hit = rows.find((x) => onConflict.split(",").every((c) => same(x[c], row[c])));
          if (hit) { if (prefer.includes("merge-duplicates")) { Object.assign(hit, r); done.push(hit); } continue; }
        }
        rows.push(row);
        done.push(row);
      }
      return prefer.includes("return=representation") ? answer(done, 201) : send(res, 201);
    }
    if (method === "PATCH") {
      const hit = matching();
      for (const r of hit) Object.assign(r, input);
      return prefer.includes("return=representation") ? answer(hit) : send(res, 204);
    }
    if (method === "DELETE") {
      const hit = matching();
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      return prefer.includes("return=representation") ? answer(hit) : send(res, 204);
    }
    return send(res, 405, { message: "mock: method not supported" });
  }

  async function auth(req, res, url) {
    const path = url.pathname.replace("/auth/v1", "");
    if (path === "/token") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "password") {
        const { email, password } = JSON.parse((await body(req)).toString());
        if (email?.toLowerCase() !== ADMIN.email || password !== ADMIN.password) return send(res, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
        return send(res, 200, session());
      }
      if (grant === "refresh_token") return send(res, 200, session());
    }
    if (path === "/user") {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /i, "");
      if (!token || token === "mock-anon-key") return send(res, 401, { code: 401, error_code: "no_authorization", msg: "missing sub claim" });
      return send(res, 200, user);
    }
    if (path === "/logout") return send(res, 204);
    return send(res, 404, { msg: `mock: ${path} is not handled` });
  }

  async function storage(req, res, url) {
    const path = decodeURIComponent(url.pathname.replace("/storage/v1", ""));
    if (req.method === "DELETE") { await body(req); return send(res, 200, []); }
    if (path.startsWith("/object/sign/")) return send(res, 200, { signedURL: `${path.replace("/object/sign/", "/object/sign/")}?token=mock` });
    if (path.startsWith("/object/") && req.method === "POST") {
      files.set(path.replace("/object/", ""), await body(req));
      return send(res, 200, { Key: path.replace("/object/", ""), Id: randomUUID() });
    }
    if (path.startsWith("/object/") && req.method === "GET") {
      const key = path.replace(/^\/object\/(public\/)?/, "");
      const f = files.get(key);
      if (!f) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(f);
    }
    return send(res, 404, { error: `mock: ${path} is not handled` });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (log) console.log(`[mock] ${req.method} ${url.pathname}${url.search}`);
    try {
      if (url.pathname === "/__state") return send(res, 200, { tables, requests });
      if (url.pathname.startsWith("/rest/v1/rpc/")) { await body(req); return send(res, 200, []); }
      if (url.pathname.startsWith("/rest/v1/")) return await rest(req, res, url, url.pathname.replace("/rest/v1/", ""));
      if (url.pathname.startsWith("/auth/v1/")) return await auth(req, res, url);
      if (url.pathname.startsWith("/storage/v1/")) return await storage(req, res, url);
      return send(res, 404, { message: "mock: not found" });
    } catch (err) {
      console.error("[mock] error", req.method, req.url, err);
      return send(res, 500, { message: String(err) });
    }
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ tables, requests, close: () => new Promise((r) => server.close(r)) })));
}
