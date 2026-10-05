const TABLES = new Set([
  'subjects','notes','bundles','bundle_tests','banners','activation_codes',
  'entitlements','emp_test_submissions','emp_analytics_events',
  'content_notifications','admin_users','app_releases','cf_users'
]);

const ID_TABLES = new Set([
  'subjects','notes','bundles','bundle_tests','banners','activation_codes',
  'entitlements','emp_test_submissions','emp_analytics_events',
  'content_notifications','app_releases','cf_users'
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

function text(
  body,
  status = 200,
  contentType = 'text/plain; charset=utf-8'
) {
  return new Response(body, {
    status,
    headers: corsHeaders({ 'Content-Type': contentType })
  });
}

function bad(message, status = 400, details = null) {
  return json(
    { code: status, message, ...(details ? { details } : {}) },
    status
  );
}

function nowIso() {
  return new Date().toISOString();
}

function cleanIdent(v) {
  const s = String(v || '');
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : null;
}

function parseFilters(url) {
  const filters = [];

  for (const [key, value] of url.searchParams.entries()) {
    if (
      [
        'select',
        'order',
        'limit',
        'offset',
        'on_conflict',
        'columns',
        'apikey'
      ].includes(key)
    ) {
      continue;
    }

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
        .map(x => x.replace(/^"|"$/g, ''));
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
        return (
          Array.isArray(val) &&
          val.some(x => String(actual ?? '') === String(x))
        );

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
    .map(s => s.trim())
    .filter(Boolean)
    .map(cleanIdent)
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

function sourceRowToD1(table, source) {
  const src =
    source && typeof source === 'object'
      ? JSON.parse(JSON.stringify(source))
      : {};

  const id =
    src.id != null
      ? String(src.id)
      : crypto.randomUUID();

  const data = JSON.stringify(src);

  const common = {
    id,
    data_json: data
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
      name: src.name ?? 'Untitled Test',
      description: src.description ?? null,
      level: src.level ?? null,
      difficulty: src.difficulty ?? null,
      time_limit: src.time_limit ?? null,
      html_content: src.html_content ?? null,
      is_paid:
        src.is_paid == null
          ? null
          : (src.is_paid ? 1 : 0),
      access_type: src.access_type ?? null,
      access_mode: src.access_mode ?? null,
      access_override: src.access_override ?? null,
      price: src.price ?? null,
      total_questions: src.total_questions ?? null,
      updated_at: src.updated_at ?? nowIso(),
      deleted_at: src.deleted_at ?? null
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
        src.bundle_id == null ||
        src.bundle_id === ''
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
      code: src.code ?? src.code_hash ?? null,
      bundle_id:
        src.bundle_id != null
          ? String(src.bundle_id)
          : null,
      amount: src.amount ?? 0,
      status: src.status ?? 'unused',
      redeemed_by: src.redeemed_by ?? null,
      redeemed_at: src.redeemed_at ?? null,
      created_at: src.created_at ?? nowIso()
    });
  }

  else if (table === 'entitlements') {
    Object.assign(common, {
      user_key: src.user_key ?? '',
      bundle_id:
        src.bundle_id != null
          ? String(src.bundle_id)
          : '',
      created_at: src.created_at ?? nowIso()
    });
  }

  else if (table === 'emp_test_submissions') {
    Object.assign(common, {
      attempt_id: src.attempt_id ?? id,
      user_id:
        src.user_id != null
          ? String(src.user_id)
          : null,
      username: src.username ?? null,
      test_id:
        src.test_id != null
          ? String(src.test_id)
          : null,
      bundle_id:
        src.bundle_id != null
          ? String(src.bundle_id)
          : null,
      subject_id:
        src.subject_id != null
          ? String(src.subject_id)
          : null,
      test_name: src.test_name ?? null,
      score: src.score ?? null,
      total_marks: src.total_marks ?? null,
      accuracy: src.accuracy ?? null,
      percentile: src.percentile ?? null,
      status: src.status ?? null,
      completed_at: src.completed_at ?? null,
      created_at: src.created_at ?? nowIso()
    });
  }

  else if (table === 'emp_analytics_events') {
    Object.assign(common, {
      user_id:
        src.user_id != null
          ? String(src.user_id)
          : null,
      username: src.username ?? null,
      event_type: src.event_type ?? null,
      occurred_at: src.occurred_at ?? nowIso()
    });
  }

  else if (table === 'content_notifications') {
    Object.assign(common, {
      title: src.title ?? null,
      description: src.description ?? null,
      content_type: src.content_type ?? null,
      content_id:
        src.content_id == null
          ? null
          : String(src.content_id),
      created_at: src.created_at ?? nowIso()
    });
  }

  else if (table === 'admin_users') {
    Object.assign(common, {
      user_id: String(src.user_id ?? id),
      email: src.email ?? null,
      created_at: src.created_at ?? nowIso()
    });
  }

  else if (table === 'app_releases') {
    Object.assign(common, {
      release_id:
        String(src.release_id ?? id),
      release_path: src.release_path ?? null,
      release_url: src.release_url ?? null,
      published_at: src.published_at ?? nowIso(),
      size_bytes: src.size_bytes ?? null,
      content_hash: src.content_hash ?? null,
      active: src.active ? 1 : 0
    });
  }

  else if (table === 'cf_users') {
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
  let data = {};

  try {
    data = JSON.parse(row.data_json || '{}');
  } catch (_) {}

  const base = { ...row };

  delete base.data_json;

  return {
    ...base,
    ...data
  };
}

function tableColumns(table) {
  const map = {
    subjects: [
      'id',
      'name',
      'description',
      'icon',
      'color',
      'created_at',
      'updated_at',
      'data_json'
    ],

    notes: [
      'id',
      'subject_id',
      'title',
      'content',
      'file_data',
      'file_name',
      'file_type',
      'created_at',
      'updated_at',
      'data_json'
    ],

    bundles: [
      'id',
      'name',
      'description',
      'updated_at',
      'data_json'
    ],

    bundle_tests: [
      'id',
      'bundle_id',
      'bundle_subject_id',
      'bundle_subject_name',
      'name',
      'description',
      'level',
      'difficulty',
      'time_limit',
      'html_content',
      'is_paid',
      'access_type',
      'access_mode',
      'access_override',
      'price',
      'total_questions',
      'updated_at',
      'deleted_at',
      'data_json'
    ],

    banners: [
      'id',
      'title',
      'description',
      'price',
      'image',
      'qrData',
      'link_type',
      'link',
      'bundle_id',
      'subject_id',
      'test_id',
      'slide_seconds',
      'updated_at',
      'data_json'
    ],

    activation_codes: [
      'id',
      'code',
      'bundle_id',
      'amount',
      'status',
      'redeemed_by',
      'redeemed_at',
      'created_at',
      'data_json'
    ],

    entitlements: [
      'id',
      'user_key',
      'bundle_id',
      'created_at',
      'data_json'
    ],

    emp_test_submissions: [
      'id',
      'attempt_id',
      'user_id',
      'username',
      'test_id',
      'bundle_id',
      'subject_id',
      'test_name',
      'score',
      'total_marks',
      'accuracy',
      'percentile',
      'status',
      'completed_at',
      'created_at',
      'data_json'
    ],

    emp_analytics_events: [
      'id',
      'user_id',
      'username',
      'event_type',
      'occurred_at',
      'data_json'
    ],

    content_notifications: [
      'id',
      'title',
      'description',
      'content_type',
      'content_id',
      'created_at',
      'data_json'
    ],

    admin_users: [
      'user_id',
      'email',
      'created_at'
    ],

    app_releases: [
      'release_id',
      'release_path',
      'release_url',
      'published_at',
      'size_bytes',
      'content_hash',
      'active',
      'data_json'
    ],

    cf_users: [
      'id',
      'email',
      'password_hash',
      'role',
      'created_at',
      'data_json'
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
    return {
      field: conflict,
      value: String(src[conflict])
    };
  }

  if (table === 'admin_users') {
    return {
      field: 'user_id',
      value: String(src.user_id ?? src.id)
    };
  }

  if (table === 'app_releases') {
    return {
      field: 'release_id',
      value: String(src.release_id ?? src.id)
    };
  }

  return {
    field: 'id',
    value: String(src.id)
  };
}

function adminAllowed(request, env) {
  if (!env.ADMIN_API_KEY) return true;

  const supplied =
    request.headers.get('X-EMP-Admin-Key') ||
    request.headers
      .get('Authorization')
      ?.replace(/^Bearer\s+/i, '');

  return supplied === env.ADMIN_API_KEY;
}

async function readTable(env, table, url) {
  const cols = tableColumns(table);

  if (!cols.length) {
    throw new Error('Unsupported table: ' + table);
  }

  const rows = await env.DB
    .prepare(
      `SELECT ${cols.map(c => '"' + c + '"').join(',')} FROM "${table}"`
    )
    .all();

  let out = (rows.results || []).map(d1RowToSource);

  const filters = parseFilters(url);

  out = out.filter(r => rowMatches(r, filters));

  const orders = parseOrder(
    url.searchParams.get('order')
  );

  for (let i = orders.length - 1; i >= 0; i--) {
    const o = orders[i];

    out.sort(
      (a, b) =>
        o.dir *
        compareValue(a[o.field], b[o.field])
    );
  }

  const offset =
    Math.max(
      0,
      Number(url.searchParams.get('offset') || 0) || 0
    );

  const limitRaw =
    url.searchParams.get('limit');

  if (limitRaw != null) {
    out = out.slice(
      offset,
      offset + Math.max(0, Number(limitRaw) || 0)
    );
  } else if (offset) {
    out = out.slice(offset);
  }

  const fields = parseSelect(
    url.searchParams.get('select')
  );

  return out.map(r => applySelect(r, fields));
}

async function upsertSourceRow(
  env,
  table,
  src,
  conflict
) {
  const d = sourceRowToD1(table, src);

  const cols = tableColumns(table)
    .filter(c => c !== 'data_json');

  const key = uniqueKey(table, src, conflict);

  const existing = await env.DB
    .prepare(
      `SELECT 1 FROM "${table}" WHERE "${key.field}" = ? LIMIT 1`
    )
    .bind(key.value)
    .first();

  const values = cols.map(
    c => d[c] ?? null
  );

  if (existing) {
    const updateCols =
      cols.filter(c => c !== key.field);

    const set = updateCols
      .map(c => `"${c}"=?`)
      .join(',');

    const vals = updateCols.map(
      c => d[c] ?? null
    );

    await env.DB
      .prepare(
        `UPDATE "${table}" SET ${set} WHERE "${key.field}"=?`
      )
      .bind(...vals, key.value)
      .run();
  } else {
    const all = [...cols, 'data_json'];

    const placeholders =
      all.map(() => '?').join(',');

    const vals = [
      ...values,
      d.data_json
    ];

    await env.DB
      .prepare(
        `INSERT INTO "${table}" (${all
          .map(c => '"' + c + '"')
          .join(',')})
         VALUES (${placeholders})`
      )
      .bind(...vals)
      .run();
  }

  return d;
}

async function deleteByFilters(env, table, url) {
  const rows =
    await readTable(env, table, url);

  if (!rows.length) return 0;

  let n = 0;

  for (const row of rows) {
    const key =
      table === 'admin_users'
        ? 'user_id'
        : table === 'app_releases'
        ? 'release_id'
        : 'id';

    const val = row[key];

    if (val == null) continue;

    const r = await env.DB
      .prepare(
        `DELETE FROM "${table}" WHERE "${key}"=?`
      )
      .bind(String(val))
      .run();

    n += Number(r.meta?.changes || 0);
  }

  return n;
}

async function handleRest(
  request,
  env,
  table,
  url
) {
  if (!TABLES.has(table)) {
    return bad(
      'Table not found: ' + table,
      404
    );
  }

  const method = request.method;

  const isWrite = [
    'POST',
    'PATCH',
    'PUT',
    'DELETE'
  ].includes(method);

  if (
    isWrite &&
    !adminAllowed(request, env) &&
    ![
      'emp_test_submissions',
      'emp_analytics_events',
      'entitlements'
    ].includes(table)
  ) {
    return bad('Unauthorized', 401);
  }

  if (method === 'GET') {
    return json(
      await readTable(env, table, url)
    );
  }

  if (
    method === 'POST' ||
    method === 'PUT'
  ) {
    let body;

    try {
      body = await request.json();
    } catch (e) {
      return bad('Invalid JSON body');
    }

    const rows =
      Array.isArray(body)
        ? body
        : [body];

    const conflict =
      url.searchParams.get('on_conflict') ||
      null;

    const out = [];

    for (const src of rows) {
      out.push(
        await upsertSourceRow(
          env,
          table,
          src,
          conflict
        )
      );
    }

    const prefer =
      (
        request.headers.get('Prefer') ||
        ''
      ).toLowerCase();

    if (
      prefer.includes('return=minimal')
    ) {
      return new Response(null, {
        status: 201,
        headers: corsHeaders()
      });
    }

    return json(
      out.map(d1RowToSource),
      201
    );
  }

  if (method === 'PATCH') {
    let body;

    try {
      body = await request.json();
    } catch (_) {
      return bad('Invalid JSON body');
    }

    const rows =
      await readTable(env, table, url);

    if (!rows.length) {
      return json([]);
    }

    const out = [];

    for (const row of rows) {
      const merged =
        Object.assign({}, row, body);

      out.push(
        await upsertSourceRow(
          env,
          table,
          merged,
          null
        )
      );
    }

    const prefer =
      (
        request.headers.get('Prefer') ||
        ''
      ).toLowerCase();

    if (
      prefer.includes('return=minimal')
    ) {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    return json(out);
  }

  if (method === 'DELETE') {
    if (!adminAllowed(request, env)) {
      return bad('Unauthorized', 401);
    }

    const count =
      await deleteByFilters(
        env,
        table,
        url
      );

    return new Response(null, {
      status: 204,
      headers: corsHeaders({
        'X-Deleted-Rows': String(count)
      })
    });
  }

  return bad(
    'Method not allowed',
    405
  );
}

async function sha256Hex(value) {
  const bytes =
    new TextEncoder().encode(
      String(value)
    );

  const digest =
    await crypto.subtle.digest(
      'SHA-256',
      bytes
    );

  return [
    ...new Uint8Array(digest)
  ]
    .map(b =>
      b.toString(16).padStart(2, '0')
    )
    .join('');
}

async function handleRedeemActivation(
  request,
  env
) {
  let body = {};

  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const code =
    String(body.p_code || '').trim();

  const bundleId =
    String(
      body.p_bundle_id ?? ''
    ).trim();

  const userKey =
    String(
      body.p_user_key || ''
    ).trim();

  if (!code || !bundleId || !userKey) {
    return json(
      {
        status: 'error',
        message:
          'Missing code, bundle or user key'
      },
      400
    );
  }

  const hash =
    await sha256Hex(code);

  const row =
    await env.DB
      .prepare(
        `SELECT * FROM activation_codes
         WHERE code=? AND bundle_id=?
         LIMIT 1`
      )
      .bind(hash, bundleId)
      .first();

  if (!row) {
    return json({
      status: 'invalid',
      message:
        'Invalid activation code.'
    });
  }

  if (
    String(row.status || '')
      .toLowerCase() !== 'unused'
  ) {
    return json({
      status: 'used',
      message:
        'Activation code has already been used.'
    });
  }

  const now = nowIso();

  let data = {};

  try {
    data = JSON.parse(
      row.data_json || '{}'
    );
  } catch (_) {}

  const entId =
    crypto.randomUUID();

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE activation_codes
         SET status=?,
             redeemed_by=?,
             redeemed_at=?,
             data_json=?
         WHERE id=?`
      )
      .bind(
        'redeemed',
        userKey,
        now,
        JSON.stringify({
          ...data,
          status: 'redeemed',
          redeemed_by: userKey,
          redeemed_at: now
        }),
        row.id
      ),

    env.DB
      .prepare(
        `INSERT OR IGNORE INTO entitlements
         (id,user_key,bundle_id,created_at,data_json)
         VALUES (?,?,?,?,?)`
      )
      .bind(
        entId,
        userKey,
        bundleId,
        now,
        JSON.stringify({
          user_key: userKey,
          bundle_id: bundleId,
          created_at: now,
          activation_id: row.id
        })
      )
  ]);

  return json({
    status: 'success',
    bundle_id: bundleId,
    redeemed_by: userKey,
    redeemed_at: now
  });
}

async function fetchSupabaseJson(
  url,
  key
) {
  const r = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      Accept: 'application/json'
    },
    cf: {
      cacheTtl: 0,
      cacheEverything: false
    }
  });

  const txt =
    await r.text();

  if (!r.ok) {
    throw new Error(
      'Supabase ' +
      r.status +
      ' ' +
      txt.slice(0, 220)
    );
  }

  let data;

  try {
    data = JSON.parse(txt);
  } catch (_) {
    throw new Error(
      'Invalid JSON from Supabase'
    );
  }

  return Array.isArray(data)
    ? data
    : [];
}

async function migrateStoreFromSupabase(
  env,
  table
) {
  if (!TABLES.has(table)) {
    throw new Error(
      'Unsupported table ' + table
    );
  }

  const base =
    String(
      env.SUPABASE_URL || ''
    ).replace(/\/$/, '');

  const key =
    String(
      env.SUPABASE_KEY || ''
    );

  if (!base || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_KEY secrets are not configured.'
    );
  }

  let rows = [];

  if (table === 'bundles') {
    const ids =
      await fetchSupabaseJson(
        base +
          '/rest/v1/bundles?select=id&order=id.asc',
        key
      );

    for (const x of ids) {
      if (x?.id == null) continue;

      const part =
        await fetchSupabaseJson(
          base +
            '/rest/v1/bundles?select=*&id=eq.' +
            encodeURIComponent(
              String(x.id)
            ),
          key
        );

      if (part[0]) {
        rows.push(part[0]);
      }
    }
  } else {
    let offset = 0;
    const page = 500;

    while (true) {
      const part =
        await fetchSupabaseJson(
          base +
            '/rest/v1/' +
            table +
            '?select=*&limit=' +
            page +
            '&offset=' +
            offset,
          key
        );

      rows.push(...part);

      if (part.length < page) break;

      offset += part.length;

      if (offset > 50000) break;
    }
  }

  let written = 0;

  for (
    let i = 0;
    i < rows.length;
    i += 25
  ) {
    const chunk =
      rows.slice(i, i + 25);

    for (const src of chunk) {
      await upsertSourceRow(
        env,
        table,
        src,
        null
      );

      written++;
    }
  }

  return {
    table,
    source_rows: rows.length,
    written
  };
}

async function handleMigration(
  request,
  env,
  url
) {
  if (!adminAllowed(request, env)) {
    return bad('Unauthorized', 401);
  }

  const tables =
    (
      url.searchParams.get('tables') ||
      'subjects,notes,bundles,bundle_tests,banners,content_notifications'
    )
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);

  const out = [];

  for (const table of tables) {
    out.push(
      await migrateStoreFromSupabase(
        env,
        table
      )
    );
  }

  return json({
    success: true,
    results: out
  });
}

async function handleRpc(
  request,
  env,
  fn
) {
  if (
    fn !== 'get_bundle_entitlements'
  ) {
    return bad(
      'RPC not found',
      404
    );
  }

  let body = {};

  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const key =
    String(
      body.p_user_key || ''
    ).trim();

  if (!key) {
    return json([]);
  }

  const rows =
    await env.DB
      .prepare(
        `SELECT bundle_id,
                created_at,
                data_json
         FROM entitlements
         WHERE user_key=?
         ORDER BY created_at DESC`
      )
      .bind(key)
      .all();

  return json(
    (rows.results || []).map(r => {
      let x = {};

      try {
        x = JSON.parse(
          r.data_json || '{}'
        );
      } catch (_) {}

      return Object.assign(
        {
          bundle_id: r.bundle_id,
          created_at: r.created_at
        },
        x
      );
    })
  );
}

async function handleReleaseStorage(
  request,
  env,
  path
) {
  const parts =
    path.split('/').filter(Boolean);

  const isPublic =
    parts[2] === 'public';

  const objectIndex =
    isPublic ? 4 : 3;

  const bucket =
    parts[objectIndex];

  const objectPath =
    parts
      .slice(objectIndex + 1)
      .join('/');

  if (
    bucket !==
    'exam-master-releases'
  ) {
    return bad(
      'Storage bucket not found',
      404
    );
  }

  if (
    request.method === 'GET' &&
    isPublic
  ) {
    const row =
      await env.DB
        .prepare(
          `SELECT data_json
           FROM app_releases
           WHERE release_path=?
              OR release_id=?
           LIMIT 1`
        )
        .bind(
          objectPath,
          objectPath
        )
        .first();

    if (!row) {
      return bad(
        'Release not found',
        404
      );
    }

    let d = {};

    try {
      d = JSON.parse(
        row.data_json || '{}'
      );
    } catch (_) {}

    const html =
      String(
        d.html_content ||
        d.html ||
        ''
      );

    if (!html) {
      return bad(
        'Release content missing',
        404
      );
    }

    return text(
      html,
      200,
      'text/html; charset=utf-8'
    );
  }

  if (
    ['PUT', 'POST'].includes(
      request.method
    )
  ) {
    if (!adminAllowed(request, env)) {
      return bad(
        'Unauthorized',
        401
      );
    }

    const html =
      await request.text();

    const releaseId =
      objectPath
        .split('/')
        .pop()
        ?.replace(
          /\.html$/i,
          ''
        ) ||
      crypto.randomUUID();

    const row = {
      release_id: releaseId,
      release_path: objectPath,
      release_url:
        new URL(
          '/storage/v1/object/public/' +
            bucket +
            '/' +
            objectPath,
          request.url
        ).toString(),
      published_at: nowIso(),
      size_bytes: html.length,
      active: 0,
      html_content: html
    };

    const d =
      sourceRowToD1(
        'app_releases',
        row
      );

    let old =
      await env.DB
        .prepare(
          `SELECT data_json
           FROM app_releases
           WHERE release_id=?`
        )
        .bind(releaseId)
        .first();

    if (old) {
      let prior = {};

      try {
        prior = JSON.parse(
          old.data_json || '{}'
        );
      } catch (_) {}

      d.data_json =
        JSON.stringify({
          ...prior,
          ...row
        });
    }

    const existing =
      !!old;

    const all = [
      'release_id',
      'release_path',
      'release_url',
      'published_at',
      'size_bytes',
      'content_hash',
      'active',
      'data_json'
    ];

    const vals = [
      d.release_id,
      d.release_path,
      d.release_url,
      d.published_at,
      d.size_bytes,
      null,
      0,
      d.data_json
    ];

    if (existing) {
      await env.DB
        .prepare(
          `UPDATE app_releases
           SET release_path=?,
               release_url=?,
               published_at=?,
               size_bytes=?,
               data_json=?
           WHERE release_id=?`
        )
        .bind(
          d.release_path,
          d.release_url,
          d.published_at,
          d.size_bytes,
          d.data_json,
          d.release_id
        )
        .run();
    } else {
      await env.DB
        .prepare(
          `INSERT INTO app_releases
           (${all
             .map(c => '"' + c + '"')
             .join(',')})
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .bind(...vals)
        .run();
    }

    return json({
      Key: objectPath,
      release_id: releaseId
    });
  }

  return bad(
    'Method not allowed',
    405
  );
}

async function handleHealth(env) {
  try {
    const result =
      await env.DB
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type='table'
           ORDER BY name`
        )
        .all();

    return json({
      success: true,
      database: 'connected',
      tables:
        result.results || [],
      api: 'phase2-rest-compat'
    });
  } catch (error) {
    return json(
      {
        success: false,
        error: error.message
      },
      500
    );
  }
}

export default {
  async fetch(request, env) {
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

    const url =
      new URL(request.url);

    const path =
      url.pathname.replace(
        /\/+$/,
        ''
      ) || '/';

    try {
      if (
        path === '/' ||
        path === '/health'
      ) {
        return handleHealth(env);
      }

      if (
        path.startsWith(
          '/rest/v1/rpc/'
        )
      ) {
        const fn =
          path.split('/').pop();

        if (
          fn ===
          'redeem_activation_code'
        ) {
          return handleRedeemActivation(
            request,
            env
          );
        }

        return handleRpc(
          request,
          env,
          fn
        );
      }

      if (
        path ===
        '/api/migrate/supabase'
      ) {
        return handleMigration(
          request,
          env,
          url
        );
      }

      if (
        path.startsWith(
          '/rest/v1/'
        )
      ) {
        return handleRest(
          request,
          env,
          path
            .slice(
              '/rest/v1/'.length
            )
            .split('/')[0],
          url
        );
      }

      if (
        path.startsWith(
          '/storage/v1/object/'
        )
      ) {
        return handleReleaseStorage(
          request,
          env,
          path
        );
      }

      if (
        path === '/api/status'
      ) {
        return json({
          ok: true,
          worker:
            'exammaster-pro-api',
          database: 'D1',
          r2: false
        });
      }

      return bad(
        'Not found',
        404
      );
    } catch (error) {
      console.error(error);

      return json(
        {
          error:
            error.message ||
            String(error)
        },
        500
      );
    }
  }
};
