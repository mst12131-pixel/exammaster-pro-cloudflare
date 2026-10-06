// Worker V5.170 - Rank Submit Reliable Fix
// Cloudflare Worker + D1
// Fixes:
// 1. /api/rank/participants endpoint
// 2. Reliable rank submission after Analytics Clear
// 3. completed + submitted status support
// 4. Exact attempt_id upsert + verification
// 5. Rank repair/read reliability

const TABLES = {
  bundle_tests: 'bundle_tests',
  emp_test_submissions: 'emp_test_submissions',
  emp_analytics_events: 'emp_analytics_events',
  bundles: 'bundles',
  entitlements: 'entitlements'
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders
    }
  });
}

function bad(message, status = 400) {
  return json({
    success: false,
    error: message
  }, status);
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value, fallback = {}) {
  if (value == null) return fallback;

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function normalizeAccessState(value) {
  const v = String(value ?? '').trim().toUpperCase();

  if (
    v === 'PAID' ||
    v === 'PURCHASED' ||
    v === 'PREMIUM' ||
    v === 'LOCKED'
  ) {
    return 'PAID';
  }

  return 'FREE';
}

function normalizeTestAccess(row) {
  if (!row || typeof row !== 'object') return 'FREE';

  return normalizeAccessState(
    row.access ??
    row.access_type ??
    row.test_access ??
    row.visibility ??
    row.data?.access ??
    row.data_json?.access
  );
}

function normalizeStatus(value) {
  const v = String(value ?? '').trim().toLowerCase();

  if (v === 'submitted') return 'submitted';
  if (v === 'completed') return 'completed';

  return 'completed';
}

function normalizeId(value) {
  return String(value ?? '').trim();
}

function tableColumns(table) {
  const map = {
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
      'test_id',
      'bundle_id',
      'attempt_id',
      'created_at',
      'data_json'
    ],

    bundle_tests: [
      'id',
      'bundle_id',
      'test_id',
      'title',
      'name',
      'subject',
      'access',
      'access_type',
      'html_content',
      'data_json',
      'status',
      'created_at',
      'updated_at'
    ],

    bundles: [
      'id',
      'bundle_id',
      'title',
      'name',
      'description',
      'image',
      'access',
      'status',
      'data_json',
      'created_at',
      'updated_at'
    ],

    entitlements: [
      'id',
      'user_key',
      'bundle_id',
      'status',
      'created_at',
      'updated_at'
    ]
  };

  return map[table] || [];
}

function sourceRowToD1(table, row) {
  const r = row || {};

  if (table === 'emp_test_submissions') {
    return {
      id: r.id || crypto.randomUUID(),
      attempt_id: normalizeId(r.attempt_id),
      user_id: normalizeId(r.user_id),
      username: r.username ?? '',
      test_id: normalizeId(r.test_id),
      bundle_id: normalizeId(r.bundle_id),
      subject_id: normalizeId(r.subject_id),
      test_name: r.test_name ?? '',
      score: r.score ?? 0,
      total_marks: r.total_marks ?? r.total ?? 0,
      accuracy: r.accuracy ?? 0,
      percentile: r.percentile ?? 0,
      status: normalizeStatus(r.status),
      completed_at: r.completed_at || nowIso(),
      created_at: r.created_at || nowIso(),
      data_json: JSON.stringify(r)
    };
  }

  if (table === 'bundle_tests') {
    const data = safeJsonParse(r.data_json, {});

    const access = normalizeAccessState(
      r.access ??
      r.access_type ??
      data.access ??
      data.access_type
    );

    return {
      id: r.id || r.test_id || crypto.randomUUID(),
      bundle_id: normalizeId(r.bundle_id),
      test_id: normalizeId(r.test_id || r.id),
      title: r.title ?? r.name ?? data.title ?? data.name ?? '',
      name: r.name ?? r.title ?? data.name ?? data.title ?? '',
      subject: r.subject ?? data.subject ?? '',
      access,
      access_type: access,
      html_content:
        r.html_content ??
        data.html_content ??
        data.html ??
        '',
      data_json: JSON.stringify({
        ...data,
        ...r,
        access,
        access_type: access
      }),
      status: r.status ?? 'published',
      created_at: r.created_at || nowIso(),
      updated_at: r.updated_at || nowIso()
    };
  }

  if (table === 'bundles') {
    const data = safeJsonParse(r.data_json, {});

    return {
      id: r.id || r.bundle_id || crypto.randomUUID(),
      bundle_id: normalizeId(r.bundle_id || r.id),
      title: r.title ?? r.name ?? data.title ?? data.name ?? '',
      name: r.name ?? r.title ?? data.name ?? data.title ?? '',
      description: r.description ?? data.description ?? '',
      image: r.image ?? data.image ?? '',
      access: normalizeAccessState(
        r.access ??
        data.access
      ),
      status: r.status ?? 'published',
      data_json: JSON.stringify({
        ...data,
        ...r
      }),
      created_at: r.created_at || nowIso(),
      updated_at: r.updated_at || nowIso()
    };
  }

  return r;
}

function d1RowToSource(row) {
  if (!row) return null;

  const data = safeJsonParse(row.data_json, {});

  return {
    ...data,
    ...row
  };
}

async function upsertSourceRow(env, table, row, conflictKey = 'id') {
  const db = env.DB;

  if (!db) {
    throw new Error('D1 binding DB is missing');
  }

  const d1 = sourceRowToD1(table, row);
  const columns = tableColumns(table);

  if (!columns.length) {
    throw new Error(`Unsupported table: ${table}`);
  }

  const clean = {};

  for (const c of columns) {
    if (Object.prototype.hasOwnProperty.call(d1, c)) {
      clean[c] = d1[c];
    }
  }

  const keys = Object.keys(clean);

  if (!keys.length) {
    throw new Error(`No writable columns for ${table}`);
  }

  const values = keys.map(k => clean[k]);

  const placeholders = keys.map(() => '?').join(', ');
  const updates = keys
    .filter(k => k !== conflictKey)
    .map(k => `${k}=excluded.${k}`)
    .join(', ');

  const sql = `
    INSERT INTO ${table}
      (${keys.join(', ')})
    VALUES
      (${placeholders})
    ON CONFLICT(${conflictKey})
    DO UPDATE SET
      ${updates}
  `;

  await db
    .prepare(sql)
    .bind(...values)
    .run();

  return d1;
}

async function getTableRowByKey(env, table, key, value) {
  if (!env.DB) throw new Error('D1 binding DB is missing');

  const row = await env.DB
    .prepare(`SELECT * FROM ${table} WHERE ${key} = ? LIMIT 1`)
    .bind(value)
    .first();

  return row ? d1RowToSource(row) : null;
}

async function readTable(env, table, options = {}) {
  if (!env.DB) {
    throw new Error('D1 binding DB is missing');
  }

  const includeDeleted = !!options.includeDeleted;

  let sql = `SELECT * FROM ${table}`;
  const params = [];

  if (table === 'bundle_tests' && !includeDeleted) {
    sql += ` WHERE COALESCE(status,'published') != 'deleted'`;
  }

  sql += ` ORDER BY rowid DESC`;

  const result = await env.DB
    .prepare(sql)
    .bind(...params)
    .all();

  return (result.results || []).map(d1RowToSource);
}

/* -------------------------------------------------------
   ADMIN AUTH
------------------------------------------------------- */

function adminAllowed(request, env) {
  const configured = String(env.ADMIN_API_KEY || '').trim();

  // Existing behavior:
  // if ADMIN_API_KEY is not configured, allow writes.
  if (!configured) return true;

  const supplied =
    request.headers.get('x-admin-key') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    '';

  return supplied === configured;
}

/* -------------------------------------------------------
   RANKING
------------------------------------------------------- */

function isRankStatus(status) {
  const s = String(status ?? '').toLowerCase();

  return s === 'completed' || s === 'submitted';
}

function numberOrZero(value) {
  const n = Number(value);

  return Number.isFinite(n) ? n : 0;
}

function buildLeaderboard(rows) {
  const list = (rows || [])
    .map(r => d1RowToSource(r))
    .filter(Boolean)
    .filter(r => isRankStatus(r.status));

  list.sort((a, b) => {
    const sa = numberOrZero(a.score);
    const sb = numberOrZero(b.score);

    if (sb !== sa) {
      return sb - sa;
    }

    const aa = numberOrZero(a.accuracy);
    const ab = numberOrZero(b.accuracy);

    if (ab !== aa) {
      return ab - aa;
    }

    const ta = Date.parse(a.completed_at || a.created_at || '') || Infinity;
    const tb = Date.parse(b.completed_at || b.created_at || '') || Infinity;

    return ta - tb;
  });

  return list.map((r, index) => ({
    rank: index + 1,
    attempt_id: r.attempt_id || '',
    user_id: r.user_id || '',
    username:
      r.username ||
      r.user_name ||
      r.name ||
      'Anonymous',
    test_id: r.test_id || '',
    bundle_id: r.bundle_id || '',
    subject_id: r.subject_id || '',
    test_name: r.test_name || '',
    score: numberOrZero(r.score),
    total_marks: numberOrZero(
      r.total_marks ??
      r.total ??
      r.max_marks
    ),
    accuracy: numberOrZero(r.accuracy),
    percentile: numberOrZero(r.percentile),
    status: normalizeStatus(r.status),
    completed_at:
      r.completed_at ||
      r.created_at ||
      null
  }));
}

/* -------------------------------------------------------
   POST /api/rank/submit
------------------------------------------------------- */

async function handleRankSubmit(request, env) {
  let body;

  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const attemptId = normalizeId(body.attempt_id);
  const testId = normalizeId(body.test_id);
  const userId = normalizeId(body.user_id);

  if (!attemptId || !testId || !userId) {
    return bad(
      'attempt_id, test_id and user_id are required',
      400
    );
  }

  const incomingStatus = normalizeStatus(body.status);

  const row = {
    ...body,

    id:
      body.id ||
      crypto.randomUUID(),

    attempt_id: attemptId,
    test_id: testId,
    user_id: userId,

    status: incomingStatus,

    completed_at:
      body.completed_at ||
      nowIso(),

    created_at:
      body.created_at ||
      nowIso(),

    total_marks:
      body.total_marks ??
      body.total ??
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

    // Verify that the exact attempt was actually saved.
    const saved = await env.DB
      .prepare(`
        SELECT *
        FROM emp_test_submissions
        WHERE attempt_id = ?
        LIMIT 1
      `)
      .bind(attemptId)
      .first();

    return json({
      success: true,
      source: 'cloudflare_d1',
      saved: !!saved,
      attempt_id: attemptId,
      test_id: testId,
      status: normalizeStatus(
        saved?.status ||
        row.status
      ),
      row: saved
        ? d1RowToSource(saved)
        : row
    });

  } catch (error) {
    return json({
      success: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}

/* -------------------------------------------------------
   GET /api/rank/leaderboard
------------------------------------------------------- */

async function handleRankLeaderboard(request, env, url) {
  const testId =
    normalizeId(
      url.searchParams.get('test_id')
    );

  const userId =
    normalizeId(
      url.searchParams.get('user_id')
    );

  const attemptId =
    normalizeId(
      url.searchParams.get('attempt_id')
    );

  if (!testId) {
    return bad(
      'test_id is required',
      400
    );
  }

  try {
    const result = await env.DB
      .prepare(`
        SELECT *
        FROM emp_test_submissions
        WHERE test_id = ?
          AND status IN ('completed','submitted')
      `)
      .bind(testId)
      .all();

    const leaderboard =
      buildLeaderboard(
        result.results || []
      );

    let user = null;

    if (attemptId) {
      user =
        leaderboard.find(
          x =>
            String(x.attempt_id) ===
            String(attemptId)
        ) || null;
    }

    if (!user && userId) {
      user =
        leaderboard.find(
          x =>
            String(x.user_id) ===
            String(userId)
        ) || null;
    }

    return json({
      success: true,
      test_id: testId,
      participants: leaderboard.length,
      leaderboard,
      user,
      user_rank: user?.rank || null
    });

  } catch (error) {
    return json({
      success: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}

/* -------------------------------------------------------
   GET /api/rank/participants
------------------------------------------------------- */

async function handleRankParticipants(request, env, url) {
  const testId =
    normalizeId(
      url.searchParams.get('test_id')
    );

  if (!testId) {
    return bad(
      'test_id is required',
      400
    );
  }

  try {
    const result = await env.DB
      .prepare(`
        SELECT *
        FROM emp_test_submissions
        WHERE test_id = ?
          AND status IN ('completed','submitted')
      `)
      .bind(testId)
      .all();

    const leaderboard =
      buildLeaderboard(
        result.results || []
      );

    return json({
      success: true,
      test_id: testId,
      participants: leaderboard.length,
      entries: leaderboard,
      leaderboard
    });

  } catch (error) {
    return json({
      success: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}

/* -------------------------------------------------------
   GET /api/rank/tests
------------------------------------------------------- */

async function handleRankTests(request, env) {
  try {
    const result = await env.DB
      .prepare(`
        SELECT
          test_id,
          test_name,
          bundle_id,
          subject_id,
          COUNT(*) AS participants
        FROM emp_test_submissions
        WHERE status IN ('completed','submitted')
        GROUP BY
          test_id,
          test_name,
          bundle_id,
          subject_id
        ORDER BY test_name COLLATE NOCASE
      `)
      .all();

    return json({
      success: true,
      tests: result.results || []
    });

  } catch (error) {
    return json({
      success: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}

/* -------------------------------------------------------
   ADMIN: GENERIC TABLE READ
------------------------------------------------------- */

async function handleTableGet(request, env, url) {
  const table =
    url.searchParams.get('table');

  if (!table) {
    return bad(
      'table is required',
      400
    );
  }

  try {
    const includeDeleted =
      url.searchParams.get(
        'includeDeleted'
      ) === 'true';

    const rows =
      await readTable(
        env,
        table,
        { includeDeleted }
      );

    return json({
      success: true,
      table,
      rows
    });

  } catch (error) {
    return json({
      success: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}

/* -------------------------------------------------------
   ADMIN: GENERIC TABLE UPSERT
------------------------------------------------------- */

async function handleTablePost(request, env) {
  if (!adminAllowed(request, env)) {
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
      'Invalid JSON body',
      400
    );
  }

  const table = body.table;
  const row = body.row;

  if (!table || !row) {
    return bad(
      'table and row are required',
      400
    );
  }

  try {
    const conflictKey =
      body.conflictKey ||
      (
        table === 'bundle_tests'
          ? 'test_id'
          : 'id'
      );

    const saved =
      await upsertSourceRow(
        env,
        table,
        row,
        conflictKey
      );

    return json({
      success: true,
      row: saved
    });

  } catch (error) {
    return json({
      success: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}

/* -------------------------------------------------------
   REST-LIKE PATCH
------------------------------------------------------- */

async function handlePatch(request, env, url) {
  if (!adminAllowed(request, env)) {
    return bad(
      'Unauthorized',
      401
    );
  }

  const table =
    url.searchParams.get('table');

  const key =
    url.searchParams.get('key') ||
    'id';

  const value =
    url.searchParams.get('value');

  if (!table || !value) {
    return bad(
      'table and value are required',
      400
    );
  }

  let patch;

  try {
    patch = await request.json();
  } catch (_) {
    return bad(
      'Invalid JSON body',
      400
    );
  }

  try {
    const existing =
      await getTableRowByKey(
        env,
        table,
        key,
        value
      );

    if (!existing) {
      return bad(
        'Row not found',
        404
      );
    }

    const merged = {
      ...existing,
      ...patch
    };

    // Important:
    // Never erase existing HTML during an
    // access-only / metadata-only update.
    if (
      table === 'bundle_tests' &&
      !patch.html_content &&
      existing.html_content
    ) {
      merged.html_content =
        existing.html_content;
    }

    const saved =
      await upsertSourceRow(
        env,
        table,
        merged,
        key
      );

    return json({
      success: true,
      row: saved
    });

  } catch (error) {
    return json({
      success: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}

/* -------------------------------------------------------
   DELETE
------------------------------------------------------- */

async function handleDelete(request, env, url) {
  if (!adminAllowed(request, env)) {
    return bad(
      'Unauthorized',
      401
    );
  }

  const table =
    url.searchParams.get('table');

  const key =
    url.searchParams.get('key') ||
    'id';

  const value =
    url.searchParams.get('value');

  if (!table || !value) {
    return bad(
      'table and value are required',
      400
    );
  }

  try {
    // bundle_tests uses soft-delete so that
    // frontend cache synchronization can safely
    // remove it from the live manifest.
    if (table === 'bundle_tests') {
      const existing =
        await getTableRowByKey(
          env,
          table,
          key,
          value
        );

      if (!existing) {
        return bad(
          'Row not found',
          404
        );
      }

      const deleted = {
        ...existing,
        status: 'deleted',
        updated_at: nowIso()
      };

      await upsertSourceRow(
        env,
        table,
        deleted,
        key
      );

      return json({
        success: true,
        deleted: true,
        soft_deleted: true,
        row: deleted
      });
    }

    await env.DB
      .prepare(
        `DELETE FROM ${table} WHERE ${key} = ?`
      )
      .bind(value)
      .run();

    return json({
      success: true,
      deleted: true
    });

  } catch (error) {
    return json({
      success: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}

/* -------------------------------------------------------
   HEALTH
------------------------------------------------------- */

async function handleHealth(env) {
  try {
    let dbOk = false;

    if (env.DB) {
      await env.DB
        .prepare('SELECT 1 AS ok')
        .first();

      dbOk = true;
    }

    return json({
      success: true,
      worker: 'ExamMaster Pro',
      version: 'V5.170',
      database: dbOk ? 'connected' : 'missing',
      time: nowIso()
    });

  } catch (error) {
    return json({
      success: false,
      worker: 'ExamMaster Pro',
      version: 'V5.170',
      database: 'error',
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}

/* -------------------------------------------------------
   MAIN FETCH
------------------------------------------------------- */

export default {
  async fetch(request, env, ctx) {
    const url =
      new URL(request.url);

    const method =
      request.method.toUpperCase();

    try {
      // CORS preflight
      if (method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods':
              'GET,POST,PATCH,DELETE,OPTIONS',
            'Access-Control-Allow-Headers':
              'Content-Type, Authorization, X-Admin-Key',
            'Access-Control-Max-Age':
              '86400'
          }
        });
      }

      let response;

      /* Health */
      if (
        url.pathname === '/' ||
        url.pathname === '/health' ||
        url.pathname === '/api/health'
      ) {
        response =
          await handleHealth(env);
      }

      /* ---------------- RANKING ---------------- */

      else if (
        url.pathname === '/api/rank/submit' &&
        method === 'POST'
      ) {
        response =
          await handleRankSubmit(
            request,
            env
          );
      }

      else if (
        url.pathname === '/api/rank/leaderboard' &&
        method === 'GET'
      ) {
        response =
          await handleRankLeaderboard(
            request,
            env,
            url
          );
      }

      else if (
        url.pathname === '/api/rank/participants' &&
        method === 'GET'
      ) {
        response =
          await handleRankParticipants(
            request,
            env,
            url
          );
      }

      else if (
        url.pathname === '/api/rank/tests' &&
        method === 'GET'
      ) {
        response =
          await handleRankTests(
            request,
            env
          );
      }

      /* ---------------- TABLE API ---------------- */

      else if (
        url.pathname === '/api/table' &&
        method === 'GET'
      ) {
        response =
          await handleTableGet(
            request,
            env,
            url
          );
      }

      else if (
        url.pathname === '/api/table' &&
        method === 'POST'
      ) {
        response =
          await handleTablePost(
            request,
            env
          );
      }

      else if (
        url.pathname === '/api/table' &&
        method === 'PATCH'
      ) {
        response =
          await handlePatch(
            request,
            env,
            url
          );
      }

      else if (
        url.pathname === '/api/table' &&
        method === 'DELETE'
      ) {
        response =
          await handleDelete(
            request,
            env,
            url
          );
      }

      /* ---------------- REST COMPATIBILITY ---------------- */

      else if (
        url.pathname.startsWith('/rest/v1/')
      ) {
        response =
          await handleRestCompat(
            request,
            env,
            url
          );
      }

      else {
        response = json({
          success: false,
          error: 'Not found',
          path: url.pathname,
          version: 'V5.170'
        }, 404);
      }

      // Add CORS to every response.
      const headers =
        new Headers(response.headers);

      headers.set(
        'Access-Control-Allow-Origin',
        '*'
      );

      headers.set(
        'Access-Control-Allow-Methods',
        'GET,POST,PATCH,DELETE,OPTIONS'
      );

      headers.set(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Admin-Key'
      );

      return new Response(
        response.body,
        {
          status: response.status,
          headers
        }
      );

    } catch (error) {
      return json({
        success: false,
        error:
          error?.message ||
          String(error),
        version: 'V5.170'
      }, 500);
    }
  }
};

/* -------------------------------------------------------
   REST COMPATIBILITY
------------------------------------------------------- */

async function handleRestCompat(request, env, url) {
  const pathname =
    url.pathname
      .replace(/^\/rest\/v1\//, '')
      .replace(/\/+$/, '');

  const method =
    request.method.toUpperCase();

  const table =
    pathname;

  if (!table) {
    return bad(
      'REST table missing',
      400
    );
  }

  try {
    /* GET */
    if (method === 'GET') {
      const rows =
        await readTable(
          env,
          table,
          {
            includeDeleted:
              url.searchParams.get(
                'include_deleted'
              ) === 'true'
          }
        );

      return json(rows);
    }

    /* POST */
    if (method === 'POST') {
      let body;

      try {
        body =
          await request.json();
      } catch (_) {
        return bad(
          'Invalid JSON body',
          400
        );
      }

      const rows =
        Array.isArray(body)
          ? body
          : [body];

      const saved = [];

      for (const row of rows) {
        let conflictKey = 'id';

        if (
          table === 'emp_test_submissions'
        ) {
          conflictKey =
            url.searchParams.get(
              'on_conflict'
            ) ||
            'attempt_id';
        }

        if (
          table === 'bundle_tests'
        ) {
          conflictKey =
            url.searchParams.get(
              'on_conflict'
            ) ||
            'test_id';
        }

        saved.push(
          await upsertSourceRow(
            env,
            table,
            row,
            conflictKey
          )
        );
      }

      return json(saved);
    }

    /* PATCH */
    if (method === 'PATCH') {
      const filters = [];

      for (
        const [key, value]
        of url.searchParams.entries()
      ) {
        if (
          key === 'on_conflict' ||
          key === 'select'
        ) {
          continue;
        }

        const match =
          key.match(/^(.+)\.(eq|neq)$/);

        if (!match) continue;

        filters.push({
          column: match[1],
          op: match[2],
          value
        });
      }

      if (!filters.length) {
        return bad(
          'PATCH filter required',
          400
        );
      }

      let body;

      try {
        body =
          await request.json();
      } catch (_) {
        return bad(
          'Invalid JSON body',
          400
        );
      }

      const where =
        filters.map(
          f =>
            `${f.column} ${
              f.op === 'eq'
                ? '='
                : '!='
            } ?`
        ).join(' AND ');

      const params =
        filters.map(
          f => f.value
        );

      const existing =
        await env.DB
          .prepare(
            `SELECT *
             FROM ${table}
             WHERE ${where}`
          )
          .bind(...params)
          .all();

      const output = [];

      for (
        const raw
        of existing.results || []
      ) {
        const current =
          d1RowToSource(raw);

        const merged = {
          ...current,
          ...body
        };

        if (
          table === 'bundle_tests' &&
          !body.html_content &&
          current.html_content
        ) {
          merged.html_content =
            current.html_content;
        }

        let conflictKey = 'id';

        if (
          table === 'emp_test_submissions'
        ) {
          conflictKey =
            'attempt_id';
        }

        if (
          table === 'bundle_tests'
        ) {
          conflictKey =
            'test_id';
        }

        output.push(
          await upsertSourceRow(
            env,
            table,
            merged,
            conflictKey
          )
        );
      }

      return json(output);
    }

    /* DELETE */
    if (method === 'DELETE') {
      const filters = [];

      for (
        const [key, value]
        of url.searchParams.entries()
      ) {
        const match =
          key.match(/^(.+)\.(eq)$/);

        if (!match) continue;

        filters.push({
          column: match[1],
          value
        });
      }

      if (!filters.length) {
        return bad(
          'DELETE filter required',
          400
        );
      }

      const where =
        filters.map(
          f => `${f.column} = ?`
        ).join(' AND ');

      const params =
        filters.map(
          f => f.value
        );

      await env.DB
        .prepare(
          `DELETE FROM ${table}
           WHERE ${where}`
        )
        .bind(...params)
        .run();

      return json({
        success: true
      });
    }

    return bad(
      'Method not supported',
      405
    );

  } catch (error) {
    return json({
      success: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}
