/*
 * ExamMaster Pro - Cloudflare Worker / D1
 * V5.160 - RANKING YOU FIXED
 *
 * Fixes:
 * 1. bundle_tests access state is authoritative.
 * 2. Access-only test updates never erase existing html_content.
 * 3. Activation entitlement RPCs.
 * 4. Bundle like-count endpoint.
 * 5. Analytics events.
 * 6. Ranking submit.
 * 7. Ranking leaderboard:
 *    - One best ranking entry per student
 *    - Selected attempt is preserved
 *    - Exact attempt_id identifies YOU
 *    - user_id fallback identifies YOU
 *    - Rank calculated correctly
 *    - Percentile calculated correctly
 *    - is_you returned for every leaderboard row
 */

const TABLES = new Set([
  'subjects',
  'notes',
  'bundles',
  'bundle_tests',
  'banners',
  'activation_codes',
  'entitlements',
  'emp_test_submissions',
  'emp_analytics_events',
  'content_notifications',
  'admin_users',
  'app_releases',
  'cf_users'
]);

const PUBLIC_TABLES = new Set([
  'subjects',
  'notes',
  'bundles',
  'bundle_tests',
  'banners',
  'content_notifications',
  'app_releases'
]);

const ADMIN_READ_TABLES = new Set([
  'activation_codes',
  'emp_analytics_events',
  'admin_users',
  'cf_users'
]);

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':
      'GET,POST,PATCH,PUT,DELETE,OPTIONS',
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
      'Content-Type':
        'application/json; charset=utf-8',
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
    headers: corsHeaders({
      'Content-Type': contentType
    })
  });
}

function bad(
  message,
  status = 400,
  details = null
) {
  return json(
    {
      code: status,
      message,
      ...(details ? { details } : {})
    },
    status
  );
}

function nowIso() {
  return new Date().toISOString();
}

function cleanIdent(v) {
  const s = String(v || '');
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)
    ? s
    : null;
}

function decodeFilterValue(raw) {
  try {
    return decodeURIComponent(
      String(raw ?? '')
    );
  } catch (_) {
    return String(raw ?? '');
  }
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

    if (key === 'or' || key === 'and') {
      continue;
    }

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
        .map(x =>
          x.replace(/^"|"$/g, '')
        )
        .map(decodeFilterValue);
    } else if (op === 'is') {
      const low =
        String(val).toLowerCase();

      val =
        low === 'null'
          ? null
          : low === 'true';
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
        return (
          String(actual ?? '') ===
          String(val ?? '')
        );

      case 'neq':
        return (
          String(actual ?? '') !==
          String(val ?? '')
        );

      case 'gt':
        return (
          compareValue(actual, val) > 0
        );

      case 'gte':
        return (
          compareValue(actual, val) >= 0
        );

      case 'lt':
        return (
          compareValue(actual, val) < 0
        );

      case 'lte':
        return (
          compareValue(actual, val) <= 0
        );

      case 'in':
        return (
          Array.isArray(val) &&
          val.some(
            x =>
              String(actual ?? '') ===
              String(x)
          )
        );

      case 'is':
        return val === null
          ? actual == null
          : Boolean(actual) ===
            Boolean(val);

      case 'like':
        return String(actual ?? '')
          .includes(
            String(val).replace(
              /%/g,
              ''
            )
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
  if (!raw || raw === '*') {
    return null;
  }

  return String(raw)
    .split(',')
    .map(s =>
      cleanIdent(s.trim())
    )
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
      const p =
        part.trim().split('.');

      return {
        field: cleanIdent(p[0]),
        dir:
          String(
            p[1] || 'asc'
          ).toLowerCase() ===
          'desc'
            ? -1
            : 1
      };
    })
    .filter(x => x.field);
}

function normalizeAccessState(source) {
  const s =
    source &&
    typeof source === 'object'
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
    String(s.is_paid).toLowerCase() ===
      'true' ||
    Number(s.is_paid) === 1 ||
    Number(s.price) > 0
  ) {
    return 'paid';
  }

  if (
    values.includes('free') ||
    s.is_paid === false ||
    String(s.is_paid).toLowerCase() ===
      'false' ||
    Number(s.is_paid) === 0
  ) {
    return 'free';
  }

  return 'inherit';
}

function normalizeTestAccess(source) {
  const s =
    source &&
    typeof source === 'object'
      ? source
      : {};

  const state =
    normalizeAccessState(s);

  return {
    state,

    access_mode: state,

    access_override: state,

    access_type: state,

    is_paid:
      state === 'paid',

    price:
      state === 'paid'
        ? Math.max(
            0,
            Number(s.price || 0) ||
              0
          )
        : 0
  };
}

function sourceRowToD1(
  table,
  source
) {
  const src =
    source &&
    typeof source === 'object'
      ? JSON.parse(
          JSON.stringify(source)
        )
      : {};

  const id =
    src.id != null
      ? String(src.id)
      : crypto.randomUUID();

  const common = {
    id,
    data_json:
      JSON.stringify(src)
  };

  if (table === 'subjects') {
    Object.assign(common, {
      name:
        src.name ?? null,

      description:
        src.description ?? null,

      icon:
        src.icon ?? null,

      color:
        src.color ?? null,

      created_at:
        src.created_at ??
        nowIso(),

      updated_at:
        src.updated_at ??
        nowIso()
    });
  }

  else if (table === 'notes') {
    Object.assign(common, {
      subject_id:
        src.subject_id != null
          ? String(
              src.subject_id
            )
          : null,

      title:
        src.title ?? null,

      content:
        src.content ?? null,

      file_data:
        src.file_data ?? null,

      file_name:
        src.file_name ?? null,

      file_type:
        src.file_type ?? null,

      created_at:
        src.created_at ??
        nowIso(),

      updated_at:
        src.updated_at ??
        nowIso()
    });
  }

  else if (table === 'bundles') {
    Object.assign(common, {
      name:
        src.name ??
        'Untitled Bundle',

      description:
        src.description ??
        null,

      updated_at:
        src.updated_at ??
        nowIso()
    });
  }

  else if (
    table === 'bundle_tests'
  ) {
    const a =
      normalizeTestAccess(src);

    src.access_mode =
      a.access_mode;

    src.access_override =
      a.access_override;

    src.access_type =
      a.access_type;

    src.is_paid =
      a.is_paid;

    src.price =
      a.price;

    common.data_json =
      JSON.stringify(src);

    Object.assign(common, {
      bundle_id:
        src.bundle_id != null
          ? String(src.bundle_id)
          : '',

      bundle_subject_id:
        src.bundle_subject_id != null
          ? String(
              src.bundle_subject_id
            )
          : null,

      bundle_subject_name:
        src.bundle_subject_name ??
        null,

      name:
        src.name ??
        'Untitled Test',

      description:
        src.description ??
        null,

      level:
        src.level ?? null,

      difficulty:
        src.difficulty ??
        null,

      time_limit:
        src.time_limit ??
        null,

      html_content:
        src.html_content ??
        null,

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
        src.total_questions ??
        null,

      updated_at:
        src.updated_at ??
        nowIso(),

      deleted_at:
        src.deleted_at ??
        null
    });
  }

  else if (table === 'banners') {
    Object.assign(common, {
      title:
        src.title ?? null,

      description:
        src.description ??
        null,

      price:
        src.price ?? null,

      image:
        src.image ?? null,

      qrData:
        src.qrData ?? null,

      link_type:
        src.link_type ??
        null,

      link:
        src.link ?? null,

      bundle_id:
        src.bundle_id == null ||
        src.bundle_id === ''
          ? null
          : String(
              src.bundle_id
            ),

      subject_id:
        src.subject_id ??
        null,

      test_id:
        src.test_id ??
        null,

      slide_seconds:
        src.slide_seconds ??
        null,

      updated_at:
        src.updated_at ??
        nowIso()
    });
  }

  else if (
    table === 'activation_codes'
  ) {
    Object.assign(common, {
      code:
        src.code ??
        src.code_hash ??
        null,

      bundle_id:
        src.bundle_id != null
          ? String(
              src.bundle_id
            )
          : null,

      amount:
        src.amount ?? 0,

      status:
        src.status ??
        'unused',

      redeemed_by:
        src.redeemed_by ??
        null,

      redeemed_at:
        src.redeemed_at ??
        null,

      created_at:
        src.created_at ??
        nowIso()
    });
  }

  else if (
    table === 'entitlements'
  ) {
    Object.assign(common, {
      user_key:
        String(
          src.user_key ?? ''
        ),

      bundle_id:
        src.bundle_id != null
          ? String(
              src.bundle_id
            )
          : '',

      created_at:
        src.created_at ??
        nowIso()
    });
  }

  else if (
    table ===
    'emp_test_submissions'
  ) {
    Object.assign(common, {
      attempt_id:
        src.attempt_id ??
        id,

      user_id:
        src.user_id != null
          ? String(
              src.user_id
            )
          : null,

      username:
        src.username ??
        null,

      test_id:
        src.test_id != null
          ? String(
              src.test_id
            )
          : null,

      bundle_id:
        src.bundle_id != null
          ? String(
              src.bundle_id
            )
          : null,

      score:
        src.score ??
        src.marks ??
        0,

      total_marks:
        src.total_marks ??
        src.total_questions ??
        0,

      accuracy:
        src.accuracy ??
        null,

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
        src.status ??
        'completed',

      completed_at:
        src.completed_at ??
        nowIso(),

      created_at:
        src.created_at ??
        nowIso()
    });
  }

  else if (
    table ===
    'emp_analytics_events'
  ) {
    Object.assign(common, {
      user_id:
        src.user_id != null
          ? String(
              src.user_id
            )
          : null,

      event_type:
        src.event_type ??
        null,

      test_id:
        src.test_id != null
          ? String(
              src.test_id
            )
          : null,

      bundle_id:
        src.bundle_id != null
          ? String(
              src.bundle_id
            )
          : null,

      occurred_at:
        src.occurred_at ??
        nowIso()
    });
  }

  else if (
    table ===
    'content_notifications'
  ) {
    Object.assign(common, {
      title:
        src.title ??
        null,

      message:
        src.message ??
        null,

      image:
        src.image ??
        null,

      active:
        src.active ??
        true,

      created_at:
        src.created_at ??
        nowIso(),

      updated_at:
        src.updated_at ??
        nowIso()
    });
  }

  else if (
    table === 'admin_users'
  ) {
    Object.assign(common, {
      username:
        src.username ??
        null,

      password:
        src.password ??
        null,

      role:
        src.role ??
        'admin',

      created_at:
        src.created_at ??
        nowIso(),

      updated_at:
        src.updated_at ??
        nowIso()
    });
  }

  else if (
    table === 'app_releases'
  ) {
    Object.assign(common, {
      version:
        src.version ??
        null,

      title:
        src.title ??
        null,

      notes:
        src.notes ??
        null,

      url:
        src.url ??
        null,

      active:
        src.active ??
        true,

      created_at:
        src.created_at ??
        nowIso(),

      updated_at:
        src.updated_at ??
        nowIso()
    });
  }

  else if (
    table === 'cf_users'
  ) {
    Object.assign(common, {
      user_id:
        src.user_id != null
          ? String(
              src.user_id
            )
          : null,

      username:
        src.username ??
        null,

      email:
        src.email ??
        null,

      created_at:
        src.created_at ??
        nowIso(),

      updated_at:
        src.updated_at ??
        nowIso()
    });
  }

  return common;
}

function d1RowToSource(row) {
  if (!row) return null;

  let src = {};

  try {
    src = row.data_json
      ? JSON.parse(
          row.data_json
        )
      : {};
  } catch (_) {
    src = {};
  }

  const merged = {
    ...src,
    ...row
  };

  delete merged.data_json;

  if (
    Object.prototype.hasOwnProperty.call(
      row,
      'access_mode'
    )
  ) {
    merged.access_mode =
      row.access_mode;

    merged.access_override =
      row.access_override;

    merged.access_type =
      row.access_type;

    merged.is_paid =
      Boolean(
        Number(row.is_paid)
      );

    merged.price =
      Number(
        row.price || 0
      );
  }

  if (
    (!merged.html_content ||
      String(
        merged.html_content
      ).trim() === '') &&
    src.html_content
  ) {
    merged.html_content =
      src.html_content;
  }

  return merged;
}

function adminAllowed(
  request,
  env
) {
  const configured =
    String(
      env.ADMIN_API_KEY || ''
    ).trim();

  if (!configured) {
    return true;
  }

  const supplied =
    String(
      request.headers.get(
        'X-EMP-Admin-Key'
      ) || ''
    ).trim();

  return supplied === configured;
}

async function getTableRows(
  env,
  table,
  includeDeleted = false
) {
  if (
    table === 'bundle_tests'
  ) {
    let query =
      'SELECT * FROM "bundle_tests"';

    if (!includeDeleted) {
      query +=
        ' WHERE "deleted_at" IS NULL';
    }

    query +=
      ' ORDER BY "id" ASC';

    const result =
      await env.DB
        .prepare(query)
        .all();

    return (
      result.results || []
    ).map(
      d1RowToSource
    );
  }

  const result =
    await env.DB
      .prepare(
        `SELECT * FROM "${table}"`
      )
      .all();

  return (
    result.results || []
  ).map(
    d1RowToSource
  );
}

async function upsertSourceRow(
  env,
  table,
  src,
  conflict = null
) {
  if (!TABLES.has(table)) {
    throw new Error(
      'Unsupported table: ' +
        table
    );
  }

  let source =
    src &&
    typeof src === 'object'
      ? JSON.parse(
          JSON.stringify(src)
        )
      : {};

  if (
    table === 'bundle_tests' &&
    source.id
  ) {
    const existing =
      await env.DB
        .prepare(
          'SELECT * FROM "bundle_tests" WHERE "id" = ? LIMIT 1'
        )
        .bind(
          String(source.id)
        )
        .first();

    if (
      existing &&
      (!source.html_content ||
        String(
          source.html_content
        ).trim() === '')
    ) {
      const existingSource =
        d1RowToSource(
          existing
        );

      if (
        existingSource &&
        existingSource.html_content
      ) {
        source.html_content =
          existingSource.html_content;
      }
    }

    if (
      existing &&
      !source.updated_at
    ) {
      source.updated_at =
        existing.updated_at ||
        nowIso();
    }
  }

  const row =
    sourceRowToD1(
      table,
      source
    );

  const columns =
    Object.keys(row);

  const values =
    columns.map(
      key => row[key]
    );

  let sql;

  if (conflict) {
    sql = `
      INSERT INTO "${table}"
      (${columns
        .map(c => `"${c}"`)
        .join(',')})
      VALUES
      (${columns
        .map(() => '?')
        .join(',')})
      ON CONFLICT("${conflict}")
      DO UPDATE SET
      ${columns
        .filter(
          c => c !== conflict
        )
        .map(
          c =>
            `"${c}" = excluded."${c}"`
        )
        .join(',')}
    `;
  } else {
    sql = `
      INSERT INTO "${table}"
      (${columns
        .map(c => `"${c}"`)
        .join(',')})
      VALUES
      (${columns
        .map(() => '?')
        .join(',')})
      ON CONFLICT("id")
      DO UPDATE SET
      ${columns
        .filter(
          c => c !== 'id'
        )
        .map(
          c =>
            `"${c}" = excluded."${c}"`
        )
        .join(',')}
    `;
  }

  await env.DB
    .prepare(sql)
    .bind(...values)
    .run();

  const saved =
    await env.DB
      .prepare(
        `SELECT * FROM "${table}" WHERE "id" = ? LIMIT 1`
      )
      .bind(
        String(row.id)
      )
      .first();

  return saved
    ? d1RowToSource(saved)
    : source;
}

async function deleteByFilters(
  env,
  table,
  url
) {
  const filters =
    parseFilters(url);

  const rows =
    await getTableRows(
      env,
      table,
      true
    );

  const matching =
    rows.filter(row =>
      rowMatches(
        row,
        filters
      )
    );

  if (!matching.length) {
    return 0;
  }

  if (
    table === 'bundle_tests'
  ) {
    for (const row of matching) {
      const updated = {
        ...row,
        deleted_at:
          nowIso(),
        updated_at:
          nowIso()
      };

      await upsertSourceRow(
        env,
        table,
        updated,
        null
      );
    }

    return matching.length;
  }

  for (const row of matching) {
    await env.DB
      .prepare(
        `DELETE FROM "${table}" WHERE "id" = ?`
      )
      .bind(
        String(row.id)
      )
      .run();
  }

  return matching.length;
}

async function handleRest(
  request,
  env,
  table,
  url
) {
  if (!TABLES.has(table)) {
    return bad(
      'Unknown table: ' +
        table,
      404
    );
  }

  const isPublic =
    PUBLIC_TABLES.has(table);

  const isAdminRead =
    ADMIN_READ_TABLES.has(
      table
    );

  if (
    !isPublic &&
    !isAdminRead &&
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

  if (
    isAdminRead &&
    request.method === 'GET' &&
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

  if (
    request.method === 'GET'
  ) {
    let rows =
      await getTableRows(
        env,
        table,
        false
      );

    const filters =
      parseFilters(url);

    rows =
      rows.filter(row =>
        rowMatches(
          row,
          filters
        )
      );

    const order =
      parseOrder(
        url.searchParams.get(
          'order'
        )
      );

    if (order.length) {
      rows.sort((a, b) => {
        for (const o of order) {
          const cmp =
            compareValue(
              a[o.field],
              b[o.field]
            );

          if (cmp !== 0) {
            return (
              cmp * o.dir
            );
          }
        }

        return 0;
      });
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

    const limit =
      limitRaw == null
        ? rows.length
        : Math.max(
            0,
            Number(limitRaw) || 0
          );

    rows =
      rows.slice(
        offset,
        offset + limit
      );

    const select =
      parseSelect(
        url.searchParams.get(
          'select'
        )
      );

    rows =
      rows.map(row =>
        applySelect(
          row,
          select
        )
      );

    return json(rows);
  }

  if (
    request.method === 'POST'
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
    request.method === 'PATCH' ||
    request.method === 'PUT'
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

    const filters =
      parseFilters(url);

    let rows =
      await getTableRows(
        env,
        table,
        true
      );

    rows =
      rows.filter(row =>
        rowMatches(
          row,
          filters
        )
      );

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
    request.method === 'DELETE'
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
    ...new Uint8Array(digest)
  ]
    .map(b =>
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

  let codeRow =
    await env.DB
      .prepare(
        'SELECT * FROM "activation_codes" WHERE "code" = ? LIMIT 1'
      )
      .bind(code)
      .first();

  if (!codeRow) {
    const hash =
      await sha256Hex(code);

    codeRow =
      await env.DB
        .prepare(
          'SELECT * FROM "activation_codes" WHERE "code" = ? LIMIT 1'
        )
        .bind(hash)
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
        'SELECT 1 FROM "entitlements" WHERE "user_key" = ? AND "bundle_id" = ? LIMIT 1'
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

  await env.DB
    .prepare(
      'UPDATE "activation_codes" SET "status" = ?, "redeemed_by" = ?, "redeemed_at" = ?, "data_json" = ? WHERE "id" = ?'
    )
    .bind(
      'used',
      userKey,
      now,
      JSON.stringify({
        ...activation,
        status: 'used',
        redeemed_by:
          userKey,
        redeemed_at:
          now
      }),
      String(
        codeRow.id
      )
    )
    .run();

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

  await upsertSourceRow(
    env,
    'entitlements',
    ent,
    null
  );

  return json({
    status: 'success',
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
        'SELECT * FROM "entitlements" WHERE "user_key" = ? ORDER BY "created_at" DESC'
      )
      .bind(userKey)
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
    Array.isArray(body.rows)
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

      bundle_tests_written:
        0
    });
  }

  let target = table;

  if (
    target === 'tests'
  ) {
    target =
      'bundle_tests';
  }

  if (
    !TABLES.has(target)
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

/*
 * =========================================================
 * BUNDLE LIKES
 * =========================================================
 */

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
        .map(x =>
          String(x).trim()
        )
        .filter(Boolean)
    )
  ].slice(0, 200);

  if (!ids.length) {
    return json({
      success: true,
      counts: {}
    });
  }

  const placeholders =
    ids
      .map(() => '?')
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

      FROM
        "emp_analytics_events"

      WHERE
        event_type =
        'bundle_like'

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
    counts[id] = 0;
  }

  for (
    const row of rows
  ) {
    const id =
      String(
        row.bundle_id ?? ''
      ).trim();

    if (id) {
      counts[id] =
        Number(
          row.like_count
        ) || 0;
    }
  }

  return json({
    success: true,
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
    success: true
  });
}

/*
 * =========================================================
 * RANKING
 * =========================================================
 */

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
  const clean =
    rows
      .map(d1RowToSource)
      .filter(
        r =>
          String(
            r.status ||
              'completed'
          ).toLowerCase() ===
          'completed'
      )
      .map(r => ({
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
                      ).toFixed(2)
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
      }));

  /*
   * Compare two attempts:
   * 1. Higher score wins
   * 2. Higher accuracy wins
   * 3. Lower time wins
   * 4. Stable attempt_id tie breaker
   */
  const better = (a, b) => {
    const ds =
      Number(a.score || 0) -
      Number(b.score || 0);

    if (ds) {
      return ds > 0;
    }

    const da =
      Number(a.accuracy || 0) -
      Number(b.accuracy || 0);

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

    return (
      String(
        a.attempt_id || ''
      ) <
      String(
        b.attempt_id || ''
      )
    );
  };

  /*
   * One ranking entry per student.
   */
  const best =
    new Map();

  for (
    const row of clean
  ) {
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
   * IMPORTANT:
   * If the user opened ranking for a specific
   * attempt, preserve that exact attempt.
   *
   * This prevents the leaderboard from replacing
   * the user's selected attempt with another
   * historical attempt.
   */
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

  /*
   * Sort:
   * Higher score first
   * Higher accuracy second
   * Lower time third
   */
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

  let lastKey = '';
  let lastRank = 0;

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
            r.time_taken || 0
          );

        /*
         * Equal score + accuracy + time
         * receives the same rank.
         */
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

          /*
           * This is what the HTML uses to show
           * YOU on the leaderboard.
           */
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

  /*
   * Find current user's exact row.
   *
   * First priority:
   * exact attempt_id
   *
   * Second priority:
   * user_id
   */
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
    me.is_you = true;
  }

  /*
   * Percentile:
   *
   * 1 participant = 100
   *
   * Otherwise:
   * ((participants - rank) /
   *  (participants - 1)) * 100
   */
  if (me) {
    me.percentile =
      n <= 1
        ? 100
        : Number(
            (
              (
                (n -
                  me.rank) /
                (n - 1)
              ) *
              100
            ).toFixed(2)
          );
  }

  /*
   * Give every leaderboard row its percentile.
   */
  for (
    const r of leaderboard
  ) {
    if (
      r.percentile == null
    ) {
      r.percentile =
        n <= 1
          ? 100
          : Number(
              (
                (
                  (n -
                    r.rank) /
                  (n - 1)
                ) *
                100
              ).toFixed(2)
            );
    }
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

    source:
      'cloudflare_d1'
  });
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
      .prepare(
        'SELECT * FROM "emp_test_submissions" WHERE "test_id" = ? AND "status" = ?'
      )
      .bind(
        testId,
        'completed'
      )
      .all();

  return json(
    buildLeaderboard(
      rows.results || [],
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
    /*
     * JSON IMPORT
     */
    if (
      url.pathname ===
      '/api/import/json'
    ) {
      return await handleImportJson(
        request,
        env
      );
    }

    /*
     * BUNDLE LIKE COUNTS
     */
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

    /*
     * ANALYTICS EVENT
     */
    if (
      url.pathname ===
      '/api/analytics/event'
    ) {
      return await handleAnalyticsEvent(
        request,
        env
      );
    }

    /*
     * RANK SUBMIT
     */
    if (
      url.pathname ===
      '/api/rank/submit'
    ) {
      return await handleRankSubmit(
        request,
        env
      );
    }

    /*
     * RANK LEADERBOARD
     */
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

    /*
     * ACTIVATION RPC
     */
    if (
      url.pathname ===
      '/rest/v1/rpc/redeem_activation_code'
    ) {
      return await handleRedeemActivation(
        request,
        env
      );
    }

    /*
     * ENTITLEMENTS RPC
     */
    if (
      url.pathname ===
      '/rest/v1/rpc/get_bundle_entitlements'
    ) {
      return await handleGetBundleEntitlements(
        request,
        env
      );
    }

    /*
     * REST API
     */
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

    /*
     * HEALTH CHECK
     */
    if (
      url.pathname === '/' ||
      url.pathname === '/health'
    ) {
      return json({
        ok: true,

        service:
          'ExamMaster Pro Cloudflare Worker',

        version:
          'V5.160-RANKING-YOU-FIXED',

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
