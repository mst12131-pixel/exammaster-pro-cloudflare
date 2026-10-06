/*
 * ExamMaster Pro - Cloudflare Worker / D1
 * V5.161 - ANALYTICS CLEAR + RANK ADMIN FIX
 */

const TABLES = new Set([
  'subjects','notes','bundles','bundle_tests','banners','activation_codes',
  'entitlements','emp_test_submissions','emp_analytics_events',
  'content_notifications','admin_users','app_releases','cf_users'
]);

const PUBLIC_TABLES = new Set([
  'subjects','notes','bundles','bundle_tests','banners',
  'content_notifications','app_releases'
]);

const ADMIN_READ_TABLES = new Set([
  'activation_codes','emp_analytics_events','admin_users','cf_users'
]);

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, apikey, Prefer, X-EMP-Admin-Key, X-Client-Role',
    'Access-Control-Max-Age': '86400',
    ...extra
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      ...extra
    })
  });
}

function text(body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, {
    status,
    headers: corsHeaders({ 'Content-Type': contentType })
  });
}

function bad(message, status = 400, details = null) {
  return json({
    code: status,
    message,
    ...(details ? { details } : {})
  }, status);
}

function nowIso() {
  return new Date().toISOString();
}

function cleanIdent(v) {
  const s = String(v || '');
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : null;
}

function decodeFilterValue(raw) {
  try {
    return decodeURIComponent(String(raw ?? ''));
  } catch (_) {
    return String(raw ?? '');
  }
}

function parseFilters(url) {
  const filters = [];

  for (const [key, value] of url.searchParams.entries()) {
    if ([
      'select','order','limit','offset','on_conflict',
      'columns','apikey'
    ].includes(key)) continue;

    if (key === 'or' || key === 'and') continue;

    const m = String(value).match(
      /^(eq|neq|gt|gte|lt|lte|in|is|like|ilike)\.(.*)$/s
    );

    if (!m) continue;

    const op = m[1];
    let val = m[2];

    if (op === 'in') {
      val = val
        .replace(/^\(/, '')
        .replace(/\)$/, '')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)
        .map(x => x.replace(/^"|"$/g, ''))
        .map(decodeFilterValue);
    } else if (op === 'is') {
      const low = String(val).toLowerCase();
      val = low === 'null' ? null : low === 'true';
    } else {
      val = decodeFilterValue(val);
    }

    filters.push({ key, op, val });
  }

  return filters;
}

function compareValue(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;

  const na = Number(a);
  const nb = Number(b);

  if (
    Number.isFinite(na) &&
    Number.isFinite(nb) &&
    String(a).trim() !== '' &&
    String(b).trim() !== ''
  ) {
    return na - nb;
  }

  const da = Date.parse(String(a));
  const db = Date.parse(String(b));

  if (Number.isFinite(da) && Number.isFinite(db)) {
    return da - db;
  }

  return String(a).localeCompare(
    String(b),
    undefined,
    { numeric: true, sensitivity: 'base' }
  );
}

function rowMatches(row, filters) {
  return filters.every(f => {
    const actual = row[f.key];
    const val = f.val;

    switch (f.op) {
      case 'eq':
        return String(actual ?? '') === String(val ?? '');

      case 'neq':
        return String(actual ?? '') !== String(val ?? '');

      case 'gt':
        return compareValue(actual, val) > 0;

      case 'gte':
        return compareValue(actual, val) >= 0;

      case 'lt':
        return compareValue(actual, val) < 0;

      case 'lte':
        return compareValue(actual, val) <= 0;

      case 'in':
        return Array.isArray(val) &&
          val.some(x => String(actual ?? '') === String(x));

      case 'is':
        return val === null
          ? actual == null
          : Boolean(actual) === Boolean(val);

      case 'like':
        return String(actual ?? '').includes(
          String(val).replace(/%/g, '')
        );

      case 'ilike':
        return String(actual ?? '')
          .toLowerCase()
          .includes(
            String(val).replace(/%/g, '').toLowerCase()
          );

      default:
        return true;
    }
  });
}

function parseSelect(raw) {
  if (!raw || raw === '*') return null;

  return String(raw)
    .split(',')
    .map(s => cleanIdent(s.trim()))
    .filter(Boolean);
}

function applySelect(row, fields) {
  if (!fields) return row;

  const out = {};

  for (const f of fields) {
    out[f] = row[f] ?? null;
  }

  return out;
}

function parseOrder(raw) {
  if (!raw) return [];

  return String(raw)
    .split(',')
    .map(part => {
      const p = part.trim().split('.');

      return {
        field: cleanIdent(p[0]),
        dir:
          String(p[1] || 'asc').toLowerCase() === 'desc'
            ? -1
            : 1
      };
    })
    .filter(x => x.field);
}

function normalizeAccessState(source) {
  const s = source && typeof source === 'object'
    ? source
    : {};

  const values = [
    s.access_mode,
    s.access_override,
    s.access_type
  ].map(v => String(v ?? '').toLowerCase());

  if (
    values.includes('paid') ||
    s.is_paid === true ||
    String(s.is_paid).toLowerCase() === 'true' ||
    Number(s.is_paid) === 1 ||
    Number(s.price) > 0
  ) {
    return 'paid';
  }

  if (
    values.includes('free') ||
    s.is_paid === false ||
    String(s.is_paid).toLowerCase() === 'false' ||
    Number(s.is_paid) === 0
  ) {
    return 'free';
  }

  return 'inherit';
}

function normalizeTestAccess(source) {
  const s = source && typeof source === 'object'
    ? source
    : {};

  const state = normalizeAccessState(s);

  return {
    state,
    access_mode: state,
    access_override: state,
    access_type: state,
    is_paid: state === 'paid',
    price:
      state === 'paid'
        ? Math.max(0, Number(s.price || 0) || 0)
        : 0
  };
}

function sourceRowToD1(table, source) {
  const src = source && typeof source === 'object'
    ? JSON.parse(JSON.stringify(source))
    : {};

  const id =
    src.id != null
      ? String(src.id)
      : crypto.randomUUID();

  const common = {
    id,
    data_json: JSON.stringify(src)
  };

  if (table === 'subjects') {
    Object.assign(common, {
      name: src.name ?? null,
      description: src.description ?? null,
      icon: src.icon ?? null,
      color: src.color ?? null,
      created_at: src.created_at ?? nowIso(),
      updated_at: src.updated_at ?? nowIso()
    });
  }

  else if (table === 'notes') {
    Object.assign(common, {
      subject_id:
        src.subject_id != null
          ? String(src.subject_id)
          : null,
      title: src.title ?? null,
      content: src.content ?? null,
      file_data: src.file_data ?? null,
      file_name: src.file_name ?? null,
      file_type: src.file_type ?? null,
      created_at: src.created_at ?? nowIso(),
      updated_at: src.updated_at ?? nowIso()
    });
  }

  else if (table === 'bundles') {
    Object.assign(common, {
      name: src.name ?? 'Untitled Bundle',
      description: src.description ?? null,
      updated_at: src.updated_at ?? nowIso()
    });
  }

  else if (table === 'bundle_tests') {
    const a = normalizeTestAccess(src);

    src.access_mode = a.access_mode;
    src.access_override = a.access_override;
    src.access_type = a.access_type;
    src.is_paid = a.is_paid;
    src.price = a.price;

    common.data_json = JSON.stringify(src);

    Object.assign(common, {
      bundle_id:
        src.bundle_id != null
          ? String(src.bundle_id)
          : '',

      bundle_subject_id:
        src.bundle_subject_id != null
          ? String(src.bundle_subject_id)
          : null,

      bundle_subject_name:
        src.bundle_subject_name ?? null,

      name:
        src.name ?? 'Untitled Test',

      description:
        src.description ?? null,

      level:
        src.level ?? null,

      difficulty:
        src.difficulty ?? null,

      time_limit:
        src.time_limit ?? null,

      html_content:
        src.html_content ?? null,

      is_paid:
        a.is_paid ? 1 : 0,

      access_type:
        a.access_type,

      access_mode:
        a.access_mode,

      access_override:
        a.access_override,

      price:
        a.price,

      total_questions:
        src.total_questions ?? null,

      updated_at:
        src.updated_at ?? nowIso(),

      deleted_at:
        src.deleted_at ?? null
    });
  }

  else if (table === 'banners') {
    Object.assign(common, {
      title: src.title ?? null,
      description: src.description ?? null,
      price: src.price ?? null,
      image: src.image ?? null,
      qrData: src.qrData ?? null,
      link_type: src.link_type ?? null,
      link: src.link ?? null,

      bundle_id:
        src.bundle_id == null || src.bundle_id === ''
          ? null
          : String(src.bundle_id),

      subject_id: src.subject_id ?? null,
      test_id: src.test_id ?? null,
      slide_seconds: src.slide_seconds ?? null,
      updated_at: src.updated_at ?? nowIso()
    });
  }

  else if (table === 'activation_codes') {
    Object.assign(common, {
      code:
        src.code ??
        src.code_hash ??
        null,

      bundle_id:
        src.bundle_id != null
          ? String(src.bundle_id)
          : null,

      amount:
        src.amount ?? 0,

      status:
        src.status ?? 'unused',

      redeemed_by:
        src.redeemed_by ?? null,

      redeemed_at:
        src.redeemed_at ?? null,

      created_at:
        src.created_at ?? nowIso()
    });
  }

  else if (table === 'entitlements') {
    Object.assign(common, {
      user_key:
        String(src.user_key ?? ''),

      bundle_id:
        src.bundle_id != null
          ? String(src.bundle_id)
          : '',

      created_at:
        src.created_at ?? nowIso()
    });
  }

  else if (table === 'emp_test_submissions') {
    Object.assign(common, {
      attempt_id:
        src.attempt_id ?? id,

      user_id:
        src.user_id != null
          ? String(src.user_id)
          : null,

      username:
        src.username ?? null,

      test_id:
        src.test_id != null
          ? String(src.test_id)
          : null,

      test_name:
        src.test_name ?? null,

      bundle_id:
        src.bundle_id != null
          ? String(src.bundle_id)
          : null,

      score:
        src.score ?? src.marks ?? 0,

      total_marks:
        src.total_marks ??
        src.total_questions ??
        0,

      accuracy:
        src.accuracy ?? 0,

      correct:
        src.correct ?? 0,

      wrong:
        src.wrong ?? 0,

      skipped:
        src.skipped ?? 0,

      time_taken:
        src.time_taken ??
        src.time_seconds ??
        src.timeTaken ??
        0,

      status:
        src.status ?? 'completed',

      completed_at:
        src.completed_at ??
        src.created_at ??
        nowIso(),

      created_at:
        src.created_at ??
        nowIso(),

      updated_at:
        src.updated_at ??
        nowIso()
    });
  }

  else if (table === 'emp_analytics_events') {
    Object.assign(common, {
      user_id:
        src.user_id != null
          ? String(src.user_id)
          : null,

      username:
        src.username ?? null,

      event_type:
        src.event_type ?? null,

      occurred_at:
        src.occurred_at ??
        src.created_at ??
        nowIso(),

      created_at:
        src.created_at ??
        nowIso()
    });
  }

  else {
    Object.assign(common, src);
  }

  return common;
}

function d1RowToSource(row) {
  if (!row) return null;

  let src = {};

  try {
    if (row.data_json) {
      src = JSON.parse(row.data_json) || {};
    }
  } catch (_) {
    src = {};
  }

  const merged = {
    ...src,
    ...row
  };

  delete merged.data_json;

  return merged;
}

function adminAllowed(request, env) {
  const configured = String(
    env.ADMIN_API_KEY || ''
  ).trim();

  if (!configured) {
    return true;
  }

  const supplied = String(
    request.headers.get('X-EMP-Admin-Key') ||
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ||
    ''
  ).trim();

  return supplied === configured;
}

async function readTable(env, table, url, request) {
  if (!TABLES.has(table)) {
    return bad('Unknown table: ' + table, 404);
  }

  if (
    !PUBLIC_TABLES.has(table) &&
    !ADMIN_READ_TABLES.has(table)
  ) {
    if (!adminAllowed(request, env)) {
      return bad('Unauthorized', 401);
    }
  }

  const filters = parseFilters(url);
  const select = parseSelect(
    url.searchParams.get('select')
  );
  const order = parseOrder(
    url.searchParams.get('order')
  );

  let sql = `SELECT * FROM "${table}"`;
  const binds = [];

  if (filters.length) {
    const parts = [];

    for (const f of filters) {
      if (!cleanIdent(f.key)) continue;

      if (f.op === 'eq') {
        parts.push(`"${f.key}" = ?`);
        binds.push(f.val);
      }

      else if (f.op === 'neq') {
        parts.push(`"${f.key}" != ?`);
        binds.push(f.val);
      }

      else if (f.op === 'gt') {
        parts.push(`"${f.key}" > ?`);
        binds.push(f.val);
      }

      else if (f.op === 'gte') {
        parts.push(`"${f.key}" >= ?`);
        binds.push(f.val);
      }

      else if (f.op === 'lt') {
        parts.push(`"${f.key}" < ?`);
        binds.push(f.val);
      }

      else if (f.op === 'lte') {
        parts.push(`"${f.key}" <= ?`);
        binds.push(f.val);
      }

      else if (f.op === 'is') {
        if (f.val === null) {
          parts.push(`"${f.key}" IS NULL`);
        } else {
          parts.push(`"${f.key}" IS NOT NULL`);
        }
      }

      else if (f.op === 'in') {
        const qs = f.val.map(() => '?').join(',');
        parts.push(`"${f.key}" IN (${qs})`);
        binds.push(...f.val);
      }

      else if (f.op === 'like') {
        parts.push(`"${f.key}" LIKE ?`);
        binds.push(String(f.val));
      }

      else if (f.op === 'ilike') {
        parts.push(`LOWER("${f.key}") LIKE LOWER(?)`);
        binds.push(String(f.val));
      }
    }

    if (parts.length) {
      sql += ' WHERE ' + parts.join(' AND ');
    }
  }

  if (order.length) {
    sql +=
      ' ORDER BY ' +
      order
        .map(o => `"${o.field}" ${o.dir < 0 ? 'DESC' : 'ASC'}`)
        .join(', ');
  }

  const limitRaw = Number(
    url.searchParams.get('limit')
  );

  const offsetRaw = Number(
    url.searchParams.get('offset')
  );

  if (Number.isFinite(limitRaw) && limitRaw > 0) {
    sql += ` LIMIT ${Math.min(10000, Math.floor(limitRaw))}`;

    if (Number.isFinite(offsetRaw) && offsetRaw >= 0) {
      sql += ` OFFSET ${Math.floor(offsetRaw)}`;
    }
  }

  const result = await env.DB
    .prepare(sql)
    .bind(...binds)
    .all();

  let rows = result.results || [];

  if (
    table === 'bundle_tests' &&
    url.searchParams.get('includeDeleted') !== 'true'
  ) {
    rows = rows.filter(
      r => r.deleted_at == null || r.deleted_at === ''
    );
  }

  rows = rows
    .map(d1RowToSource)
    .filter(r => rowMatches(r, filters))
    .map(r => applySelect(r, select));

  return json(rows);
}

async function upsertSourceRow(
  env,
  table,
  source,
  conflictField = 'id'
) {
  const row = sourceRowToD1(table, source);

  const existing = await env.DB
    .prepare(
      `SELECT * FROM "${table}" WHERE "${conflictField}" = ? LIMIT 1`
    )
    .bind(String(source?.[conflictField] ?? row[conflictField]))
    .first();

  if (existing) {
    /*
     * Critical repair:
     * Access-only / metadata updates must never erase existing HTML.
     */
    if (
      table === 'bundle_tests' &&
      (!row.html_content ||
        String(row.html_content).trim() === '')
    ) {
      if (
        existing.html_content &&
        String(existing.html_content).trim() !== ''
      ) {
        row.html_content = existing.html_content;
      }

      let oldJson = {};

      try {
        oldJson = existing.data_json
          ? JSON.parse(existing.data_json)
          : {};
      } catch (_) {}

      if (
        oldJson.html_content &&
        String(oldJson.html_content).trim() !== '' &&
        (!row.html_content ||
          String(row.html_content).trim() === '')
      ) {
        row.html_content = oldJson.html_content;
      }
    }

    const fields = Object.keys(row)
      .filter(k => k !== conflictField)
      .filter(k => cleanIdent(k));

    const sets = fields
      .map(k => `"${k}" = ?`)
      .join(', ');

    const values = fields.map(k => row[k]);

    await env.DB
      .prepare(
        `UPDATE "${table}" SET ${sets}
         WHERE "${conflictField}" = ?`
      )
      .bind(
        ...values,
        String(source?.[conflictField] ?? row[conflictField])
      )
      .run();

    return row;
  }

  const fields = Object.keys(row)
    .filter(cleanIdent);

  const placeholders = fields
    .map(() => '?')
    .join(',');

  const values = fields.map(k => row[k]);

  await env.DB
    .prepare(
      `INSERT INTO "${table}" (${fields.map(f => `"${f}"`).join(',')})
       VALUES (${placeholders})`
    )
    .bind(...values)
    .run();

  return row;
}

async function handleRest(
  request,
  env,
  table,
  url
) {
  if (!TABLES.has(table)) {
    return bad('Unknown table: ' + table, 404);
  }

  if (request.method === 'GET') {
    return readTable(env, table, url, request);
  }

  if (!adminAllowed(request, env)) {
    return bad('Unauthorized', 401);
  }

  let body = null;

  try {
    body = await request.json();
  } catch (_) {
    body = null;
  }

  if (request.method === 'POST') {
    if (Array.isArray(body)) {
      const out = [];

      for (const item of body) {
        out.push(
          await upsertSourceRow(env, table, item, 'id')
        );
      }

      return json(out);
    }

    const out = await upsertSourceRow(
      env,
      table,
      body || {},
      'id'
    );

    return json(out);
  }

  if (
    request.method === 'PATCH' ||
    request.method === 'PUT'
  ) {
    const filters = parseFilters(url);

    if (!filters.length) {
      return bad(
        'PATCH/PUT requires at least one filter',
        400
      );
    }

    const existingResponse =
      await readTable(env, table, url, request);

    const existingRows =
      await existingResponse.json();

    if (!Array.isArray(existingRows)) {
      return bad('Unable to resolve target rows', 500);
    }

    const updated = [];

    for (const old of existingRows) {
      const merged = {
        ...old,
        ...(body || {})
      };

      const out = await upsertSourceRow(
        env,
        table,
        merged,
        'id'
      );

      updated.push(out);
    }

    return json(updated);
  }

  if (request.method === 'DELETE') {
    const filters = parseFilters(url);

    if (!filters.length) {
      return bad(
        'DELETE requires at least one filter',
        400
      );
    }

    const existingResponse =
      await readTable(env, table, url, request);

    const existingRows =
      await existingResponse.json();

    for (const row of existingRows) {
      if (!row.id) continue;

      if (table === 'bundle_tests') {
        await env.DB
          .prepare(
            `UPDATE "bundle_tests"
             SET deleted_at = ?, updated_at = ?
             WHERE id = ?`
          )
          .bind(
            nowIso(),
            nowIso(),
            String(row.id)
          )
          .run();
      } else {
        await env.DB
          .prepare(
            `DELETE FROM "${table}" WHERE id = ?`
          )
          .bind(String(row.id))
          .run();
      }
    }

    return json({
      success: true,
      deleted: existingRows.length
    });
  }

  return bad('Method not allowed', 405);
}

/* =========================================================
   ACTIVATION
   ========================================================= */

async function sha256Hex(value) {
  const data = new TextEncoder().encode(
    String(value)
  );

  const hash = await crypto.subtle.digest(
    'SHA-256',
    data
  );

  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function handleRedeemActivation(
  request,
  env
) {
  let body;

  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const code = String(
    body.code || ''
  ).trim();

  const userKey = String(
    body.user_key ||
    body.userKey ||
    ''
  ).trim();

  const bundleId = String(
    body.bundle_id ||
    body.bundleId ||
    ''
  ).trim();

  if (!code || !userKey || !bundleId) {
    return bad(
      'code, user_key and bundle_id are required',
      400
    );
  }

  const hash = await sha256Hex(code);

  let codeRow = await env.DB
    .prepare(
      `SELECT * FROM "activation_codes"
       WHERE "code" = ?
       LIMIT 1`
    )
    .bind(hash)
    .first();

  if (!codeRow) {
    codeRow = await env.DB
      .prepare(
        `SELECT * FROM "activation_codes"
         WHERE "code" = ?
         LIMIT 1`
      )
      .bind(code)
      .first();
  }

  if (!codeRow) {
    return bad('Invalid activation code', 404);
  }

  if (
    String(codeRow.status || '').toLowerCase() !==
    'unused'
  ) {
    if (
      String(codeRow.redeemed_by || '') === userKey &&
      String(codeRow.bundle_id || '') === bundleId
    ) {
      return json({
        success: true,
        already_owned: true,
        bundle_id: bundleId
      });
    }

    return bad('Activation code already used', 409);
  }

  const claimed = await env.DB
    .prepare(
      `UPDATE "activation_codes"
       SET status = 'redeemed',
           redeemed_by = ?,
           redeemed_at = ?
       WHERE id = ?
         AND status = 'unused'`
    )
    .bind(
      userKey,
      nowIso(),
      String(codeRow.id)
    )
    .run();

  if (
    Number(claimed.meta?.changes || 0) !== 1
  ) {
    return bad(
      'Activation code was already redeemed',
      409
    );
  }

  await upsertSourceRow(
    env,
    'entitlements',
    {
      id: crypto.randomUUID(),
      user_key: userKey,
      bundle_id: bundleId,
      created_at: nowIso()
    },
    'id'
  );

  return json({
    success: true,
    bundle_id: bundleId,
    lifetime: true
  });
}

async function handleGetBundleEntitlements(
  request,
  env
) {
  let body;

  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const userKey = String(
    body.user_key ||
    body.userKey ||
    ''
  ).trim();

  if (!userKey) {
    return bad(
      'user_key is required',
      400
    );
  }

  const rows = await env.DB
    .prepare(
      `SELECT * FROM "entitlements"
       WHERE "user_key" = ?`
    )
    .bind(userKey)
    .all();

  return json({
    success: true,
    entitlements:
      (rows.results || []).map(d1RowToSource)
  });
}

/* =========================================================
   ANALYTICS
   ========================================================= */

async function handleAnalyticsEvent(
  request,
  env
) {
  let body;

  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  if (!body.user_id) {
    return bad(
      'user_id is required',
      400
    );
  }

  const row = {
    ...body,
    id:
      body.id ||
      crypto.randomUUID(),

    occurred_at:
      body.occurred_at ||
      nowIso()
  };

  await upsertSourceRow(
    env,
    'emp_analytics_events',
    row,
    'id'
  );

  return json({
    success: true
  });
}

/*
 * IMPORTANT:
 * Clear Analytics is deliberately separate from
 * student local history.
 *
 * It clears:
 *   1. emp_analytics_events
 *   2. emp_test_submissions
 *
 * It does NOT touch:
 *   - bundles
 *   - bundle_tests
 *   - entitlements
 *   - student local IndexedDB/history
 */

async function handleAdminAnalyticsClear(
  request,
  env
) {
  if (!adminAllowed(request, env)) {
    return bad(
      'Unauthorized',
      401
    );
  }

  let analyticsDeleted = 0;
  let rankingDeleted = 0;

  try {
    const result =
      await env.DB
        .prepare(
          `DELETE FROM "emp_analytics_events"`
        )
        .run();

    analyticsDeleted =
      Number(
        result.meta?.changes || 0
      );
  } catch (e) {
    console.error(
      'Analytics clear failed:',
      e
    );

    return bad(
      'Could not clear analytics events: ' +
      String(e?.message || e),
      500
    );
  }

  try {
    const result =
      await env.DB
        .prepare(
          `DELETE FROM "emp_test_submissions"`
        )
        .run();

    rankingDeleted =
      Number(
        result.meta?.changes || 0
      );
  } catch (e) {
    console.error(
      'Ranking clear failed:',
      e
    );

    return bad(
      'Analytics cleared but ranking submissions could not be cleared: ' +
      String(e?.message || e),
      500
    );
  }

  return json({
    success: true,

    analytics_deleted:
      analyticsDeleted,

    ranking_submissions_deleted:
      rankingDeleted,

    message:
      'Analytics and ranking submissions cleared. Student local history is untouched.'
  });
}

/* =========================================================
   BUNDLE LIKES
   ========================================================= */

async function handleBundleLikeCounts(
  request,
  env,
  url
) {
  const rawIds =
    url.searchParams.get('bundle_ids') ||
    url.searchParams.get('ids') ||
    '';

  const ids = rawIds
    .split(',')
    .map(x => String(x).trim())
    .filter(Boolean);

  if (!ids.length) {
    return json({
      success: true,
      counts: {}
    });
  }

  const placeholders =
    ids.map(() => '?').join(',');

  let rows = [];

  try {
    const q = `
      SELECT
        json_extract(data_json,'$.bundle_id') AS bundle_id,
        COUNT(DISTINCT user_id) AS like_count
      FROM "emp_analytics_events"
      WHERE event_type = 'bundle_like'
        AND json_extract(data_json,'$.bundle_id')
            IN (${placeholders})
      GROUP BY
        json_extract(data_json,'$.bundle_id')
    `;

    const result =
      await env.DB
        .prepare(q)
        .bind(...ids)
        .all();

    rows =
      result.results || [];
  } catch (e) {
    console.error(
      'Bundle like count query failed:',
      e
    );

    return bad(
      'Unable to load bundle like counts',
      500
    );
  }

  const counts = {};

  for (const id of ids) {
    counts[id] = 0;
  }

  for (const row of rows) {
    const id =
      String(
        row.bundle_id ?? ''
      ).trim();

    if (id) {
      counts[id] =
        Number(row.like_count) || 0;
    }
  }

  return json({
    success: true,
    counts
  });
}

/* =========================================================
   RANKING
   ========================================================= */

function rankNumber(v) {
  const n = Number(v);

  return Number.isFinite(n)
    ? n
    : 0;
}

function buildLeaderboard(
  rows,
  userId,
  attemptId
) {
  const clean = rows
    .map(d1RowToSource)

    .filter(
      r =>
        String(
          r.status || 'completed'
        ).toLowerCase() ===
        'completed'
    )

    .map(r => {
      const correct =
        rankNumber(r.correct);

      const wrong =
        rankNumber(r.wrong);

      let accuracy;

      if (
        r.accuracy != null &&
        Number.isFinite(
          Number(r.accuracy)
        )
      ) {
        accuracy =
          Number(r.accuracy);
      } else {
        accuracy =
          correct + wrong > 0
            ? Number(
                (
                  correct /
                  (correct + wrong) *
                  100
                ).toFixed(2)
              )
            : 0;
      }

      return {
        ...r,

        score:
          rankNumber(
            r.score ??
            r.marks
          ),

        total_marks:
          rankNumber(
            r.total_marks ??
            r.total_questions
          ),

        accuracy,

        correct,

        wrong,

        skipped:
          rankNumber(
            r.skipped
          ),

        time_taken:
          rankNumber(
            r.time_taken ??
            r.time_seconds ??
            r.timeTaken
          ),

        attempt_id:
          r.attempt_id ||
          r.id
      };
    });

  /*
   * Ranking priority:
   *
   * 1. ACTUAL SUBMITTED SCORE
   * 2. ACTUAL SUBMITTED ACCURACY
   * 3. TIME TAKEN
   *
   * Percentile is calculated only AFTER rank.
   */

  const better = (a, b) => {
    const scoreDiff =
      Number(a.score || 0) -
      Number(b.score || 0);

    if (scoreDiff !== 0) {
      return scoreDiff > 0;
    }

    const accuracyDiff =
      Number(a.accuracy || 0) -
      Number(b.accuracy || 0);

    if (accuracyDiff !== 0) {
      return accuracyDiff > 0;
    }

    const timeA =
      Number(a.time_taken || 1e9);

    const timeB =
      Number(b.time_taken || 1e9);

    if (timeA !== timeB) {
      return timeA < timeB;
    }

    return String(
      a.attempt_id || ''
    ) < String(
      b.attempt_id || ''
    );
  };

  /*
   * One best entry per user.
   */
  const best = new Map();

  for (const row of clean) {
    const key =
      String(
        row.user_id || ''
      );

    if (!key) continue;

    const old =
      best.get(key);

    if (
      !old ||
      better(row, old)
    ) {
      best.set(
        key,
        row
      );
    }
  }

  /*
   * If a specific attempt is requested,
   * preserve that exact submitted attempt
   * so YOU always represents the attempt
   * being viewed.
   */
  const selected =
    attemptId
      ? clean.find(
          r =>
            String(
              r.attempt_id
            ) ===
            String(attemptId)
        )
      : null;

  if (
    selected &&
    selected.user_id != null
  ) {
    best.set(
      String(
        selected.user_id
      ),
      selected
    );
  }

  const list =
    [...best.values()]
      .sort(
        (a, b) =>
          better(a, b)
            ? -1
            : better(b, a)
              ? 1
              : 0
      );

  const n =
    list.length;

  let lastKey = '';
  let lastRank = 0;

  const leaderboard =
    list.map((r, i) => {
      const key =
        Number(r.score || 0) +
        '|' +
        Number(
          r.accuracy || 0
        ).toFixed(4) +
        '|' +
        Number(
          r.time_taken || 0
        );

      const rank =
        key === lastKey
          ? lastRank
          : i + 1;

      lastKey = key;
      lastRank = rank;

      return {
        rank,

        user_id:
          r.user_id,

        username:
          r.username ||
          'User',

        score:
          rankNumber(
            r.score
          ),

        total_marks:
          rankNumber(
            r.total_marks
          ),

        accuracy:
          rankNumber(
            r.accuracy
          ),

        correct:
          rankNumber(
            r.correct
          ),

        wrong:
          rankNumber(
            r.wrong
          ),

        skipped:
          rankNumber(
            r.skipped
          ),

        time_taken:
          rankNumber(
            r.time_taken
          ),

        attempt_id:
          r.attempt_id,

        test_id:
          r.test_id,

        completed_at:
          r.completed_at ||
          r.created_at,

        is_you:
          (
            attemptId &&
            String(
              r.attempt_id
            ) ===
            String(attemptId)
          ) ||
          (
            !attemptId &&
            userId &&
            String(
              r.user_id
            ) ===
            String(userId)
          )
      };
    });

  const me =
    leaderboard.find(
      r =>
        attemptId &&
        String(
          r.attempt_id
        ) ===
        String(attemptId)
    ) ||

    leaderboard.find(
      r =>
        userId &&
        String(
          r.user_id
        ) ===
        String(userId)
    ) ||

    null;

  if (me) {
    me.is_you = true;
  }

  /*
   * Percentile is OUTPUT of ranking.
   *
   * #1 / 4 = 100
   * #2 / 4 = 66.67
   * #3 / 4 = 33.33
   * #4 / 4 = 0
   *
   * This is the standard relative-rank style.
   */
  for (const r of leaderboard) {
    r.percentile =
      n <= 1
        ? 100
        : Number(
            (
              ((n - r.rank) /
                (n - 1)) *
              100
            ).toFixed(2)
          );
  }

  if (me) {
    me.percentile =
      n <= 1
        ? 100
        : Number(
            (
              ((n - me.rank) /
                (n - 1)) *
              100
            ).toFixed(2)
          );
  }

  return {
    success: true,

    leaderboard,

    participants:
      n,

    user:
      me,

    rank:
      me
        ? me.rank
        : null,

    percentile:
      me
        ? me.percentile
        : null
  };
}

/* =========================================================
   RANK SUBMIT
   ========================================================= */

async function handleRankSubmit(
  request,
  env
) {
  let body;

  try {
    body =
      await request.json();
  } catch (_) {
    return bad(
      'Invalid JSON body'
    );
  }

  if (
    !body.attempt_id ||
    !body.test_id ||
    !body.user_id
  ) {
    return bad(
      'attempt_id, test_id and user_id are required',
      400
    );
  }

  const row = {
    ...body,

    id:
      body.id ||
      crypto.randomUUID(),

    status:
      body.status ||
      'completed',

    completed_at:
      body.completed_at ||
      nowIso(),

    created_at:
      body.created_at ||
      nowIso(),

    updated_at:
      nowIso()
  };

  await upsertSourceRow(
    env,
    'emp_test_submissions',
    row,
    'attempt_id'
  );

  return json({
    success: true,
    source: 'cloudflare_d1',
    participant_added: true,
    attempt_id:
      String(
        body.attempt_id
      )
  });
}

/* =========================================================
   ADMIN RANK -> LOAD TESTS
   ========================================================= */

async function handleRankTests(
  request,
  env
) {
  if (!adminAllowed(request, env)) {
    return bad(
      'Unauthorized',
      401
    );
  }

  const rows =
    await env.DB
      .prepare(`
        SELECT
          test_id,
          MAX(test_name) AS test_name,
          COUNT(*) AS attempts,
          COUNT(DISTINCT user_id) AS participants,
          MAX(completed_at) AS latest_completed_at
        FROM "emp_test_submissions"
        WHERE "status" = 'completed'
          AND test_id IS NOT NULL
          AND TRIM(CAST(test_id AS TEXT)) <> ''
        GROUP BY test_id
        ORDER BY latest_completed_at DESC
      `)
      .all();

  return json({
    success: true,

    tests:
      (rows.results || [])
        .map(r => ({
          test_id:
            String(
              r.test_id
            ),

          test_name:
            r.test_name ||
            'Untitled test',

          attempts:
            Number(
              r.attempts || 0
            ),

          participants:
            Number(
              r.participants || 0
            ),

          latest_completed_at:
            r.latest_completed_at ||
            null
        }))
  });
}

/* =========================================================
   ADMIN RANK -> LOAD PARTICIPANTS FOR ONE TEST
   ========================================================= */

async function handleRankParticipants(
  request,
  env,
  url
) {
  if (!adminAllowed(request, env)) {
    return bad(
      'Unauthorized',
      401
    );
  }

  const testId =
    String(
      url.searchParams.get(
        'test_id'
      ) || ''
    ).trim();

  if (!testId) {
    return bad(
      'test_id is required',
      400
    );
  }

  const rows =
    await env.DB
      .prepare(`
        SELECT *
        FROM "emp_test_submissions"
        WHERE "test_id" = ?
          AND "status" = 'completed'
        ORDER BY completed_at DESC
      `)
      .bind(testId)
      .all();

  const sourceRows =
    rows.results || [];

  const result =
    buildLeaderboard(
      sourceRows,
      '',
      ''
    );

  return json({
    success: true,

    test_id:
      testId,

    participants:
      result.participants,

    leaderboard:
      result.leaderboard
  });
}

/* =========================================================
   RANK LEADERBOARD
   ========================================================= */

async function handleRankLeaderboard(
  request,
  env,
  url
) {
  const testId =
    String(
      url.searchParams.get(
        'test_id'
      ) || ''
    ).trim();

  const userId =
    String(
      url.searchParams.get(
        'user_id'
      ) || ''
    ).trim();

  const attemptId =
    String(
      url.searchParams.get(
        'attempt_id'
      ) || ''
    ).trim();

  if (!testId) {
    return bad(
      'test_id is required',
      400
    );
  }

  const rows =
    await env.DB
      .prepare(`
        SELECT *
        FROM "emp_test_submissions"
        WHERE "test_id" = ?
          AND "status" = 'completed'
      `)
      .bind(testId)
      .all();

  return json(
    buildLeaderboard(
      rows.results || [],
      userId,
      attemptId
    )
  );
}

/* =========================================================
   IMPORT JSON
   ========================================================= */

async function handleImportJson(
  request,
  env
) {
  if (!adminAllowed(request, env)) {
    return bad(
      'Unauthorized',
      401
    );
  }

  let body;

  try {
    body =
      await request.json();
  } catch (_) {
    return bad(
      'Invalid JSON body'
    );
  }

  if (!body || typeof body !== 'object') {
    return bad(
      'Invalid import payload'
    );
  }

  const results = [];

  for (const [table, rows] of Object.entries(body)) {
    if (!TABLES.has(table)) continue;
    if (!Array.isArray(rows)) continue;

    for (const item of rows) {
      try {
        const out =
          await upsertSourceRow(
            env,
            table,
            item,
            'id'
          );

        results.push({
          table,
          id:
            out.id,
          success:
            true
        });
      } catch (e) {
        results.push({
          table,
          id:
            item?.id ??
            null,
          success:
            false,
          error:
            String(
              e?.message ||
              e
            )
        });
      }
    }
  }

  return json({
    success: true,
    results
  });
}

/* =========================================================
   ROUTER
   ========================================================= */

async function route(
  request,
  env
) {
  const url =
    new URL(
      request.url
    );

  if (
    request.method ===
    'OPTIONS'
  ) {
    return new Response(
      null,
      {
        status: 204,
        headers:
          corsHeaders()
      }
    );
  }

  try {
    if (
      url.pathname ===
      '/api/import/json'
    ) {
      return await handleImportJson(
        request,
        env
      );
    }

    if (
      url.pathname ===
      '/api/bundle/like-counts'
    ) {
      return await handleBundleLikeCounts(
        request,
        env,
        url
      );
    }

    if (
      url.pathname ===
      '/api/analytics/event'
    ) {
      return await handleAnalyticsEvent(
        request,
        env
      );
    }

    if (
      url.pathname ===
      '/api/admin/analytics/clear'
    ) {
      return await handleAdminAnalyticsClear(
        request,
        env
      );
    }

    if (
      url.pathname ===
      '/api/rank/tests'
    ) {
      return await handleRankTests(
        request,
        env
      );
    }

    if (
      url.pathname ===
      '/api/rank/participants'
    ) {
      return await handleRankParticipants(
        request,
        env,
        url
      );
    }

    if (
      url.pathname ===
      '/api/rank/submit'
    ) {
      return await handleRankSubmit(
        request,
        env
      );
    }

    if (
      url.pathname ===
      '/api/rank/leaderboard'
    ) {
      return await handleRankLeaderboard(
        request,
        env,
        url
      );
    }

    if (
      url.pathname ===
      '/rest/v1/rpc/redeem_activation_code'
    ) {
      return await handleRedeemActivation(
        request,
        env
      );
    }

    if (
      url.pathname ===
      '/rest/v1/rpc/get_bundle_entitlements'
    ) {
      return await handleGetBundleEntitlements(
        request,
        env
      );
    }

    if (
      url.pathname.startsWith(
        '/rest/v1/'
      )
    ) {
      const table =
        decodeURIComponent(
          url.pathname
            .slice(
              '/rest/v1/'.length
            )
            .replace(
              /\/$/,
              ''
            )
        );

      if (
        table.includes('/')
      ) {
        return bad(
          'Unsupported REST path',
          404
        );
      }

      return await handleRest(
        request,
        env,
        table,
        url
      );
    }

    if (
      url.pathname === '/' ||
      url.pathname === '/health'
    ) {
      return json({
        ok: true,
        service:
          'ExamMaster Pro Cloudflare Worker',

        version:
          'V5.161-ANALYTICS-RANK-ADMIN-FIX',

        time:
          nowIso()
      });
    }

    return bad(
      'Not found',
      404
    );

  } catch (e) {
    console.error(
      'Worker error:',
      e
    );

    return bad(
      String(
        e?.message ||
        e ||
        'Internal Worker error'
      ),
      500
    );
  }
}

/* =========================================================
   EXPORT
   ========================================================= */

export default {
  async fetch(
    request,
    env
  ) {
    return route(
      request,
      env
    );
  }
};
