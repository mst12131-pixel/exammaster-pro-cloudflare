/*
 * ExamMaster Pro - Cloudflare Worker / D1
 * ACCESS + PUBLISH SYNC FIX
 *
 * Fixes:
 * 1. bundle_tests access state is authoritative and cannot be turned FREE by
 *    a stale data_json snapshot.
 * 2. FREE / PAID / price / access_mode / access_type / access_override / is_paid
 *    are kept synchronized with data_json.
 * 3. Access-only test updates never erase existing html_content.
 * 4. Public Test Mode can read published metadata, while admin writes remain
 *    protected when ADMIN_API_KEY is configured.
 * 5. Includes the REST compatibility layer used by the ExamMaster HTML app.
 * 6. Includes activation entitlement RPCs, analytics and ranking endpoints.
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, Prefer, X-EMP-Admin-Key, X-Client-Role',
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
  try { return decodeURIComponent(String(raw ?? '')); }
  catch (_) { return String(raw ?? ''); }
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
    ) continue;

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

    filters.push({
      key,
      op,
      val
    });
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

  if (
    Number.isFinite(da) &&
    Number.isFinite(db)
  ) {
    return da - db;
  }

  return String(a).localeCompare(
    String(b),
    undefined,
    {
      numeric: true,
      sensitivity: 'base'
    }
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
          val.some(
            x =>
              String(actual ?? '') === String(x)
          );

      case 'is':
        return val === null
          ? actual == null
          : Boolean(actual) === Boolean(val);

      case 'like':
        return String(actual ?? '')
          .includes(
            String(val).replace(/%/g, '')
          );

      case 'ilike':
        return String(actual ?? '')
          .toLowerCase()
          .includes(
            String(val)
              .replace(/%/g, '')
              .toLowerCase()
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
  const s =
    source && typeof source === 'object'
      ? source
      : {};

  const values = [
    s.access_mode,
    s.access_override,
    s.access_type
  ].map(v =>
    String(v ?? '').toLowerCase()
  );

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
  const s =
    source && typeof source === 'object'
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
        ? Math.max(
            0,
            Number(s.price || 0) || 0
          )
        : 0
  };
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

  } else if (table === 'notes') {
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

  } else if (table === 'bundles') {
    Object.assign(common, {
      name: src.name ?? 'Untitled Bundle',
      description: src.description ?? null,
      updated_at: src.updated_at ?? nowIso()
    });

  } else if (table === 'bundle_tests') {
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

  } else if (table === 'banners') {
    Object.assign(common, {
      title:
        src.title ?? null,

      description:
        src.description ?? null,

      price:
        src.price ?? null,

      image:
        src.image ?? null,

      qrData:
        src.qrData ?? null,

      link_type:
        src.link_type ?? null,

      link:
        src.link ?? null,

      bundle_id:
        src.bundle_id == null ||
        src.bundle_id === ''
          ? null
          : String(src.bundle_id),

      subject_id:
        src.subject_id ?? null,

      test_id:
        src.test_id ?? null,

      slide_seconds:
        src.slide_seconds ?? null,

      updated_at:
        src.updated_at ?? nowIso()
    });

  } else if (table === 'activation_codes') {
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

  } else if (table === 'entitlements') {
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

  } else if (table === 'emp_test_submissions') {
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

      bundle_id:
        src.bundle_id != null
          ? String(src.bundle_id)
          : null,

      subject_id:
        src.subject_id != null
          ? String(src.subject_id)
          : null,

      test_name:
        src.test_name ?? null,

      score:
        src.score ?? null,

      total_marks:
        src.total_marks ?? null,

      accuracy:
        src.accuracy ?? null,

      percentile:
        src.percentile ?? null,

      status:
        src.status ?? null,

      completed_at:
        src.completed_at ?? null,

      created_at:
        src.created_at ?? nowIso()
    });

  } else if (table === 'emp_analytics_events') {
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
        src.occurred_at ?? nowIso()
    });

  } else if (table === 'content_notifications') {
    Object.assign(common, {
      title:
        src.title ?? null,

      description:
        src.description ?? null,

      content_type:
        src.content_type ?? null,

      content_id:
        src.content_id == null
          ? null
          : String(src.content_id),

      created_at:
        src.created_at ?? nowIso()
    });

  } else if (table === 'admin_users') {
    Object.assign(common, {
      user_id:
        String(src.user_id ?? id),

      email:
        src.email ?? null,

      created_at:
        src.created_at ?? nowIso()
    });

  } else if (table === 'app_releases') {
    Object.assign(common, {
      release_id:
        String(src.release_id ?? id),

      release_path:
        src.release_path ?? null,

      release_url:
        src.release_url ?? null,

      published_at:
        src.published_at ?? nowIso(),

      size_bytes:
        src.size_bytes ?? null,

      content_hash:
        src.content_hash ?? null,

      active:
        src.active ? 1 : 0
    });

  } else if (table === 'cf_users') {
    Object.assign(common, {
      email:
        src.email ?? null,

      password_hash:
        src.password_hash ?? null,

      role:
        src.role ?? 'user',

      created_at:
        src.created_at ?? nowIso()
    });
  }

  return common;
}

function d1RowToSource(row) {
  let data = {};

  try {
    data =
      JSON.parse(
        row.data_json || '{}'
      );
  } catch (_) {}

  const base = {
    ...row
  };

  delete base.data_json;

  const out = {
    ...data,
    ...base
  };

  if (
    String(row.bundle_id ?? '') !== '' &&
    Object.prototype.hasOwnProperty.call(
      out,
      'name'
    )
  ) {
    const mergedAccess =
      normalizeTestAccess({
        ...data,
        ...row
      });

    out.access_mode =
      mergedAccess.access_mode;

    out.access_override =
      mergedAccess.access_override;

    out.access_type =
      mergedAccess.access_type;

    out.is_paid =
      mergedAccess.is_paid;

    out.price =
      mergedAccess.price;
  }

  return out;
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
      value: String(
        src.user_id ?? src.id
      )
    };
  }

  if (table === 'app_releases') {
    return {
      field: 'release_id',
      value: String(
        src.release_id ?? src.id
      )
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
    request.headers.get(
      'X-EMP-Admin-Key'
    ) ||
    request.headers
      .get('Authorization')
      ?.replace(
        /^Bearer\s+/i,
        ''
      );

  return supplied === env.ADMIN_API_KEY;
}

async function readTable(
  env,
  table,
  url,
  options = {}
) {
  const cols =
    tableColumns(table);

  if (!cols.length) {
    throw new Error(
      'Unsupported table: ' + table
    );
  }

  const rows =
    await env.DB
      .prepare(
        `SELECT ${cols
          .map(
            c => '"' + c + '"'
          )
          .join(',')}
         FROM "${table}"`
      )
      .all();

  let out =
    (rows.results || [])
      .map(d1RowToSource);

  const filters =
    parseFilters(url);

  out =
    out.filter(
      r =>
        rowMatches(
          r,
          filters
        )
    );

  if (
    table === 'bundle_tests' &&
    !options.includeDeleted &&
    !url.searchParams.has(
      'deleted_at'
    )
  ) {
    out =
      out.filter(
        r =>
          !String(
            r.deleted_at || ''
          ).trim()
      );
  }

  const orders =
    parseOrder(
      url.searchParams.get(
        'order'
      )
    );

  for (
    let i = orders.length - 1;
    i >= 0;
    i--
  ) {
    const o = orders[i];

    out.sort(
      (a, b) =>
        o.dir *
        compareValue(
          a[o.field],
          b[o.field]
        )
    );
  }

  const offset =
    Math.max(
      0,
      Number(
        url.searchParams.get(
          'offset'
        ) || 0
      ) || 0
    );

  const limitRaw =
    url.searchParams.get(
      'limit'
    );

  if (limitRaw != null) {
    out =
      out.slice(
        offset,
        offset +
          Math.max(
            0,
            Number(limitRaw) || 0
          )
      );
  } else if (offset) {
    out =
      out.slice(offset);
  }

  return out.map(
    r =>
      applySelect(
        r,
        parseSelect(
          url.searchParams.get(
            'select'
          )
        )
      )
  );
}

async function upsertSourceRow(
  env,
  table,
  src,
  conflict
) {
  const key =
    uniqueKey(
      table,
      src,
      conflict
    );

  const existingRow =
    await env.DB
      .prepare(
        `SELECT *
         FROM "${table}"
         WHERE "${key.field}" = ?
         LIMIT 1`
      )
      .bind(key.value)
      .first();

  let mergedSrc =
    src &&
    typeof src === 'object'
      ? JSON.parse(
          JSON.stringify(src)
        )
      : {};

  if (
    table === 'bundle_tests' &&
    existingRow &&
    !String(
      mergedSrc.html_content || ''
    ).trim()
  ) {
    if (
      String(
        existingRow.html_content ||
          ''
      ).trim()
    ) {
      mergedSrc.html_content =
        existingRow.html_content;
    } else {
      try {
        const oldData =
          JSON.parse(
            existingRow.data_json ||
              '{}'
          );

        if (
          String(
            oldData.html_content ||
              ''
          ).trim()
        ) {
          mergedSrc.html_content =
            oldData.html_content;
        }
      } catch (_) {}
    }
  }

  if (
    table === 'bundle_tests' &&
    existingRow
  ) {
    const old =
      d1RowToSource(
        existingRow
      );

    for (
      const k of [
        'access_mode',
        'access_override',
        'access_type',
        'is_paid',
        'price'
      ]
    ) {
      if (
        mergedSrc[k] == null ||
        mergedSrc[k] === ''
      ) {
        mergedSrc[k] =
          old[k];
      }
    }
  }

  const d =
    sourceRowToD1(
      table,
      mergedSrc
    );

  const cols =
    tableColumns(
      table
    ).filter(
      c =>
        c !==
        'data_json'
    );

  const values =
    cols.map(
      c =>
        d[c] ?? null
    );

  if (existingRow) {
    const updateCols =
      cols.filter(
        c =>
          c !==
          key.field
      );

    const setParts =
      updateCols.map(
        c =>
          `"${c}" = ?`
      );

    setParts.push(
      '"data_json" = ?'
    );

    const updateValues = [
      ...updateCols.map(
        c =>
          d[c] ?? null
      ),
      d.data_json
    ];

    await env.DB
      .prepare(
        `UPDATE "${table}"
         SET ${setParts.join(', ')}
         WHERE "${key.field}" = ?`
      )
      .bind(
        ...updateValues,
        key.value
      )
      .run();

  } else {
    const allCols = [
      ...cols,
      'data_json'
    ];

    const placeholders =
      allCols
        .map(() => '?')
        .join(', ');

    await env.DB
      .prepare(
        `INSERT INTO "${table}"
         (${allCols
           .map(
             c =>
               '"' +
               c +
               '"'
           )
           .join(', ')})
         VALUES (${placeholders})`
      )
      .bind(
        ...values,
        d.data_json
      )
      .run();
  }

  return d;
}

async function deleteByFilters(
  env,
  table,
  url
) {
  const rows =
    await readTable(
      env,
      table,
      url,
      {
        includeDeleted:
          true
      }
    );

  let n = 0;

  for (
    const row of rows
  ) {
    const key =
      table === 'admin_users'
        ? 'user_id'
        : table === 'app_releases'
          ? 'release_id'
          : 'id';

    if (
      row[key] == null
    ) {
      continue;
    }

    const r =
      await env.DB
        .prepare(
          `DELETE FROM "${table}"
           WHERE "${key}" = ?`
        )
        .bind(
          String(row[key])
        )
        .run();

    n += Number(
      r.meta?.changes || 0
    );
  }

  return n;
}

async function handleRest(
  request,
  env,
  table,
  url
) {
  if (
    !TABLES.has(table)
  ) {
    return bad(
      'Table not found: ' +
        table,
      404
    );
  }

  const method =
    request.method;

  const isWrite =
    [
      'POST',
      'PATCH',
      'PUT',
      'DELETE'
    ].includes(method);

  if (
    isWrite &&
    !adminAllowed(
      request,
      env
    ) &&
    ![
      'emp_test_submissions',
      'emp_analytics_events',
      'entitlements'
    ].includes(table)
  ) {
    return bad(
      'Unauthorized',
      401
    );
  }

  if (method === 'GET') {
    if (
      ADMIN_READ_TABLES.has(
        table
      ) &&
      !adminAllowed(
        request,
        env
      )
    ) {
      return bad(
        'Unauthorized',
        401
      );
    }

    return json(
      await readTable(
        env,
        table,
        url
      )
    );
  }

  if (
    method === 'POST' ||
    method === 'PUT'
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

    const rows =
      Array.isArray(body)
        ? body
        : [body];

    const conflict =
      url.searchParams.get(
        'on_conflict'
      ) || null;

    const out = [];

    for (
      const src of rows
    ) {
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
        request.headers.get(
          'Prefer'
        ) || ''
      ).toLowerCase();

    if (
      prefer.includes(
        'return=minimal'
      )
    ) {
      return new Response(
        null,
        {
          status: 201,
          headers:
            corsHeaders()
        }
      );
    }

    return json(
      out.map(
        d1RowToSource
      ),
      201
    );
  }

  if (
    method === 'PATCH'
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

    const rows =
      await readTable(
        env,
        table,
        url,
        {
          includeDeleted:
            true
        }
      );

    if (!rows.length) {
      return json([]);
    }

    const out = [];

    for (
      const row of rows
    ) {
      out.push(
        await upsertSourceRow(
          env,
          table,
          {
            ...row,
            ...body
          },
          null
        )
      );
    }

    const prefer =
      (
        request.headers.get(
          'Prefer'
        ) || ''
      ).toLowerCase();

    if (
      prefer.includes(
        'return=minimal'
      )
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

    return json(
      out.map(
        d1RowToSource
      )
    );
  }

  if (
    method === 'DELETE'
  ) {
    if (
      !adminAllowed(
        request,
        env
      )
    ) {
      return bad(
        'Unauthorized',
        401
      );
    }

    const count =
      await deleteByFilters(
        env,
        table,
        url
      );

    return new Response(
      null,
      {
        status: 204,
        headers:
          corsHeaders({
            'X-Deleted-Rows':
              String(count)
          })
      }
    );
  }

  return bad(
    'Method not allowed',
    405
  );
}

async function sha256Hex(
  value
) {
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
    ...new Uint8Array(
      digest
    )
  ]
    .map(
      b =>
        b
          .toString(16)
          .padStart(2, '0')
    )
    .join('');
}

async function handleRedeemActivation(
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

  const code =
    String(
      body.p_code || ''
    ).trim();

  const bundleId =
    String(
      body.p_bundle_id ?? ''
    ).trim();

  const userKey =
    String(
      body.p_user_key || ''
    ).trim();

  if (
    !code ||
    !bundleId ||
    !userKey
  ) {
    return bad(
      'p_code, p_bundle_id and p_user_key are required',
      400
    );
  }

  const codeHash =
    await sha256Hex(
      code
    );

  let codeRow =
    await env.DB
      .prepare(
        `SELECT *
         FROM "activation_codes"
         WHERE "code" = ?
         LIMIT 1`
      )
      .bind(codeHash)
      .first();

  if (!codeRow) {
    codeRow =
      await env.DB
        .prepare(
          `SELECT *
           FROM "activation_codes"
           WHERE "code" = ?
           LIMIT 1`
        )
        .bind(code)
        .first();
  }

  if (!codeRow) {
    return json({
      status: 'invalid'
    });
  }

  const activation =
    d1RowToSource(
      codeRow
    );

  if (
    String(
      activation.bundle_id
    ) !== bundleId
  ) {
    return json({
      status:
        'wrong_bundle',
      bundle_id:
        String(
          activation.bundle_id ||
            ''
        )
    });
  }

  const status =
    String(
      activation.status ||
        ''
    ).toLowerCase();

  if (
    status === 'used' ||
    activation.redeemed_by
  ) {
    return json({
      status: 'used',
      bundle_id:
        bundleId
    });
  }

  const existing =
    await env.DB
      .prepare(
        `SELECT 1
         FROM "entitlements"
         WHERE "user_key" = ?
           AND "bundle_id" = ?
         LIMIT 1`
      )
      .bind(
        userKey,
        bundleId
      )
      .first();

  if (existing) {
    return json({
      status:
        'already_owned',
      bundle_id:
        bundleId
    });
  }

  const now =
    nowIso();

  const updatedActivation = {
    ...activation,
    status: 'used',
    redeemed_by:
      userKey,
    redeemed_at:
      now
  };

  const updateResult =
    await env.DB
      .prepare(
        `UPDATE "activation_codes"
         SET "status" = ?,
             "redeemed_by" = ?,
             "redeemed_at" = ?,
             "data_json" = ?
         WHERE "id" = ?
           AND (
             "status" IS NULL
             OR LOWER("status") != 'used'
           )
           AND (
             "redeemed_by" IS NULL
             OR TRIM("redeemed_by") = ''
           )`
      )
      .bind(
        'used',
        userKey,
        now,
        JSON.stringify(
          updatedActivation
        ),
        String(
          codeRow.id
        )
      )
      .run();

  const changed =
    Number(
      updateResult.meta
        ?.changes || 0
    );

  if (
    changed !== 1
  ) {
    const reread =
      await env.DB
        .prepare(
          `SELECT *
           FROM "activation_codes"
           WHERE "id" = ?
           LIMIT 1`
        )
        .bind(
          String(
            codeRow.id
          )
        )
        .first();

    const latest =
      reread
        ? d1RowToSource(
            reread
          )
        : null;

    if (
      latest &&
      latest.redeemed_by &&
      String(
        latest.redeemed_by
      ) !== userKey
    ) {
      return json({
        status: 'used',
        bundle_id:
          bundleId
      });
    }
  }

  const ent = {
    id:
      crypto.randomUUID(),
    user_key:
      userKey,
    bundle_id:
      bundleId,
    created_at:
      now
  };

  try {
    await upsertSourceRow(
      env,
      'entitlements',
      ent,
      null
    );
  } catch (e) {
    return bad(
      'Code marked used but entitlement could not be created: ' +
        String(
          e?.message || e
        ),
      500
    );
  }

  return json({
    status:
      'success',
    bundle_id:
      bundleId,
    user_key:
      userKey
  });
}

async function handleGetBundleEntitlements(
  request,
  env
) {
  let body = {};

  try {
    body =
      await request.json();
  } catch (_) {}

  const userKey =
    String(
      body.p_user_key ||
      body.user_key ||
      ''
    ).trim();

  if (!userKey) {
    return json([]);
  }

  const rows =
    await env.DB
      .prepare(
        `SELECT *
         FROM "entitlements"
         WHERE "user_key" = ?
         ORDER BY "created_at" DESC`
      )
      .bind(
        userKey
      )
      .all();

  return json(
    (rows.results || [])
      .map(
        d1RowToSource
      )
  );
}

async function handleImportJson(
  request,
  env
) {
  if (
    !adminAllowed(
      request,
      env
    )
  ) {
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

  const table =
    String(
      body.table || ''
    ).trim();

  const rows =
    Array.isArray(
      body.rows
    )
      ? body.rows
      : [];

  if (
    !table ||
    !rows.length
  ) {
    return json({
      received:
        rows.length,
      written: 0,
      bundle_tests_written: 0
    });
  }

  let target =
    table;

  if (
    target === 'tests'
  ) {
    target =
      'bundle_tests';
  }

  if (
    !TABLES.has(
      target
    )
  ) {
    return bad(
      'Unsupported import table: ' +
        target,
      400
    );
  }

  let written = 0;

  for (
    const row of rows
  ) {
    await upsertSourceRow(
      env,
      target,
      row,
      null
    );

    written++;
  }

  return json({
    received:
      rows.length,
    written,
    bundle_tests_written:
      target ===
      'bundle_tests'
        ? written
        : 0
  });
}

async function handleBundleLikeCounts(
  request,
  env,
  url
) {
  const raw =
    String(
      url.searchParams.get(
        'bundle_ids'
      ) ||
      url.searchParams.get(
        'bundle_id'
      ) ||
      ''
    ).trim();

  const ids = [
    ...new Set(
      raw
        .split(',')
        .map(
          x =>
            String(
              x
            ).trim()
        )
        .filter(Boolean)
    )
  ].slice(0, 200);

  if (!ids.length) {
    return json({
      success:
        true,
      counts: {}
    });
  }

  const placeholders =
    ids
      .map(
        () => '?'
      )
      .join(',');

  let rows = [];

  try {
    const q = `
      SELECT
        json_extract(
          data_json,
          '$.bundle_id'
        ) AS bundle_id,
        COUNT(
          DISTINCT user_id
        ) AS like_count
      FROM "emp_analytics_events"
      WHERE event_type = 'bundle_like'
        AND json_extract(
          data_json,
          '$.bundle_id'
        ) IN (${placeholders})
      GROUP BY
        json_extract(
          data_json,
          '$.bundle_id'
        )
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

  for (
    const id of ids
  ) {
    counts[id] =
      0;
  }

  for (
    const row of rows
  ) {
    const id =
      String(
        row.bundle_id ??
          ''
      ).trim();

    if (id) {
      counts[id] =
        Number(
          row.like_count
        ) || 0;
    }
  }

  return json({
    success:
      true,
    counts
  });
}

async function handleAnalyticsEvent(
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
    null
  );

  return json({
    success:
      true
  });
}

function rankNumber(v) {
  const n =
    Number(v);

  return Number.isFinite(n)
    ? n
    : 0;
}

function buildLeaderboard(
  rows,
  userId,
  attemptId
) {
  const clean =
    rows
      .map(
        d1RowToSource
      )
      .filter(
        r =>
          [
            'completed',
            'submitted'
          ].includes(
            String(
              r.status ||
                'completed'
            ).toLowerCase()
          )
      )
      .map(
        r => ({
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

          accuracy:
            Number.isFinite(
              Number(
                r.accuracy
              )
            )
              ? Number(
                  r.accuracy
                )
              : (() => {
                  const c =
                    rankNumber(
                      r.correct
                    );

                  const w =
                    rankNumber(
                      r.wrong
                    );

                  return c + w > 0
                    ? Number(
                        (
                          (c /
                            (c + w)) *
                          100
                        ).toFixed(
                          2
                        )
                      )
                    : 0;
                })(),

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
              r.time_taken ??
                r.time_seconds ??
                r.timeTaken
            ),

          attempt_id:
            r.attempt_id ||
            r.id
        })
      );

  /*
   * One ranking entry per student.
   * The selected attempt is always preserved exactly
   * so View Ranking can identify the current attempt.
   */
  const better = (
    a,
    b
  ) => {
    const ds =
      Number(
        a.score || 0
      ) -
      Number(
        b.score || 0
      );

    if (ds) {
      return ds > 0;
    }

    const da =
      Number(
        a.accuracy || 0
      ) -
      Number(
        b.accuracy || 0
      );

    if (da) {
      return da > 0;
    }

    const dt =
      Number(
        b.time_taken ||
          1e9
      ) -
      Number(
        a.time_taken ||
          1e9
      );

    if (dt) {
      return dt > 0;
    }

    return String(
      a.attempt_id ||
        ''
    ) <
      String(
        b.attempt_id ||
          ''
      );
  };

  const best =
    new Map();

  for (
    const row of clean
  ) {
    const key =
      String(
        row.user_id ||
          ''
      );

    if (!key) {
      continue;
    }

    const old =
      best.get(
        key
      );

    if (
      !old ||
      better(
        row,
        old
      )
    ) {
      best.set(
        key,
        row
      );
    }
  }

  const selected =
    attemptId
      ? clean.find(
          r =>
            String(
              r.attempt_id
            ) ===
            String(
              attemptId
            )
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
    [
      ...best.values()
    ].sort(
      (a, b) =>
        better(a, b)
          ? -1
          : better(b, a)
            ? 1
            : 0
    );

  const n =
    list.length;

  let lastKey =
    '';

  let lastRank =
    0;

  const leaderboard =
    list.map(
      (r, i) => {
        const key =
          Number(
            r.score || 0
          ) +
          '|' +
          Number(
            r.accuracy || 0
          ).toFixed(4) +
          '|' +
          Number(
            r.time_taken ||
              0
          );

        const rank =
          key === lastKey
            ? lastRank
            : i + 1;

        lastKey =
          key;

        lastRank =
          rank;

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
                String(
                  attemptId
                )
            ) ||
            (
              !attemptId &&
              userId &&
              String(
                r.user_id
              ) ===
                String(
                  userId
                )
            )
        };
      }
    );

  const me =
    leaderboard.find(
      r =>
        attemptId &&
        String(
          r.attempt_id
        ) ===
          String(
            attemptId
          )
    ) ||
    leaderboard.find(
      r =>
        userId &&
        String(
          r.user_id
        ) ===
          String(
            userId
          )
    ) ||
    null;

  if (me) {
    me.is_you =
      true;
  }

  if (me) {
    me.percentile =
      n <= 1
        ? 100
        : Number(
            (
              (
                (n - me.rank) /
                (n - 1)
              ) *
              100
            ).toFixed(2)
          );
  }

  for (
    const r of leaderboard
  ) {
    if (
      r.percentile ==
      null
    ) {
      r.percentile =
        n <= 1
          ? 100
          : Number(
              (
                (
                  (n - r.rank) /
                  (n - 1)
                ) *
                100
              ).toFixed(2)
            );
    }
  }

  return {
    success:
      true,

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

async function handleAdminAnalyticsClear(
  request,
  env
) {
  if (
    !adminAllowed(
      request,
      env
    )
  ) {
    return bad(
      'Unauthorized',
      401
    );
  }

  let analyticsDeleted =
    0;

  let rankingDeleted =
    0;

  try {
    const a =
      await env.DB
        .prepare(
          'DELETE FROM "emp_analytics_events"'
        )
        .run();

    analyticsDeleted =
      Number(
        a.meta?.changes ||
          0
      );

  } catch (e) {
    console.error(
      'Analytics clear failed:',
      e
    );

    return bad(
      'Could not clear analytics events: ' +
        String(
          e?.message || e
        ),
      500
    );
  }

  try {
    const r =
      await env.DB
        .prepare(
          'DELETE FROM "emp_test_submissions"'
        )
        .run();

    rankingDeleted =
      Number(
        r.meta?.changes ||
          0
      );

  } catch (e) {
    console.error(
      'Ranking clear failed:',
      e
    );

    return bad(
      'Analytics cleared but ranking submissions could not be cleared: ' +
        String(
          e?.message || e
        ),
      500
    );
  }

  return json({
    success:
      true,

    analytics_deleted:
      analyticsDeleted,

    ranking_submissions_deleted:
      rankingDeleted,

    message:
      'Analytics and ranking submissions cleared. Student local history is untouched.'
  });
}

async function handleRankTests(
  request,
  env
) {
  if (
    !adminAllowed(
      request,
      env
    )
  ) {
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
        WHERE "status" IN ('completed','submitted')
          AND test_id IS NOT NULL
          AND TRIM(
            CAST(
              test_id AS TEXT
            )
          ) <> ''
        GROUP BY test_id
        ORDER BY latest_completed_at DESC
      `)
      .all();

  return json({
    success:
      true,

    tests:
      (
        rows.results ||
        []
      ).map(
        r => ({
          test_id:
            String(
              r.test_id
            ),

          test_name:
            r.test_name ||
            'Untitled test',

          attempts:
            Number(
              r.attempts ||
                0
            ),

          participants:
            Number(
              r.participants ||
                0
            ),

          latest_completed_at:
            r.latest_completed_at ||
            null
        })
      )
  });
}

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

  const attemptId =
    String(
      body?.attempt_id ||
        ''
    ).trim();

  const testId =
    String(
      body?.test_id ||
        ''
    ).trim();

  const userId =
    String(
      body?.user_id ||
        ''
    ).trim();

  if (
    !attemptId ||
    !testId ||
    !userId
  ) {
    return bad(
      'attempt_id, test_id and user_id are required',
      400
    );
  }

  const rawStatus =
    String(
      body?.status ||
        'completed'
    )
      .trim()
      .toLowerCase();

  const status =
    rawStatus ===
    'submitted'
      ? 'submitted'
      : 'completed';

  const row = {
    ...body,

    id:
      body.id ||
      crypto.randomUUID(),

    attempt_id:
      attemptId,

    test_id:
      testId,

    user_id:
      userId,

    status,

    completed_at:
      body.completed_at ||
      nowIso(),

    created_at:
      body.created_at ||
      nowIso(),

    total_marks:
      body.total_marks ??
      body.total ??
      body.total_questions ??
      0,

    score:
      body.score ??
      body.marks ??
      0,

    accuracy:
      body.accuracy ??
      0,

    percentile:
      body.percentile ??
      0
  };

  try {
    await upsertSourceRow(
      env,
      'emp_test_submissions',
      row,
      'attempt_id'
    );

    const saved =
      await env.DB
        .prepare(`
          SELECT *
          FROM "emp_test_submissions"
          WHERE "attempt_id" = ?
          LIMIT 1
        `)
        .bind(
          attemptId
        )
        .first();

    return json({
      success:
        true,

      source:
        'cloudflare_d1',

      saved:
        !!saved,

      attempt_id:
        attemptId,

      test_id:
        testId,

      status:
        String(
          saved?.status ||
            status
        ),

      row:
        saved
          ? d1RowToSource(
              saved
            )
          : row
    });

  } catch (e) {
    console.error(
      'Rank submit failed:',
      e
    );

    return bad(
      String(
        e?.message ||
          e ||
          'Rank submit failed'
      ),
      500
    );
  }
}

async function handleRankParticipants(
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

  if (!testId) {
    return bad(
      'test_id is required',
      400
    );
  }

  try {
    const rows =
      await env.DB
        .prepare(`
          SELECT *
          FROM "emp_test_submissions"
          WHERE "test_id" = ?
            AND "status" IN ('completed','submitted')
        `)
        .bind(
          testId
        )
        .all();

    const result =
      buildLeaderboard(
        rows.results ||
          [],
        '',
        ''
      );

    return json({
      success:
        true,

      test_id:
        testId,

      participants:
        result.participants,

      entries:
        result.leaderboard,

      leaderboard:
        result.leaderboard
    });

  } catch (e) {
    console.error(
      'Rank participants failed:',
      e
    );

    return bad(
      String(
        e?.message ||
          e ||
          'Unable to load participants'
      ),
      500
    );
  }
}

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
          AND "status" IN ('completed','submitted')
      `)
      .bind(
        testId
      )
      .all();

  return json(
    buildLeaderboard(
      rows.results ||
        [],
      userId,
      attemptId
    )
  );
}

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
      url.pathname ===
        '/' ||
      url.pathname ===
        '/health'
    ) {
      return json({
        ok:
          true,

        service:
          'ExamMaster Pro Cloudflare Worker',

        version:
          'V5.171-SAFE-RANK-FIX',

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
