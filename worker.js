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
  'subjects','notes','bundles','bundle_tests','banners','content_notifications','app_releases'
]);

const ADMIN_READ_TABLES = new Set(['activation_codes','emp_analytics_events','admin_users','cf_users']);

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, Prefer, X-EMP-Admin-Key, X-Client-Role',
    'Access-Control-Max-Age': '86400',
    ...extra
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extra })
  });
}

function text(body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, { status, headers: corsHeaders({ 'Content-Type': contentType }) });
}

function bad(message, status = 400, details = null) {
  return json({ code: status, message, ...(details ? { details } : {}) }, status);
}

function nowIso() { return new Date().toISOString(); }

function cleanIdent(v) {
  const s = String(v || '');
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : null;
}

function decodeFilterValue(raw) {
  let v = String(raw ?? '');
  if (v.startsWith('eq.')) return decodeURIComponent(v.slice(3));
  return decodeURIComponent(v);
}

function parseFilters(url) {
  const filters = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (['select','order','limit','offset','on_conflict','columns','apikey'].includes(key)) continue;
    if (key === 'or' || key === 'and') continue;

    const m = String(value).match(/^(eq|neq|gt|gte|lt|lte|in|is|like|ilike)\.(.*)$/s);
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
        .map(x => x.replace(/^"|"$/g,''));
    } else if (op === 'is') {
      val = val.toLowerCase() === 'null' ? null : val.toLowerCase() === 'true';
    } else {
      try { val = decodeURIComponent(val); } catch (_) {}
    }

    filters.push({ key, op, val });
  }

  return filters;
}

function compareValue(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;

  const na = Number(a), nb = Number(b);

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
        return val === null ? actual == null : Boolean(actual) === Boolean(val);

      case 'like':
        return String(actual ?? '').includes(
          String(val).replace(/%/g, '')
        );

      case 'ilike':
        return String(actual ?? '')
          .toLowerCase()
          .includes(String(val).replace(/%/g, '').toLowerCase());

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
        dir: String(p[1] || 'asc').toLowerCase() === 'desc' ? -1 : 1
      };
    })
    .filter(x => x.field);
}

function sourceRowToD1(table, source) {
  const src =
    (source && typeof source === 'object')
      ? JSON.parse(JSON.stringify(source))
      : {};

  const id = src.id != null ? String(src.id) : crypto.randomUUID();

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
      subject_id: src.subject_id != null ? String(src.subject_id) : null,
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
      bundle_id: src.bundle_id != null ? String(src.bundle_id) : '',
      bundle_subject_id:
        src.bundle_subject_id != null
          ? String(src.bundle_subject_id)
          : null,

      bundle_subject_name: src.bundle_subject_name ?? null,
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
      release_id: String(src.release_id ?? id),
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
      'id','name','description','icon','color',
      'created_at','updated_at','data_json'
    ],

    notes: [
      'id','subject_id','title','content',
      'file_data','file_name','file_type',
      'created_at','updated_at','data_json'
    ],

    bundles: [
      'id','name','description','updated_at','data_json'
    ],

    bundle_tests: [
      'id','bundle_id','bundle_subject_id',
      'bundle_subject_name','name','description',
      'level','difficulty','time_limit','html_content',
      'is_paid','access_type','access_mode',
      'access_override','price','total_questions',
      'updated_at','deleted_at','data_json'
    ],

    banners: [
      'id','title','description','price','image',
      'qrData','link_type','link','bundle_id',
      'subject_id','test_id','slide_seconds',
      'updated_at','data_json'
    ],

    activation_codes: [
      'id','code','bundle_id','amount','status',
      'redeemed_by','redeemed_at','created_at','data_json'
    ],

    entitlements: [
      'id','user_key','bundle_id','created_at','data_json'
    ],

    emp_test_submissions: [
      'id','attempt_id','user_id','username',
      'test_id','bundle_id','subject_id',
      'test_name','score','total_marks','accuracy',
      'percentile','status','completed_at',
      'created_at','data_json'
    ],

    emp_analytics_events: [
      'id','user_id','username','event_type',
      'occurred_at','data_json'
    ],

    content_notifications: [
      'id','title','description','content_type',
      'content_id','created_at','data_json'
    ],

    admin_users: [
      'id','user_id','email','created_at','data_json'
    ],

    app_releases: [
      'id','release_id','release_path','release_url',
      'published_at','size_bytes','content_hash',
      'active','data_json'
    ],

    cf_users: [
      'id','email','password_hash','role',
      'created_at','data_json'
    ]
  };

  return map[table] || ['id','data_json'];
}

function adminAllowed(request, env) {
  const configured = String(env.ADMIN_API_KEY || '').trim();

  if (!configured) {
    return true;
  }

  const supplied =
    request.headers.get('X-EMP-Admin-Key') ||
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i,'') ||
    '';

  return supplied === configured;
}

async function upsertSourceRow(env, table, source, forcedId = null) {
  if (!TABLES.has(table)) {
    throw new Error('Unsupported table ' + table);
  }

  const src =
    source && typeof source === 'object'
      ? JSON.parse(JSON.stringify(source))
      : {};

  if (forcedId != null) {
    src.id = forcedId;
  }

  const d = sourceRowToD1(table, src);

  const cols = tableColumns(table);

  const values = cols.map(col => {
    if (col === 'data_json') return d.data_json;
    return d[col] ?? null;
  });

  const quotedCols = cols
    .map(c => '"' + c + '"')
    .join(',');

  const placeholders = cols
    .map(() => '?')
    .join(',');

  const updateCols = cols
    .filter(c => c !== 'id')
    .map(c => `"${c}"=excluded."${c}"`)
    .join(',');

  const sql = `
    INSERT INTO "${table}" (${quotedCols})
    VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET
    ${updateCols}
  `;

  await env.DB
    .prepare(sql)
    .bind(...values)
    .run();

  return d.id;
}

async function handleRest(request, env, table, url) {
  if (!TABLES.has(table)) {
    return bad('Table not found: ' + table,404);
  }

  const filters = parseFilters(url);
  const select = parseSelect(url.searchParams.get('select'));
  const order = parseOrder(url.searchParams.get('order'));

  if (request.method === 'GET') {
    let rows = [];

    const result = await env.DB
      .prepare(`SELECT * FROM "${table}"`)
      .all();

    rows = (result.results || [])
      .map(d1RowToSource)
      .filter(row => rowMatches(row,filters));

    if (order.length) {
      rows.sort((a,b) => {
        for (const o of order) {
          const c = compareValue(a[o.field],b[o.field]);

          if (c !== 0) return c * o.dir;
        }

        return 0;
      });
    }

    const offset = Math.max(
      0,
      Number(url.searchParams.get('offset') || 0)
    );

    const limitRaw = url.searchParams.get('limit');

    if (limitRaw != null) {
      const limit = Math.max(
        0,
        Number(limitRaw)
      );

      rows = rows.slice(offset,offset + limit);
    } else if (offset) {
      rows = rows.slice(offset);
    }

    rows = rows.map(row => applySelect(row,select));

    return json(rows);
  }

  if (
    ['POST','PUT','PATCH'].includes(request.method)
  ) {
    if (
      !PUBLIC_TABLES.has(table) &&
      !['emp_test_submissions','emp_analytics_events','entitlements'].includes(table)
    ) {
      if (!adminAllowed(request,env)) {
        return bad('Unauthorized',401);
      }
    }

    let body;

    try {
      body = await request.json();
    } catch (_) {
      return bad('Invalid JSON body');
    }

    const rows = Array.isArray(body) ? body : [body];

    let output = [];

    for (const row of rows) {
      const id = await upsertSourceRow(env,table,row,null);

      const stored = await env.DB
        .prepare(`SELECT * FROM "${table}" WHERE id=?`)
        .bind(id)
        .first();

      if (stored) {
        output.push(d1RowToSource(stored));
      }
    }

    return json(output,201);
  }

  if (request.method === 'DELETE') {
    if (!adminAllowed(request,env)) {
      return bad('Unauthorized',401);
    }

    const ids = filters
      .filter(x => x.op === 'eq' && x.key === 'id')
      .map(x => String(x.val));

    if (!ids.length) {
      return bad('Delete requires id=eq.<id>',400);
    }

    for (const id of ids) {
      await env.DB
        .prepare(`DELETE FROM "${table}" WHERE id=?`)
        .bind(id)
        .run();
    }

    return json([]);
  }

  return bad('Method not allowed',405);
}

async function handleRedeemActivation(request, env) {
  if (request.method !== 'POST') {
    return bad('Method not allowed',405);
  }

  let body = {};

  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const code = String(
    body.p_code ||
    body.code ||
    ''
  ).trim();

  const userKey = String(
    body.p_user_key ||
    body.user_key ||
    ''
  ).trim();

  if (!code || !userKey) {
    return bad('Activation code and user key are required');
  }

  const row = await env.DB
    .prepare(
      'SELECT * FROM activation_codes WHERE code=? LIMIT 1'
    )
    .bind(code)
    .first();

  if (!row) {
    return bad('Invalid activation code',404);
  }

  if (String(row.status || '').toLowerCase() === 'redeemed') {
    return bad('Activation code already redeemed',409);
  }

  const bundleId = row.bundle_id;

  if (!bundleId) {
    return bad('Activation code has no bundle',400);
  }

  const now = nowIso();

  await env.DB.batch([
    env.DB
      .prepare(
        'UPDATE activation_codes SET status=?, redeemed_by=?, redeemed_at=?, data_json=? WHERE id=?'
      )
      .bind(
        'redeemed',
        userKey,
        now,
        JSON.stringify({
          code,
          bundle_id: bundleId,
          status: 'redeemed',
          redeemed_by: userKey,
          redeemed_at: now
        }),
        row.id
      ),

    env.DB
      .prepare(
        'INSERT OR IGNORE INTO entitlements (id,user_key,bundle_id,created_at,data_json) VALUES (?,?,?,?,?)'
      )
      .bind(
        crypto.randomUUID(),
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
    status:'success',
    bundle_id:bundleId,
    redeemed_by:userKey,
    redeemed_at:now
  });
}

async function fetchSupabaseJson(url,key) {
  const r = await fetch(url,{
    headers:{
      apikey:key,
      Authorization:'Bearer '+key,
      Accept:'application/json'
    },
    cf:{
      cacheTtl:0,
      cacheEverything:false
    }
  });

  const txt = await r.text();

  if (!r.ok) {
    throw new Error(
      'Supabase '+r.status+' '+txt.slice(0,220)
    );
  }

  let data;

  try {
    data = JSON.parse(txt);
  } catch (_) {
    throw new Error('Invalid JSON from Supabase');
  }

  return Array.isArray(data) ? data : [];
}

async function migrateStoreFromSupabase(env,table) {
  if (!TABLES.has(table)) {
    throw new Error('Unsupported table '+table);
  }

  const base = String(
    env.SUPABASE_URL || ''
  ).replace(/\/$/,'');

  const key = String(
    env.SUPABASE_KEY || ''
  );

  if (!base || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_KEY secrets are not configured.'
    );
  }

  let rows = [];

  if (table === 'bundles') {
    const ids = await fetchSupabaseJson(
      base+'/rest/v1/bundles?select=id&order=id.asc',
      key
    );

    for (const x of ids) {
      if (x?.id == null) continue;

      const part = await fetchSupabaseJson(
        base+
        '/rest/v1/bundles?select=*&id=eq.'+
        encodeURIComponent(String(x.id)),
        key
      );

      if (part[0]) {
        rows.push(part[0]);
      }
    }
  }

  else {
    let offset = 0;
    const page = 500;

    while (true) {
      const part = await fetchSupabaseJson(
        base+
        '/rest/v1/'+table+
        '?select=*&limit='+page+
        '&offset='+offset,
        key
      );

      rows.push(...part);

      if (part.length < page) break;

      offset += part.length;

      if (offset > 50000) break;
    }
  }

  let written = 0;

  for (let i=0;i<rows.length;i+=25) {
    const chunk = rows.slice(i,i+25);

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
    source_rows:rows.length,
    written
  };
}

async function importRowsToD1(env,table,rows) {
  if (!TABLES.has(table)) {
    throw new Error(
      'Unsupported table '+table
    );
  }

  if (!Array.isArray(rows)) {
    throw new Error(
      'rows must be an array'
    );
  }

  let written = 0;

  for (let i=0;i<rows.length;i+=20) {
    const chunk = rows.slice(i,i+20);

    /*
      Keep batches deliberately small.
      This is especially important for bundle_tests
      because html_content can make individual rows large.
    */

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

  return written;
}

async function handleJsonImport(request,env) {
  if (request.method !== 'POST') {
    return bad(
      'Method not allowed',
      405
    );
  }

  if (!adminAllowed(request,env)) {
    return bad(
      'Unauthorized',
      401
    );
  }

  let body;

  try {
    body = await request.json();
  } catch (_) {
    return bad(
      'Invalid JSON body'
    );
  }

  const table = String(
    body?.table || ''
  ).trim();

  const rows =
    Array.isArray(body?.rows)
      ? body.rows
      : [];

  if (!table) {
    return bad(
      'Missing table'
    );
  }

  if (!TABLES.has(table)) {
    return bad(
      'Unsupported table: '+table
    );
  }

  let written = 0;
  let bundleTestsWritten = 0;

  /*
    BUNDLES

    The JSON backup stores tests nested inside:

    bundle
      -> subjects
        -> tests

    D1 keeps the authoritative test copy in:

    bundle_tests
  */

  if (table === 'bundles') {

    for (let i=0;i<rows.length;i+=10) {

      const chunk = rows.slice(i,i+10);

      for (const bundle of chunk) {

        await upsertSourceRow(
          env,
          'bundles',
          bundle,
          null
        );

        written++;

        const subjects =
          Array.isArray(bundle?.subjects)
            ? bundle.subjects
            : [];

        for (const sub of subjects) {

          const tests =
            Array.isArray(sub?.tests)
              ? sub.tests
              : [];

          const testRows = tests
            .map(test => ({
              ...test,

              id:test?.id,

              subject_id:
                test?.subject_id ??
                sub?.id ??
                null,

              bundle_id:
                test?.bundle_id ??
                bundle?.id ??
                null,

              bundle_subject_id:
                test?.bundle_subject_id ??
                sub?.id ??
                null,

              bundle_subject_name:
                test?.bundle_subject_name ??
                sub?.name ??
                null,

              updated_at:
                test?.updated_at ??
                bundle?.updated_at ??
                nowIso(),

              deleted_at:
                test?.deleted_at ??
                null
            }))

            .filter(t =>
              t.id != null &&
              t.bundle_id != null &&
              t.bundle_subject_id != null &&
              t.name != null
            );

          bundleTestsWritten +=
            await importRowsToD1(
              env,
              'bundle_tests',
              testRows
            );
        }
      }
    }
  }

  /*
    TESTS

    Local IndexedDB uses "tests".

    Cloudflare/D1 uses bundle_tests
    as the authoritative bundle-scoped test table.
  */

  else if (table === 'tests') {

    const testRows = rows
      .map(test => ({
        ...test,

        bundle_id:
          test?.bundle_id ??
          null,

        bundle_subject_id:
          test?.bundle_subject_id ??
          null
      }))

      .filter(t =>
        t.id != null &&
        t.bundle_id != null &&
        t.bundle_subject_id != null &&
        t.name != null
      );

    bundleTestsWritten =
      await importRowsToD1(
        env,
        'bundle_tests',
        testRows
      );
  }

  else {

    written =
      await importRowsToD1(
        env,
        table,
        rows
      );
  }

  return json({
    success:true,
    table,
    received:rows.length,
    written,
    bundle_tests_written:bundleTestsWritten
  });
}

async function handleMigration(request,env,url) {

  if (!adminAllowed(request,env)) {
    return bad(
      'Unauthorized',
      401
    );
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
    success:true,
    results:out
  });
}

async function handleRpc(request,env,fn) {

  if (fn !== 'get_bundle_entitlements') {
    return bad(
      'RPC not found',
      404
    );
  }

  let body = {};

  try {
    body = await request.json();
  } catch (_) {
    return bad(
      'Invalid JSON body'
    );
  }

  const key = String(
    body.p_user_key || ''
  ).trim();

  if (!key) {
    return json([]);
  }

  const rows =
    await env.DB
      .prepare(
        'SELECT bundle_id, created_at, data_json FROM entitlements WHERE user_key=? ORDER BY created_at DESC'
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
          bundle_id:r.bundle_id,
          created_at:r.created_at
        },
        x
      );
    })
  );
}

async function handleReleaseStorage(request,env,path) {

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

  if (bucket !== 'exam-master-releases') {
    return bad(
      'Storage bucket not found',
      404
    );
  }

  /*
    Public release download
  */

  if (
    request.method === 'GET' &&
    isPublic
  ) {

    const row =
      await env.DB
        .prepare(
          'SELECT data_json FROM app_releases WHERE release_path=? OR release_id=? LIMIT 1'
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

  /*
    Release upload
  */

  if (
    ['PUT','POST'].includes(
      request.method
    )
  ) {

    if (!adminAllowed(request,env)) {
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
        ?.replace(/\.html$/i,'') ||
      crypto.randomUUID();

    const row = {
      release_id:releaseId,
      release_path:objectPath,

      release_url:
        new URL(
          '/storage/v1/object/public/' +
          bucket +
          '/' +
          objectPath,
          request.url
        ).toString(),

      published_at:nowIso(),
      size_bytes:html.length,
      active:0,
      html_content:html
    };

    const d =
      sourceRowToD1(
        'app_releases',
        row
      );

    const old =
      await env.DB
        .prepare(
          'SELECT data_json FROM app_releases WHERE release_id=?'
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

    const existing = !!old;

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
          'UPDATE app_releases SET release_path=?,release_url=?,published_at=?,size_bytes=?,data_json=? WHERE release_id=?'
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
          `
          INSERT INTO app_releases
          (${all.map(c => '"' + c + '"').join(',')})
          VALUES (?,?,?,?,?,?,?,?)
          `
        )
        .bind(...vals)
        .run();
    }

    return json({
      Key:objectPath,
      release_id:releaseId
    },200);
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
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all();

    return json({
      success:true,
      database:'connected',
      tables:result.results || [],
      api:'phase2-rest-compat'
    });

  } catch (error) {

    return json({
      success:false,
      error:error.message
    },500);
  }
}

export default {

  async fetch(request,env) {

    if (request.method === 'OPTIONS') {

      return new Response(
        null,
        {
          status:204,
          headers:corsHeaders()
        }
      );
    }

    const url =
      new URL(request.url);

    const path =
      url.pathname.replace(/\/+$/,'') || '/';

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

      /*
        NEW:
        JSON backup -> D1 import endpoint
      */

      if (
        path ===
        '/api/import/json'
      ) {
        return handleJsonImport(
          request,
          env
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
            .slice('/rest/v1/'.length)
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
        path ===
        '/api/status'
      ) {

        return json({
          ok:true,
          worker:'exammaster-pro-api',
          database:'D1',
          r2:false
        });
      }

      return bad(
        'Not found',
        404
      );

    } catch (error) {

      console.error(error);

      return json({
        error:
          error.message ||
          String(error)
      },500);
    }
  }
};
