const TABLES = new Set([
  'subjects', 'notes', 'bundles', 'bundle_tests', 'banners',
  'activation_codes', 'entitlements', 'emp_test_submissions',
  'emp_analytics_events', 'content_notifications', 'admin_users',
  'app_releases', 'cf_users'
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

function cleanIdent(value) {
  const s = String(value || '');
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : null;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value || '{}');
  } catch (_) {
    return {};
  }
}

function parseFilters(url) {
  const filters = [];

  for (const [key, value] of url.searchParams.entries()) {
    if ([
      'select', 'order', 'limit', 'offset', 'on_conflict',
      'columns', 'apikey'
    ].includes(key)) continue;

    if (key === 'or' || key === 'and') continue;

    const match = String(value).match(
      /^(eq|neq|gt|gte|lt|lte|in|is|like|ilike)\.(.*)$/s
    );

    if (!match) continue;

    const op = match[1];
    let val = match[2];

    if (op === 'in') {
      val = val.replace(/^\(/, '').replace(/\)$/, '')
        .split(',')
        .map(x => x.trim().replace(/^"|"$/g, ''));
    } else if (op === 'is') {
      val = val.toLowerCase() === 'null'
        ? null
        : val.toLowerCase() === 'true';
    } else {
      try {
        val = decodeURIComponent(val);
      } catch (_) {}
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
  ) return na - nb;

  const da = Date.parse(String(a));
  const db = Date.parse(String(b));

  if (Number.isFinite(da) && Number.isFinite(db)) {
    return da - db;
  }

  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
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
        return String(actual ?? '').toLowerCase().includes(
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
    .map(s => s.trim())
    .filter(Boolean)
    .map(cleanIdent)
    .filter(Boolean);
}

function applySelect(row, fields) {
  if (!fields) return row;

  const out = {};
  for (const field of fields) {
    out[field] = row[field] ?? null;
  }

  return out;
}

function parseOrder(raw) {
  if (!raw) return [];

  return String(raw).split(',').map(part => {
    const p = part.trim().split('.');
    return {
      field: cleanIdent(p[0]),
      dir: String(p[1] || 'asc').toLowerCase() === 'desc' ? -1 : 1
    };
  }).filter(x => x.field);
}

function sourceRowToD1(table, source) {
  const src = source && typeof source === 'object'
    ? JSON.parse(JSON.stringify(source))
    : {};

  const id = src.id != null ? String(src.id) : crypto.randomUUID();
  const data = JSON.stringify(src);
  const common = { id, data_json: data };

  if (table === 'subjects') {
    Object.assign(common, {
      name: src.name ?? null,
      description: src.description ?? null,
      icon: src.icon ?? null,
      color: src.color ?? null,
      created_at: src.created_at ?? nowIso(),
      updated_at: src.updated_at ?? nowIso()
    });
  } else if (table === 'notes') {
    Object.assign(common, {
      subject_id: src.subject_id != null ? String(src.subject_id) : null,
      title: src.title ?? null,
      content: src.content ?? null,
      file_data: src.file_data ?? null,
      file_name: src.file_name ?? null,
      file_type: src.file_type ?? null,
      created_at: src.created_at ?? nowIso(),
      updated_at: src.updated_at ?? nowIso()
    });
  } else if (table === 'bundles') {
    Object.assign(common, {
      name: src.name ?? 'Untitled Bundle',
      description: src.description ?? null,
      updated_at: src.updated_at ?? nowIso()
    });
  } else if (table === 'bundle_tests') {
    Object.assign(common, {
      bundle_id: src.bundle_id != null ? String(src.bundle_id) : '',
      bundle_subject_id: src.bundle_subject_id != null
        ? String(src.bundle_subject_id) : null,
      bundle_subject_name: src.bundle_subject_name ?? null,
      name: src.name ?? 'Untitled Test',
      description: src.description ?? null,
      level: src.level ?? null,
      difficulty: src.difficulty ?? null,
      time_limit: src.time_limit ?? null,
      html_content: src.html_content ?? null,
      is_paid: src.is_paid == null ? null : (src.is_paid ? 1 : 0),
      access_type: src.access_type ?? null,
      access_mode: src.access_mode ?? null,
      access_override: src.access_override ?? null,
      price: src.price ?? null,
      total_questions: src.total_questions ?? null,
      updated_at: src.updated_at ?? nowIso(),
      deleted_at: src.deleted_at ?? null
    });
  } else if (table === 'banners') {
    Object.assign(common, {
      title: src.title ?? null,
      description: src.description ?? null,
      price: src.price ?? null,
      image: src.image ?? null,
      qrData: src.qrData ?? null,
      link_type: src.link_type ?? null,
      link: src.link ?? null,
      bundle_id: src.bundle_id == null || src.bundle_id === ''
        ? null : String(src.bundle_id),
      subject_id: src.subject_id ?? null,
      test_id: src.test_id ?? null,
      slide_seconds: src.slide_seconds ?? null,
      updated_at: src.updated_at ?? nowIso()
    });
  } else if (table === 'activation_codes') {
    Object.assign(common, {
      code: src.code ?? src.code_hash ?? null,
      bundle_id: src.bundle_id != null ? String(src.bundle_id) : null,
      amount: src.amount ?? 0,
      status: src.status ?? 'unused',
      redeemed_by: src.redeemed_by ?? null,
      redeemed_at: src.redeemed_at ?? null,
      created_at: src.created_at ?? nowIso()
    });
  } else if (table === 'entitlements') {
    Object.assign(common, {
      user_key: src.user_key ?? '',
      bundle_id: src.bundle_id != null ? String(src.bundle_id) : '',
      created_at: src.created_at ?? nowIso()
    });
  } else if (table === 'emp_test_submissions') {
    Object.assign(common, {
      attempt_id: src.attempt_id ?? id,
      user_id: src.user_id != null ? String(src.user_id) : null,
      username: src.username ?? null,
      test_id: src.test_id != null ? String(src.test_id) : null,
      bundle_id: src.bundle_id != null ? String(src.bundle_id) : null,
      subject_id: src.subject_id != null ? String(src.subject_id) : null,
      test_name: src.test_name ?? null,
      score: src.score ?? null,
      total_marks: src.total_marks ?? null,
      accuracy: src.accuracy ?? null,
      percentile: src.percentile ?? null,
      status: src.status ?? null,
      completed_at: src.completed_at ?? null,
      created_at: src.created_at ?? nowIso()
    });
  } else if (table === 'emp_analytics_events') {
    Object.assign(common, {
      user_id: src.user_id != null ? String(src.user_id) : null,
      username: src.username ?? null,
      event_type: src.event_type ?? null,
      occurred_at: src.occurred_at ?? nowIso()
    });
  } else if (table === 'content_notifications') {
    Object.assign(common, {
      title: src.title ?? null,
      description: src.description ?? null,
      content_type: src.content_type ?? null,
      content_id: src.content_id == null ? null : String(src.content_id),
      created_at: src.created_at ?? nowIso()
    });
  } else if (table === 'admin_users') {
    Object.assign(common, {
      user_id: String(src.user_id ?? id),
      email: src.email ?? null,
      created_at: src.created_at ?? nowIso()
    });
  } else if (table === 'app_releases') {
    Object.assign(common, {
      release_id: String(src.release_id ?? id),
      release_path: src.release_path ?? null,
      release_url: src.release_url ?? null,
      published_at: src.published_at ?? nowIso(),
      size_bytes: src.size_bytes ?? null,
      content_hash: src.content_hash ?? null,
      active: src.active ? 1 : 0
    });
  } else if (table === 'cf_users') {
    Object.assign(common, {
      email: src.email ?? null,
      password_hash: src.password_hash ?? null,
      role: src.role ?? 'user',
      created_at: src.created_at ?? nowIso()
    });
  }

  return common;
}

function d1RowToSource(row) {
  const data = safeJsonParse(row.data_json);
  const base = { ...row };
  delete base.data_json;
  return { ...base, ...data };
}

function tableColumns(table) {
  const map = {
    subjects: [
      'id', 'name', 'description', 'icon', 'color',
      'created_at', 'updated_at', 'data_json'
    ],
    notes: [
      'id', 'subject_id', 'title', 'content', 'file_data',
      'file_name', 'file_type', 'created_at', 'updated_at', 'data_json'
    ],
    bundles: ['id', 'name', 'description', 'updated_at', 'data_json'],
    bundle_tests: [
      'id', 'bundle_id', 'bundle_subject_id', 'bundle_subject_name',
      'name', 'description', 'level', 'difficulty', 'time_limit',
      'html_content', 'is_paid', 'access_type', 'access_mode',
      'access_override', 'price', 'total_questions', 'updated_at',
      'deleted_at', 'data_json'
    ],
    banners: [
      'id', 'title', 'description', 'price', 'image', 'qrData',
      'link_type', 'link', 'bundle_id', 'subject_id', 'test_id',
      'slide_seconds', 'updated_at', 'data_json'
    ],
    activation_codes: [
      'id', 'code', 'bundle_id', 'amount', 'status',
      'redeemed_by', 'redeemed_at', 'created_at', 'data_json'
    ],
    entitlements: [
      'id', 'user_key', 'bundle_id', 'created_at', 'data_json'
    ],
    emp_test_submissions: [
      'id', 'attempt_id', 'user_id', 'username', 'test_id',
      'bundle_id', 'subject_id', 'test_name', 'score', 'total_marks',
      'accuracy', 'percentile', 'status', 'completed_at',
      'created_at', 'data_json'
    ],
    emp_analytics_events: [
      'id', 'user_id', 'username', 'event_type', 'occurred_at', 'data_json'
    ],
    content_notifications: [
      'id', 'title', 'description', 'content_type',
      'content_id', 'created_at', 'data_json'
    ],
    admin_users: ['user_id', 'email', 'created_at'],
    app_releases: [
      'release_id', 'release_path', 'release_url', 'published_at',
      'size_bytes', 'content_hash', 'active', 'data_json'
    ],
    cf_users: [
      'id', 'email', 'password_hash', 'role', 'created_at', 'data_json'
    ]
  };

  return map[table] || [];
}

function uniqueKey(table, src, conflict) {
  if (
    conflict &&
    table === 'emp_test_submissions' &&
    src[conflict] != null
  ) {
    return { field: conflict, value: String(src[conflict]) };
  }

  if (table === 'admin_users') {
    return { field: 'user_id', value: String(src.user_id ?? src.id) };
  }

  if (table === 'app_releases') {
    return { field: 'release_id', value: String(src.release_id ?? src.id) };
  }

  return { field: 'id', value: String(src.id) };
}

function adminAllowed(request, env) {
  if (!env.ADMIN_API_KEY) return true;

  const supplied =
    request.headers.get('X-EMP-Admin-Key') ||
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');

  return supplied === env.ADMIN_API_KEY;
}

async function readTable(env, table, url) {
  const cols = tableColumns(table);
  if (!cols.length) throw new Error('Unsupported table: ' + table);

  let sql = `SELECT ${cols.map(c => '"' + c + '"').join(',')} FROM "${table}"`;
  const bindValues = [];

  if (table === 'bundle_tests') {
    const conditions = [];

    for (const f of parseFilters(url)) {
      if (f.op !== 'eq' || !['name', 'bundle_id'].includes(f.key)) continue;

      const key = f.key;
      const value = String(f.val ?? '');
      conditions.push(
        `(CAST(COALESCE("${key}", '') AS TEXT) = ? OR ` +
        `CAST(COALESCE(json_extract("data_json", '$.${key}'), '') AS TEXT) = ?)`
      );
      bindValues.push(value, value);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  }

  const rows = await env.DB.prepare(sql).bind(...bindValues).all();

  let out = (rows.results || []).map(d1RowToSource);
  out = out.filter(r => rowMatches(r, parseFilters(url)));

  const orders = parseOrder(url.searchParams.get('order'));

  for (let i = orders.length - 1; i >= 0; i--) {
    const order = orders[i];
    out.sort((a, b) =>
      order.dir * compareValue(a[order.field], b[order.field])
    );
  }

  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);
  const limitRaw = url.searchParams.get('limit');

  if (limitRaw != null) {
    out = out.slice(offset, offset + Math.max(0, Number(limitRaw) || 0));
  } else if (offset) {
    out = out.slice(offset);
  }

  const fields = parseSelect(url.searchParams.get('select'));
  return out.map(row => applySelect(row, fields));
}

/* FIX: update data_json as well as the indexed columns. */
async function upsertSourceRow(env, table, src, conflict) {
  const d = sourceRowToD1(table, src);
  const cols = tableColumns(table).filter(c => c !== 'data_json');
  const key = uniqueKey(table, src, conflict);

  const existing = await env.DB.prepare(
    `SELECT 1 FROM "${table}" WHERE "${key.field}" = ? LIMIT 1`
  ).bind(key.value).first();

  if (existing) {
    const updateCols = [...cols.filter(c => c !== key.field), 'data_json'];
    const set = updateCols.map(c => `"${c}"=?`).join(',');
    const vals = updateCols.map(c =>
      c === 'data_json' ? d.data_json : (d[c] ?? null)
    );

    await env.DB.prepare(
      `UPDATE "${table}" SET ${set} WHERE "${key.field}"=?`
    ).bind(...vals, key.value).run();
  } else {
    const all = [...cols, 'data_json'];
    const placeholders = all.map(() => '?').join(',');
    const vals = [...cols.map(c => d[c] ?? null), d.data_json];

    await env.DB.prepare(
      `INSERT INTO "${table}" (${all.map(c => '"' + c + '"').join(',')})
       VALUES (${placeholders})`
    ).bind(...vals).run();
  }

  return d;
}

async function deleteByFilters(env, table, url) {
  const rows = await readTable(env, table, url);
  let count = 0;

  for (const row of rows) {
    const key = table === 'admin_users'
      ? 'user_id'
      : table === 'app_releases'
        ? 'release_id'
        : 'id';

    const value = row[key];
    if (value == null) continue;

    const result = await env.DB.prepare(
      `DELETE FROM "${table}" WHERE "${key}"=?`
    ).bind(String(value)).run();

    count += Number(result.meta?.changes || 0);
  }

  return count;
}

async function handleRest(request, env, table, url) {
  if (!TABLES.has(table)) return bad('Table not found: ' + table, 404);

  const method = request.method;
  const isWrite = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);

  if (
    isWrite &&
    !adminAllowed(request, env) &&
    !['emp_test_submissions', 'emp_analytics_events', 'entitlements'].includes(table)
  ) {
    return bad('Unauthorized', 401);
  }

  if (method === 'GET') return json(await readTable(env, table, url));

  if (method === 'POST' || method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return bad('Invalid JSON body');
    }

    const rows = Array.isArray(body) ? body : [body];
    const conflict = url.searchParams.get('on_conflict') || null;
    const out = [];

    for (const src of rows) {
      out.push(await upsertSourceRow(env, table, src, conflict));
    }

    const prefer = (request.headers.get('Prefer') || '').toLowerCase();
    if (prefer.includes('return=minimal')) {
      return new Response(null, { status: 201, headers: corsHeaders() });
    }

    return json(out.map(d1RowToSource), 201);
  }

  if (method === 'PATCH') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return bad('Invalid JSON body');
    }

    const rows = await readTable(env, table, url);
    if (!rows.length) return json([]);

    const out = [];
    for (const row of rows) {
      out.push(await upsertSourceRow(env, table, { ...row, ...body }, null));
    }

    const prefer = (request.headers.get('Prefer') || '').toLowerCase();
    if (prefer.includes('return=minimal')) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    return json(out);
  }

  if (method === 'DELETE') {
    if (!adminAllowed(request, env)) return bad('Unauthorized', 401);

    const count = await deleteByFilters(env, table, url);
    return new Response(null, {
      status: 204,
      headers: corsHeaders({ 'X-Deleted-Rows': String(count) })
    });
  }

  return bad('Method not allowed', 405);
}

/* =========================================================
   ACTIVATION CODE HELPERS
   ========================================================= */

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function normalizeActivationCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

function activationCodeMatches(row, inputCode, hashes) {
  const data = safeJsonParse(row.data_json);
  const candidates = [
    row.code, data.code, data.code_hash,
    data.activation_code, data.activationCode
  ].filter(v => v != null && String(v).trim() !== '').map(String);

  const normalized = normalizeActivationCode(inputCode);

  for (const candidate of candidates) {
    if (candidate.trim() === inputCode.trim()) return true;
    if (normalizeActivationCode(candidate) === normalized) return true;
    if (hashes.has(candidate.trim().toLowerCase())) return true;
  }

  return false;
}

async function handleRedeemActivation(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const suppliedCode = String(body.p_code ?? '').trim();
  const bundleId = String(body.p_bundle_id ?? '').trim();
  const userKey = String(body.p_user_key ?? '').trim();

  if (!suppliedCode || !bundleId || !userKey) {
    return json({
      status: 'error',
      message: 'Missing activation code, bundle ID or user key.'
    }, 400);
  }

  const normalizedCode = normalizeActivationCode(suppliedCode);
  const hashes = new Set([
    await sha256Hex(suppliedCode),
    await sha256Hex(normalizedCode)
  ]);

  const result = await env.DB.prepare(
    `SELECT id, code, bundle_id, amount, status,
            redeemed_by, redeemed_at, created_at, data_json
     FROM activation_codes`
  ).all();

  let match = null;
  let anotherBundle = false;

  for (const row of result.results || []) {
    if (!activationCodeMatches(row, suppliedCode, hashes)) continue;
    if (String(row.bundle_id ?? '').trim() === bundleId) {
      match = row;
      break;
    }
    anotherBundle = true;
  }

  if (!match) {
    return json({
      status: anotherBundle ? 'bundle_mismatch' : 'invalid',
      message: anotherBundle
        ? 'This activation code belongs to a different bundle.'
        : 'Invalid activation code. Please check the code and try again.'
    });
  }

  const currentStatus = String(match.status ?? 'unused').trim().toLowerCase();
  if (!['unused', 'generated', 'active', ''].includes(currentStatus)) {
    return json({
      status: 'used',
      message: 'This activation code has already been redeemed.'
    });
  }

  const now = nowIso();
  const data = safeJsonParse(match.data_json);

  const update = await env.DB.prepare(
    `UPDATE activation_codes
     SET status=?, redeemed_by=?, redeemed_at=?, data_json=?
     WHERE id=?
       AND LOWER(COALESCE(status,'unused')) IN ('unused','generated','active','')`
  ).bind(
    'redeemed',
    userKey,
    now,
    JSON.stringify({
      ...data,
      status: 'redeemed',
      redeemed_by: userKey,
      redeemed_at: now
    }),
    match.id
  ).run();

  if (Number(update.meta?.changes ?? 0) !== 1) {
    return json({
      status: 'used',
      message: 'This activation code has already been redeemed.'
    });
  }

  const entitlementId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO entitlements
       (id,user_key,bundle_id,created_at,data_json)
     VALUES (?,?,?,?,?)`
  ).bind(
    entitlementId,
    userKey,
    bundleId,
    now,
    JSON.stringify({
      user_key: userKey,
      bundle_id: bundleId,
      created_at: now,
      activation_id: match.id
    })
  ).run();

  return json({
    status: 'success',
    bundle_id: bundleId,
    redeemed_by: userKey,
    redeemed_at: now
  });
}

/* =========================================================
   IMPORT AND MIGRATION
   ========================================================= */

async function fetchSupabaseJson(url, key) {
  const response = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      Accept: 'application/json'
    },
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error('Supabase ' + response.status + ' ' + body.slice(0, 220));
  }

  try {
    const data = JSON.parse(body);
    return Array.isArray(data) ? data : [];
  } catch (_) {
    throw new Error('Invalid JSON from Supabase');
  }
}

async function migrateStoreFromSupabase(env, table) {
  if (!TABLES.has(table)) throw new Error('Unsupported table ' + table);

  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_KEY || '');

  if (!base || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_KEY secrets are not configured.');
  }

  let rows = [];

  if (table === 'bundles') {
    const ids = await fetchSupabaseJson(
      base + '/rest/v1/bundles?select=id&order=id.asc', key
    );

    for (const item of ids) {
      if (item?.id == null) continue;
      const part = await fetchSupabaseJson(
        base + '/rest/v1/bundles?select=*&id=eq.' +
        encodeURIComponent(String(item.id)), key
      );
      if (part[0]) rows.push(part[0]);
    }
  } else {
    let offset = 0;
    const pageSize = 500;

    while (true) {
      const part = await fetchSupabaseJson(
        base + '/rest/v1/' + table +
        '?select=*&limit=' + pageSize + '&offset=' + offset,
        key
      );
      rows.push(...part);
      if (part.length < pageSize) break;
      offset += part.length;
      if (offset > 50000) break;
    }
  }

  for (const src of rows) await upsertSourceRow(env, table, src, null);

  return { table, source_rows: rows.length, written: rows.length };
}

async function importRowsToD1(env, table, rows) {
  if (!TABLES.has(table)) throw new Error('Unsupported table ' + table);
  if (!Array.isArray(rows)) throw new Error('rows must be an array');

  for (const src of rows) await upsertSourceRow(env, table, src, null);
  return rows.length;
}

async function handleJsonImport(request, env) {
  if (request.method !== 'POST') return bad('Method not allowed', 405);
  if (!adminAllowed(request, env)) return bad('Unauthorized', 401);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const table = String(body?.table || '').trim();
  const rows = Array.isArray(body?.rows) ? body.rows : [];

  if (!table) return bad('Missing table');
  if (table !== 'tests' && !TABLES.has(table)) {
    return bad('Unsupported table: ' + table);
  }

  let written = 0;
  let bundleTestsWritten = 0;

  if (table === 'bundles') {
    for (const bundle of rows) {
      await upsertSourceRow(env, 'bundles', bundle, null);
      written++;

      for (const subject of (Array.isArray(bundle?.subjects) ? bundle.subjects : [])) {
        const tests = Array.isArray(subject?.tests) ? subject.tests : [];

        const testRows = tests.map(test => ({
          ...test,
          subject_id: test?.subject_id ?? subject?.id ?? null,
          bundle_id: test?.bundle_id ?? bundle?.id ?? null,
          bundle_subject_id: test?.bundle_subject_id ?? subject?.id ?? null,
          bundle_subject_name: test?.bundle_subject_name ?? subject?.name ?? null,
          updated_at: test?.updated_at ?? bundle?.updated_at ?? nowIso(),
          deleted_at: test?.deleted_at ?? null
        })).filter(test =>
          test.id != null && test.bundle_id != null &&
          test.bundle_subject_id != null && test.name != null
        );

        bundleTestsWritten += await importRowsToD1(env, 'bundle_tests', testRows);
      }
    }
  } else if (table === 'tests') {
    const testRows = rows.map(test => ({
      ...test,
      bundle_id: test?.bundle_id ?? null,
      bundle_subject_id: test?.bundle_subject_id ?? null
    })).filter(test =>
      test.id != null && test.bundle_id != null &&
      test.bundle_subject_id != null && test.name != null
    );

    bundleTestsWritten = await importRowsToD1(env, 'bundle_tests', testRows);
  } else {
    written = await importRowsToD1(env, table, rows);
  }

  return json({
    success: true,
    table,
    received: rows.length,
    written,
    bundle_tests_written: bundleTestsWritten
  });
}

async function handleMigration(request, env, url) {
  if (!adminAllowed(request, env)) return bad('Unauthorized', 401);

  const tables = (
    url.searchParams.get('tables') ||
    'subjects,notes,bundles,bundle_tests,banners,content_notifications'
  ).split(',').map(x => x.trim()).filter(Boolean);

  const results = [];
  for (const table of tables) {
    results.push(await migrateStoreFromSupabase(env, table));
  }

  return json({ success: true, results });
}

async function handleRpc(request, env, fn) {
  if (fn !== 'get_bundle_entitlements') return bad('RPC not found', 404);

  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const userKey = String(body.p_user_key || '').trim();
  if (!userKey) return json([]);

  const rows = await env.DB.prepare(
    `SELECT bundle_id,created_at,data_json
     FROM entitlements WHERE user_key=?
     ORDER BY created_at DESC`
  ).bind(userKey).all();

  return json((rows.results || []).map(row => ({
    bundle_id: row.bundle_id,
    created_at: row.created_at,
    ...safeJsonParse(row.data_json)
  })));
}

/* =========================================================
   ANALYTICS EVENTS
   ========================================================= */

async function handleAnalyticsEvent(request, env) {
  if (request.method !== 'POST') return bad('Method not allowed', 405);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const userId = String(body.user_id ?? body.userId ?? '').trim();
  const username = String(body.username ?? body.name ?? 'User').trim();
  const eventType = String(body.event_type ?? body.type ?? 'event').trim();

  if (!userId) return bad('Missing user_id');

  const record = {
    ...body,
    id: String(body.id ?? crypto.randomUUID()),
    user_id: userId,
    username,
    event_type: eventType,
    occurred_at: String(body.occurred_at ?? nowIso())
  };

  await upsertSourceRow(env, 'emp_analytics_events', record, null);

  return json({
    success: true,
    id: record.id,
    event_type: eventType,
    user_id: userId
  });
}

/* =========================================================
   RANKING AND SUBMISSION HELPERS
   ========================================================= */

function metricNum(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function submissionData(row) {
  return {
    ...safeJsonParse(row.data_json),
    ...row
  };
}

function rankAttempt(row) {
  const r = submissionData(row);
  const correct = metricNum(r.correct, r.correct_answers, r.right);
  const wrong = metricNum(r.wrong, r.wrong_answers, r.incorrect);
  const skipped = metricNum(r.skipped, r.unanswered);
  const totalQuestions = metricNum(
    r.total_questions,
    r.totalQuestions,
    r.question_count,
    correct + wrong + skipped
  );
  const totalMarks = metricNum(
    r.total_marks,
    r.totalMarks,
    r.max_marks,
    r.maxMarks,
    totalQuestions
  );

  const score = metricNum(r.score, r.total_score, r.marks_obtained);
  const computedAccuracy = correct + wrong > 0
    ? (correct / (correct + wrong)) * 100
    : 0;

  const accuracy = r.accuracy != null && r.accuracy !== ''
    ? metricNum(r.accuracy)
    : computedAccuracy;

  return {
    ...r,
    id: String(r.id ?? ''),
    attempt_id: String(r.attempt_id ?? r.id ?? ''),
    user_id: String(r.user_id ?? ''),
    username: String(r.username ?? r.name ?? 'User'),
    test_id: String(r.test_id ?? ''),
    bundle_id: String(r.bundle_id ?? ''),
    subject_id: String(r.subject_id ?? ''),
    test_name: String(r.test_name ?? r.name ?? 'Test'),
    score,
    total_marks: totalMarks,
    correct,
    wrong,
    skipped,
    total_questions: totalQuestions,
    accuracy,
    completed_at: r.completed_at ?? r.created_at ?? null
  };
}

function rankSort(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;

  const at = Date.parse(a.completed_at || '') || Infinity;
  const bt = Date.parse(b.completed_at || '') || Infinity;
  if (at !== bt) return at - bt;

  return String(a.user_id).localeCompare(String(b.user_id));
}

async function completedSubmissions(env, params = {}) {
  const result = await env.DB.prepare(
    `SELECT id,attempt_id,user_id,username,test_id,bundle_id,subject_id,
            test_name,score,total_marks,accuracy,percentile,status,
            completed_at,created_at,data_json
     FROM emp_test_submissions`
  ).all();

  let rows = (result.results || [])
    .map(rankAttempt)
    .filter(r => r.user_id && r.test_id)
    .filter(r => {
      const status = String(r.status ?? '').toLowerCase();
      return !status || ['completed', 'complete', 'submitted', 'finished', 'success']
        .includes(status);
    });

  if (params.test_id != null && params.test_id !== '') {
    rows = rows.filter(r => r.test_id === String(params.test_id));
  }
  if (params.bundle_id != null && params.bundle_id !== '') {
    rows = rows.filter(r => r.bundle_id === String(params.bundle_id));
  }
  if (params.subject_id != null && params.subject_id !== '') {
    rows = rows.filter(r => r.subject_id === String(params.subject_id));
  }

  // Keep only the latest record for each user and test.
  const latest = new Map();
  for (const row of rows) {
    const key = row.test_id + '::' + row.user_id;
    const old = latest.get(key);
    const rowTime = Date.parse(row.completed_at || row.created_at || '') || 0;
    const oldTime = old
      ? (Date.parse(old.completed_at || old.created_at || '') || 0)
      : -1;

    if (!old || rowTime > oldTime) latest.set(key, row);
  }

  return [...latest.values()];
}

function assignRanks(rows) {
  const sorted = [...rows].sort(rankSort);
  const n = sorted.length;

  return sorted.map((row, i) => {
    const rank = i > 0 && rankSort(sorted[i - 1], row) === 0
      ? sorted[i - 1].rank
      : i + 1;

    return {
      ...row,
      rank,
      participants: n,
      percentile: n <= 1
        ? 100
        : Number((((n - rank) / (n - 1)) * 100).toFixed(2))
    };
  });
}

async function handleRankSubmit(request, env) {
  if (request.method !== 'POST') return bad('Method not allowed', 405);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const userId = String(body.user_id ?? body.userId ?? '').trim();
  const testId = String(body.test_id ?? body.testId ?? '').trim();

  if (!userId || !testId) return bad('Missing user_id or test_id');

  const now = nowIso();
  const attemptId = String(
    body.attempt_id ?? body.attemptId ?? crypto.randomUUID()
  );

  const correct = metricNum(body.correct, body.right, body.correct_answers);
  const wrong = metricNum(body.wrong, body.incorrect, body.wrong_answers);
  const skipped = metricNum(body.skipped, body.unanswered);
  const totalQuestions = metricNum(
    body.total_questions,
    body.totalQuestions,
    body.question_count,
    correct + wrong + skipped
  );

  const score = metricNum(body.score, body.total_score, body.marks_obtained);
  const totalMarks = metricNum(
    body.total_marks,
    body.totalMarks,
    body.max_marks,
    body.maxMarks,
    totalQuestions
  );

  const accuracy = body.accuracy != null
    ? metricNum(body.accuracy)
    : (correct + wrong > 0 ? correct / (correct + wrong) * 100 : 0);

  const record = {
    ...body,
    id: String(body.id ?? attemptId),
    attempt_id: attemptId,
    user_id: userId,
    username: String(body.username ?? body.name ?? 'User'),
    test_id: testId,
    bundle_id: body.bundle_id == null ? null : String(body.bundle_id),
    subject_id: body.subject_id == null ? null : String(body.subject_id),
    test_name: String(body.test_name ?? body.testName ?? body.name ?? 'Test'),
    score,
    total_marks: totalMarks,
    accuracy,
    correct,
    wrong,
    skipped,
    total_questions: totalQuestions,
    percentile: 0,
    status: 'completed',
    completed_at: String(body.completed_at ?? now),
    created_at: String(body.created_at ?? now)
  };

  const existing = await env.DB.prepare(
    `SELECT id FROM emp_test_submissions
     WHERE attempt_id=? LIMIT 1`
  ).bind(attemptId).first();

  await upsertSourceRow(env, 'emp_test_submissions', record, null);

  const all = await completedSubmissions(env, {
    test_id: testId,
    bundle_id: record.bundle_id,
    subject_id: record.subject_id
  });

  const ranked = assignRanks(all);
  const mine = ranked.find(r => r.user_id === userId);

  return json({
    success: true,
    submission: record,
    rank: mine?.rank ?? null,
    participants: ranked.length,
    percentile: mine?.percentile ?? 0,
    updated: Boolean(existing)
  });
}

async function handleRankTests(request, env, url) {
  const rows = await completedSubmissions(env, {
    bundle_id: url.searchParams.get('bundle_id') || undefined,
    subject_id: url.searchParams.get('subject_id') || undefined
  });

  const grouped = new Map();
  for (const row of rows) {
    const key = row.test_id;
    if (!grouped.has(key)) {
      grouped.set(key, {
        test_id: row.test_id,
        test_name: row.test_name,
        bundle_id: row.bundle_id,
        subject_id: row.subject_id,
        participants: 0,
        highest_score: row.score,
        average_score: 0,
        _sum: 0
      });
    }

    const item = grouped.get(key);
    item.participants++;
    item._sum += row.score;
    item.highest_score = Math.max(item.highest_score, row.score);
  }

  const result = [...grouped.values()].map(item => {
    item.average_score = item.participants
      ? Number((item._sum / item.participants).toFixed(2))
      : 0;
    delete item._sum;
    return item;
  });

  return json(result);
}

async function handleRankParticipants(request, env, url) {
  const testId = url.searchParams.get('test_id') ||
    url.searchParams.get('testId');

  if (!testId) return bad('Missing test_id');

  const rows = await completedSubmissions(env, {
    test_id: testId,
    bundle_id: url.searchParams.get('bundle_id') || undefined,
    subject_id: url.searchParams.get('subject_id') || undefined
  });

  return json(assignRanks(rows));
}

async function handleRankLeaderboard(request, env, url) {
  const testId = url.searchParams.get('test_id') ||
    url.searchParams.get('testId');

  if (!testId) return bad('Missing test_id');

  const rows = await completedSubmissions(env, {
    test_id: testId,
    bundle_id: url.searchParams.get('bundle_id') || undefined,
    subject_id: url.searchParams.get('subject_id') || undefined
  });

  const ranked = assignRanks(rows);
  const userId = url.searchParams.get('user_id') ||
    url.searchParams.get('userId');

  const limit = Math.min(
    500,
    Math.max(1, Number(url.searchParams.get('limit') || 100))
  );

  return json({
    test_id: testId,
    participants: ranked.length,
    leaderboard: ranked.slice(0, limit),
    my_rank: userId
      ? ranked.find(r => r.user_id === String(userId)) ?? null
      : null
  });
}

async function handleClearAnalytics(request, env) {
  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return bad('Method not allowed', 405);
  }
  if (!adminAllowed(request, env)) return bad('Unauthorized', 401);

  await env.DB.prepare('DELETE FROM emp_test_submissions').run();
  await env.DB.prepare('DELETE FROM emp_analytics_events').run();

  return json({ success: true, message: 'Analytics cleared.' });
}

/* =========================================================
   RELEASE STORAGE
   ========================================================= */

async function handleReleaseStorage(request, env, path) {
  const parts = path.split('/').filter(Boolean);
  const isPublic = parts[2] === 'public';
  const objectIndex = isPublic ? 4 : 3;
  const bucket = parts[objectIndex];
  const objectPath = parts.slice(objectIndex + 1).join('/');

  if (bucket !== 'exam-master-releases') {
    return bad('Storage bucket not found', 404);
  }

  if (request.method === 'GET' && isPublic) {
    const row = await env.DB.prepare(
      `SELECT data_json FROM app_releases
       WHERE release_path=? OR release_id=? LIMIT 1`
    ).bind(objectPath, objectPath).first();

    if (!row) return bad('Release not found', 404);

    const data = safeJsonParse(row.data_json);
    const html = String(data.html_content || data.html || '');
    if (!html) return bad('Release content missing', 404);

    return text(html, 200, 'text/html; charset=utf-8');
  }

  if (['PUT', 'POST'].includes(request.method)) {
    if (!adminAllowed(request, env)) return bad('Unauthorized', 401);

    const html = await request.text();
    const releaseId =
      objectPath.split('/').pop()?.replace(/\.html$/i, '') ||
      crypto.randomUUID();

    const row = {
      release_id: releaseId,
      release_path: objectPath,
      release_url: new URL(
        '/storage/v1/object/public/' + bucket + '/' + objectPath,
        request.url
      ).toString(),
      published_at: nowIso(),
      size_bytes: html.length,
      active: 0,
      html_content: html
    };

    const existing = await env.DB.prepare(
      'SELECT data_json FROM app_releases WHERE release_id=?'
    ).bind(releaseId).first();

    const previous = existing ? safeJsonParse(existing.data_json) : {};
    const merged = { ...previous, ...row };
    const d = sourceRowToD1('app_releases', merged);

    if (existing) {
      await env.DB.prepare(
        `UPDATE app_releases
         SET release_path=?,release_url=?,published_at=?,size_bytes=?,data_json=?
         WHERE release_id=?`
      ).bind(
        d.release_path,
        d.release_url,
        d.published_at,
        d.size_bytes,
        JSON.stringify(merged),
        releaseId
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO app_releases
         (release_id,release_path,release_url,published_at,
          size_bytes,content_hash,active,data_json)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(
        releaseId, d.release_path, d.release_url, d.published_at,
        d.size_bytes, null, 0, JSON.stringify(merged)
      ).run();
    }

    return json({ Key: objectPath, release_id: releaseId });
  }

  return bad('Method not allowed', 405);
}

async function handleHealth(env) {
  try {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();

    return json({
      success: true,
      database: 'connected',
      tables: result.results || [],
      api: 'phase2-rest-compat'
    });
  } catch (error) {
    return json({ success: false, error: error.message }, 500);
  }
}

/* =========================================================
   MAIN WORKER
   ========================================================= */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/' || path === '/health') {
        return handleHealth(env);
      }

      if (path === '/api/analytics/event') {
        return handleAnalyticsEvent(request, env);
      }

      if (path === '/api/rank/submit') {
        return handleRankSubmit(request, env);
      }

      if (path === '/api/rank/tests') {
        return handleRankTests(request, env, url);
      }

      if (path === '/api/rank/participants') {
        return handleRankParticipants(request, env, url);
      }

      if (path === '/api/rank/leaderboard') {
        return handleRankLeaderboard(request, env, url);
      }

      if (path === '/api/admin/analytics/clear') {
        return handleClearAnalytics(request, env);
      }

      if (path.startsWith('/rest/v1/rpc/')) {
        const fn = path.split('/').pop();

        if (fn === 'redeem_activation_code') {
          return handleRedeemActivation(request, env);
        }

        return handleRpc(request, env, fn);
      }

      if (path === '/api/migrate/supabase') {
        return handleMigration(request, env, url);
      }

      if (path === '/api/import/json') {
        return handleJsonImport(request, env);
      }

      if (path.startsWith('/rest/v1/')) {
        const table = path.slice('/rest/v1/'.length).split('/')[0];
        return handleRest(request, env, table, url);
      }

      if (path.startsWith('/storage/v1/object/')) {
        return handleReleaseStorage(request, env, path);
      }

      if (path === '/api/status') {
        return json({
          ok: true,
          worker: 'exammaster-pro-api',
          database: 'D1',
          r2: false
        });
      }

      return bad('Not found', 404);
    } catch (error) {
      console.error('Worker error:', error);

      return json({
        error: error.message || String(error)
      }, 500);
    }
  }
};
