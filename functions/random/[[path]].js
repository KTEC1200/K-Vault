/**
 * 随机图 / 壁纸 API
 *
 * GET /random                     → 全库随机一张,302 跳转到直链
 * GET /random/壁纸/横屏            → 指定分类随机(路径写法)
 * GET /random?folder=壁纸/横屏     → 指定分类随机(查询参数写法)
 * GET /random/壁纸/横屏?json=1     → 返回 JSON(直链/文件名/池大小),便于程序处理
 * 追加 &refresh=1                  → 跳过缓存强制重建列表(刚传完图想立即生效时用)
 *
 * 实现说明:
 *   - 池子来自 KV list()(每条自带 metadata,不算额外读取)
 *   - 列表按分类缓存在边缘节点 10 分钟(Cache API),期间请求零 KV 消耗
 *   - 排除 folder: 标记键与 session:/chunk:/upload:/temp: 临时键
 */

const INVALID_PREFIXES = ["session:", "chunk:", "upload:", "temp:", "folder:"];
const CACHE_TTL_SECONDS = 600;
const MAX_LIST_PAGES = 5; // 5 × 1000 = 最多索引 10000 个文件

function normalizeFolderPath(value = "") {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  const output = [];
  for (const part of raw.split("/")) {
    const piece = part.trim();
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join("/");
}

async function collectPool(env, folder) {
  const pool = [];
  let cursor;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await env.img_url.list({ limit: 1000, cursor });
    for (const key of result.keys || []) {
      const name = String(key.name || "");
      if (INVALID_PREFIXES.some((p) => name.startsWith(p))) continue;
      const meta = key.metadata || {};
      if (folder !== null && normalizeFolderPath(meta.folderPath || "") !== folder) continue;
      pool.push({ name, fileName: String(meta.fileName || name) });
    }
    if (result.list_complete || !result.cursor) break;
    cursor = result.cursor;
  }
  return pool;
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env?.img_url) {
    return jsonResponse({ success: false, error: "KV (img_url) not bound" }, 500);
  }

  const segments = decodeURIComponent(url.pathname)
    .split("/")
    .filter(Boolean);
  // /random 或 /random/<分类路径...>,路径首段为 'random'
  const pathFolder = segments[0] === "random" && segments.length > 1 ? segments.slice(1).join("/") : null;
  const queryFolder = url.searchParams.has("folder") ? url.searchParams.get("folder") : null;
  const wantJson = ["1", "true"].includes((url.searchParams.get("json") || "").toLowerCase());
  const refresh = ["1", "true"].includes((url.searchParams.get("refresh") || "").toLowerCase());
  const folder = queryFolder !== null ? normalizeFolderPath(queryFolder) : (pathFolder !== null ? normalizeFolderPath(pathFolder) : null);

  const cache = caches.default;
  const cacheKey = new Request(`https://kv-random-cache.internal/?folder=${encodeURIComponent(folder ?? "*")}`);

  let pool = null;
  if (!refresh) {
    const hit = await cache.match(cacheKey);
    if (hit) pool = await hit.json().catch(() => null);
  }
  if (!Array.isArray(pool)) {
    pool = await collectPool(env, folder);
    const cacheRes = new Response(JSON.stringify(pool), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_TTL_SECONDS}` },
    });
    context.waitUntil(cache.put(cacheKey, cacheRes.clone()));
  }

  if (!pool || pool.length === 0) {
    return jsonResponse(
      {
        success: false,
        error: "no image found",
        folder: folder ?? "(全部)",
        hint: "刚传完图请追加 &refresh=1;否则检查分类名是否与后台一致",
      },
      404,
      { "cache-control": "no-store" }
    );
  }

  const pick = pool[Math.floor(Math.random() * pool.length)];
  const link = `${url.origin}/file/${pick.name}`;

  if (wantJson) {
    return jsonResponse(
      { success: true, url: link, fileName: pick.fileName, folder: folder ?? "(全部)", poolSize: pool.length },
      200,
      { "cache-control": "no-store" }
    );
  }

  return new Response(null, { status: 302, headers: { Location: link, "cache-control": "no-store" } });
}

export async function onRequestHead(context) {
  const resp = await onRequestGet(context);
  return new Response(null, { status: resp.status, headers: resp.headers });
}
