/*
 * ExamMaster Pro - Cloudflare Worker / D1
 * V5.144 — ACTIVATION HASH + LIFETIME + HTML RECOVERY + ACCESS/PUBLISH FIX
 *
 * Fixes:
 * 1. bundle_tests access state is authoritative.
 * 2. FREE / PAID / price / access fields stay synchronized.
 * 3. Access-only updates never erase existing test HTML.
 * 4. If html_content column is empty but data_json has HTML, HTML is recovered.
 * 5. Activation codes generated as SHA-256 hashes can now be redeemed.
 * 6. Legacy raw activation codes are also supported.
 * 7. Each activation code can be redeemed only once.
 * 8. Successful redemption creates a lifetime D1 entitlement.
 * 9. Entitlement survives app updates/admin updates because it is stored in D1.
 * 10. REST compatibility, analytics and ranking endpoints retained.
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
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: corsHeaders({
        'Content-Type':
          'application/json; charset=utf-8',
        ...extra
      })
    }
  );
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

  for (
    const [key, value]
    of url.searchParams.entries()
  ) {

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

    if (
      key === 'or' ||
      key === 'and'
    ) {
      continue;
    }

    const m =
      String(value).match(
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
        .map(
          x =>
            x.replace(
              /^"|"$/g,
              ''
            )
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

      val =
        decodeFilterValue(val);
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

  if (
    a == null &&
    b == null
  ) {
    return 0;
  }

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

  const da =
    Date.parse(String(a));

  const db =
    Date.parse(String(b));

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

function rowMatches(
  row,
  filters
) {

  return filters.every(f => {

    const actual =
      row[f.key];

    const val =
      f.val;

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
          compareValue(
            actual,
            val
          ) > 0
        );

      case 'gte':
        return (
          compareValue(
            actual,
            val
          ) >= 0
        );

      case 'lt':
        return (
          compareValue(
            actual,
            val
          ) < 0
        );

      case 'lte':
        return (
          compareValue(
            actual,
            val
          ) <= 0
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
        return (
          val === null
            ? actual == null
            : Boolean(actual) ===
              Boolean(val)
        );

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

  if (
    !raw ||
    raw === '*'
  ) {
    return null;
  }

  return String(raw)
    .split(',')
    .map(
      s =>
        cleanIdent(
          s.trim()
        )
    )
    .filter(Boolean);
}

function applySelect(
  row,
  fields
) {

  if (!fields) {
    return row;
  }

  const out = {};

  for (
    const f of fields
  ) {
    out[f] =
      row[f] ?? null;
  }

  return out;
}

function parseOrder(raw) {

  if (!raw) {
    return [];
  }

  return String(raw)
    .split(',')
    .map(part => {

      const p =
        part
          .trim()
          .split('.');

      return {
        field:
          cleanIdent(p[0]),

        dir:
          String(
            p[1] || 'asc'
          ).toLowerCase() ===
          'desc'
            ? -1
            : 1
      };
    })
    .filter(
      x => x.field
    );
}


/* ============================================================
   ACCESS / PAYMENT NORMALIZATION
   ============================================================ */

function normalizeAccessState(
  source
) {

  const s =
    source &&
    typeof source === 'object'
      ? source
      : {};

  const values = [
    s.access_mode,
    s.access_override,
    s.access_type
  ].map(
    v =>
      String(
        v ?? ''
      ).toLowerCase()
  );

  if (
    values.includes('paid') ||
    s.is_paid === true ||
    String(
      s.is_paid
    ).toLowerCase() ===
      'true' ||
    Number(
      s.is_paid
    ) === 1 ||
    Number(
      s.price
    ) > 0
  ) {
    return 'paid';
  }

  if (
    values.includes('free') ||
    s.is_paid === false ||
    String(
      s.is_paid
    ).toLowerCase() ===
      'false' ||
    Number(
      s.is_paid
    ) === 0
  ) {
    return 'free';
  }

  return 'inherit';
}

function normalizeTestAccess(
  source
) {

  const s =
    source &&
    typeof source === 'object'
      ? source
      : {};

  const state =
    normalizeAccessState(s);

  return {
    state,

    access_mode:
      state,

    access_override:
      state,

    access_type:
      state,

    is_paid:
      state === 'paid',

    price:
      state === 'paid'
        ? Math.max(
            0,
            Number(
              s.price || 0
            ) || 0
          )
        : 0
  };
}


/* ============================================================
   SOURCE -> D1
   ============================================================ */

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

  if (
    table === 'subjects'
  ) {

    Object.assign(
      common,
      {
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
      }
    );

  } else if (
    table === 'notes'
  ) {

    Object.assign(
      common,
      {
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
      }
    );

  } else if (
    table === 'bundles'
  ) {

    Object.assign(
      common,
      {
        name:
          src.name ??
          'Untitled Bundle',

        description:
          src.description ??
          null,

        updated_at:
          src.updated_at ??
          nowIso()
      }
    );

  } else if (
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

    Object.assign(
      common,
      {
        bundle_id:
          src.bundle_id != null
            ? String(
                src.bundle_id
              )
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
          src.level ??
          null,

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
          a.is_paid
            ? 1
            : 0,

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
      }
    );

  } else if (
    table === 'banners'
  ) {

    Object.assign(
      common,
      {
        title:
          src.title ??
          null,

        description:
          src.description ??
          null,

        price:
          src.price ??
          null,

        image:
          src.image ??
          null,

        qrData:
          src.qrData ??
          null,

        link_type:
          src.link_type ??
          null,

        link:
          src.link ??
          null,

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
      }
    );

  } else if (
    table ===
    'activation_codes'
  ) {

    Object.assign(
      common,
      {
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
          src.amount ??
          0,

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
      }
    );

  } else if (
    table ===
    'entitlements'
  ) {

    Object.assign(
      common,
      {
        user_key:
          String(
            src.user_key ??
            ''
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
      }
    );

  } else if (
    table ===
    'emp_test_submissions'
  ) {

    Object.assign(
      common,
      {
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

        subject_id:
          src.subject_id != null
            ? String(
                src.subject_id
              )
            : null,

        test_name:
          src.test_name ??
          null,

        score:
          src.score ??
          null,

        total_marks:
          src.total_marks ??
          null,

        accuracy:
          src.accuracy ??
          null,

        percentile:
          src.percentile ??
          null,

        status:
          src.status ??
          null,

        completed_at:
          src.completed_at ??
          null,

        created_at:
          src.created_at ??
          nowIso()
      }
    );

  } else if (
    table ===
    'emp_analytics_events'
  ) {

    Object.assign(
      common,
      {
        user_id:
          src.user_id != null
            ? String(
                src.user_id
              )
            : null,

        username:
          src.username ??
          null,

        event_type:
          src.event_type ??
          null,

        occurred_at:
          src.occurred_at ??
          nowIso()
      }
    );

  } else if (
    table ===
    'content_notifications'
  ) {

    Object.assign(
      common,
      {
        title:
          src.title ??
          null,

        description:
          src.description ??
          null,

        content_type:
          src.content_type ??
          null,

        content_id:
          src.content_id == null
            ? null
            : String(
                src.content_id
              ),

        created_at:
          src.created_at ??
          nowIso()
      }
    );

  } else if (
    table ===
    'admin_users'
  ) {

    Object.assign(
      common,
      {
        user_id:
          String(
            src.user_id ??
            id
          ),

        email:
          src.email ??
          null,

        created_at:
          src.created_at ??
          nowIso()
      }
    );

  } else if (
    table ===
    'app_releases'
  ) {

    Object.assign(
      common,
      {
        release_id:
          String(
            src.release_id ??
            id
          ),

        release_path:
          src.release_path ??
          null,

        release_url:
          src.release_url ??
          null,

        published_at:
          src.published_at ??
          nowIso(),

        size_bytes:
          src.size_bytes ??
          null,

        content_hash:
          src.content_hash ??
          null,

        active:
          src.active
            ? 1
            : 0
      }
    );

  } else if (
    table ===
    'cf_users'
  ) {

    Object.assign(
      common,
      {
        email:
          src.email ??
          null,

        password_hash:
          src.password_hash ??
          null,

        role:
          src.role ??
          'user',

        created_at:
          src.created_at ??
          nowIso()
      }
    );
  }

  return common;
}


/* ============================================================
   D1 -> SOURCE
   ============================================================ */

function d1RowToSource(
  row
) {

  let data = {};

  try {
    data =
      JSON.parse(
        row.data_json ||
        '{}'
      );
  } catch (_) {}

  const base = {
    ...row
  };

  delete base.data_json;

  /*
   * HTML RECOVERY
   *
   * If typed html_content is empty but
   * data_json.html_content exists,
   * recover the old HTML.
   */

  const out = {
    ...data,
    ...base
  };

  const typedHtml =
    String(
      row.html_content ??
      ''
    ).trim();

  const jsonHtml =
    String(
      data.html_content ??
      ''
    ).trim();

  if (
    !typedHtml &&
    jsonHtml
  ) {
    out.html_content =
      data.html_content;
  }

  /*
   * ACCESS/PAYMENT
   */

  if (
    String(
      row.bundle_id ??
      ''
    ) !== '' &&
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


/* ============================================================
   TABLE COLUMNS
   ============================================================ */

function tableColumns(
  table
) {

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

  return (
    map[table] ||
    []
  );
}


/* ============================================================
   UNIQUE KEY
   ============================================================ */

function uniqueKey(
  table,
  src,
  conflict
) {

  if (
    conflict &&
    src[conflict] != null
  ) {

    return {
      field:
        conflict,

      value:
        String(
          src[conflict]
        )
    };
  }

  if (
    table ===
    'admin_users'
  ) {

    return {
      field:
        'user_id',

      value:
        String(
          src.user_id ??
          src.id
        )
    };
  }

  if (
    table ===
    'app_releases'
  ) {

    return {
      field:
        'release_id',

      value:
        String(
          src.release_id ??
          src.id
        )
    };
  }

  return {
    field:
      'id',

    value:
      String(
        src.id
      )
  };
}


/* ============================================================
   ADMIN AUTH
   ============================================================ */

function adminAllowed(
  request,
  env
) {

  if (
    !env.ADMIN_API_KEY
  ) {
    return true;
  }

  const supplied =
    request.headers.get(
      'X-EMP-Admin-Key'
    ) ||
    request.headers
      .get(
        'Authorization'
      )
      ?.replace(
        /^Bearer\s+/i,
        ''
      );

  return (
    supplied ===
    env.ADMIN_API_KEY
  );
}


/* ============================================================
   READ TABLE
   ============================================================ */

async function readTable(
  env,
  table,
  url,
  options = {}
) {

  const cols =
    tableColumns(table);

  if (
    !cols.length
  ) {

    throw new Error(
      'Unsupported table: ' +
      table
    );
  }

  const rows =
    await env.DB
      .prepare(
        `SELECT ${cols
          .map(
            c =>
              '"' +
              c +
              '"'
          )
          .join(',')}
         FROM "${table}"`
      )
      .all();

  let out =
    (
      rows.results ||
      []
    ).map(
      d1RowToSource
    );

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

  /*
   * Don't show soft-deleted tests
   * in normal public reads.
   */

  if (
    table ===
      'bundle_tests' &&
    !options.includeDeleted &&
    !url.searchParams.has(
      'deleted_at'
    )
  ) {

    out =
      out.filter(
        r =>
          !String(
            r.deleted_at ||
            ''
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
    let i =
      orders.length - 1;
    i >= 0;
    i--
  ) {

    const o =
      orders[i];

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

  if (
    limitRaw != null
  ) {

    out =
      out.slice(
        offset,
        offset +
          Math.max(
            0,
            Number(
              limitRaw
            ) || 0
          )
      );

  } else if (
    offset
  ) {

    out =
      out.slice(
        offset
      );
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


/* ============================================================
   UPSERT
   ============================================================ */

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
        `SELECT * FROM "${table}"
         WHERE "${key.field}" = ?
         LIMIT 1`
      )
      .bind(
        key.value
      )
      .first();

  let mergedSrc =
    src &&
    typeof src === 'object'
      ? JSON.parse(
          JSON.stringify(src)
        )
      : {};

  /*
   * ACCESS-ONLY UPDATE
   *
   * If HTML isn't included in the update,
   * preserve the existing HTML.
   */

  if (
    table ===
      'bundle_tests' &&
    existingRow &&
    !String(
      mergedSrc.html_content ||
      ''
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

  /*
   * Preserve current access state
   * when incoming update doesn't contain it.
   */

  if (
    table ===
      'bundle_tests' &&
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
        d[c] ??
        null
    );

  if (
    existingRow
  ) {

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
          d[c] ??
          null
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
        .map(
          () => '?'
        )
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


/* ============================================================
   DELETE
   ============================================================ */

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
      table ===
      'admin_users'
        ? 'user_id'
        : table ===
          'app_releases'
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
          String(
            row[key]
          )
        )
        .run();

    n += Number(
      r.meta?.changes ||
      0
    );
  }

  return n;
}


/* ============================================================
   REST API
   ============================================================ */

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
    ].includes(
      method
    );

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

  if (
    method ===
    'GET'
  ) {

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
    method ===
    'PATCH'
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

    if (
      !rows.length
    ) {
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
    method ===
    'DELETE'
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


/* ============================================================
   SHA-256
   ============================================================ */

async function sha256Hex(
  value
) {

  const bytes =
    new TextEncoder()
      .encode(
        String(value)
      );

  const digest =
    await crypto.subtle
      .digest(
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
        b.toString(16)
          .padStart(
            2,
            '0'
          )
    )
    .join('');
}


/* ============================================================
   ACTIVATION CODE REDEEM
   ============================================================ */

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
      body.p_code ||
      ''
    ).trim();

  const bundleId =
    String(
      body.p_bundle_id ??
      ''
    ).trim();

  const userKey =
    String(
      body.p_user_key ||
      ''
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

  /*
   * V5.144 IMPORTANT FIX
   *
   * Admin-generated activation codes are stored
   * as SHA-256 hashes in activation_codes.code.
   *
   * So:
   *
   * USER ENTERS:
   * EMP-36Z2-S2NZ-UF8D
   *
   * WORKER:
   * SHA-256(code)
   *
   * D1:
   * stored hash
   *
   * MATCH = VALID
   *
   * Legacy raw-code rows are also supported.
   */

  const codeHash =
    await sha256Hex(
      code
    );

  let codeRow =
    await env.DB
      .prepare(
        'SELECT * FROM "activation_codes" WHERE "code" = ? LIMIT 1'
      )
      .bind(
        codeHash
      )
      .first();

  /*
   * Legacy fallback:
   * Some older activation rows may
   * contain the raw code.
   */

  if (
    !codeRow
  ) {

    codeRow =
      await env.DB
        .prepare(
          'SELECT * FROM "activation_codes" WHERE "code" = ? LIMIT 1'
        )
        .bind(
          code
        )
        .first();
  }

  if (
    !codeRow
  ) {

    return json({
      status:
        'invalid'
    });
  }

  const activation =
    d1RowToSource(
      codeRow
    );

  /*
   * Code must belong to
   * the selected bundle.
   */

  if (
    String(
      activation.bundle_id
    ) !==
    bundleId
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

  /*
   * One-time use protection.
   */

  if (
    status === 'used' ||
    activation.redeemed_by
  ) {

    return json({
      status:
        'used',

      bundle_id:
        bundleId
    });
  }

  /*
   * If this user already owns
   * the bundle, don't consume another
   * activation code.
   */

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

  if (
    existing
  ) {

    return json({
      status:
        'already_owned',

      bundle_id:
        bundleId
    });
  }

  const now =
    nowIso();

  /*
   * ATOMIC ONE-TIME LOCK
   *
   * This WHERE clause means that only a code
   * which is still unused can be consumed.
   *
   * If two devices try at the same time,
   * only one update can change the row.
   */

  const consume =
    await env.DB
      .prepare(
        `UPDATE "activation_codes"
         SET
           "status" = ?,
           "redeemed_by" = ?,
           "redeemed_at" = ?,
           "data_json" = ?
         WHERE
           "id" = ?
           AND LOWER(
             COALESCE(
               "status",
               ''
             )
           ) = 'unused'
           AND (
             "redeemed_by" IS NULL
             OR "redeemed_by" = ''
           )`
      )
      .bind(
        'used',

        userKey,

        now,

        JSON.stringify({
          ...activation,

          status:
            'used',

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

  /*
   * If exactly one row was changed,
   * redemption succeeded.
   */

  if (
    Number(
      consume?.meta?.changes ||
      0
    ) !== 1
  ) {

    return json({
      status:
        'used',

      bundle_id:
        bundleId
    });
  }

  /*
   * CREATE LIFETIME ENTITLEMENT
   *
   * This row remains in D1 permanently
   * unless an admin explicitly deletes it.
   *
   * App updates do not remove it.
   * HTML updates do not remove it.
   * Admin content updates do not remove it.
   */

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
    status:
      'success',

    bundle_id:
      bundleId,

    user_key:
      userKey
  });
}


/* ============================================================
   GET LIFETIME BUNDLE ENTITLEMENTS
   ============================================================ */

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

  if (
    !userKey
  ) {
    return json([]);
  }

  const rows =
    await env.DB
      .prepare(
        'SELECT * FROM "entitlements" WHERE "user_key" = ? ORDER BY "created_at" DESC'
      )
      .bind(
        userKey
      )
      .all();

  return json(
    (
      rows.results ||
      []
    ).map(
      d1RowToSource
    )
  );
}


/* ============================================================
   IMPORT JSON
   ============================================================ */

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
      body.table ||
      ''
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

      written:
        0,

      bundle_tests_written:
        0
    });
  }

  let target =
    table;

  if (
    target ===
    'tests'
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


/* ============================================================
   ANALYTICS
   ============================================================ */

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

  if (
    !body.user_id
  ) {

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


/* ============================================================
   RANKING
   ============================================================ */

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
          String(
            r.status ||
            'completed'
          ).toLowerCase() ===
          'completed'
      );

  clean.sort(
    (a, b) => {

      const score =
        rankNumber(
          b.score
        ) -
        rankNumber(
          a.score
        );

      if (
        score
      ) {
        return score;
      }

      const acc =
        rankNumber(
          b.accuracy
        ) -
        rankNumber(
          a.accuracy
        );

      if (
        acc
      ) {
        return acc;
      }

      const time =
        rankNumber(
          a.time_taken ??
          a.time_seconds ??
          999999
        ) -
        rankNumber(
          b.time_taken ??
          b.time_seconds ??
          999999
        );

      if (
        time
      ) {
        return time;
      }

      return String(
        a.completed_at ||
        a.created_at ||
        ''
      ).localeCompare(
        String(
          b.completed_at ||
          b.created_at ||
          ''
        )
      );
    }
  );

  const leaderboard =
    clean.map(
      (r, i) => ({

        rank:
          i + 1,

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
          r.created_at
      })
    );

  const me =
    leaderboard.find(
      r =>
        String(
          r.attempt_id
        ) ===
        String(
          attemptId
        )
    ) ||
    leaderboard.find(
      r =>
        String(
          r.user_id
        ) ===
        String(
          userId
        )
    );

  if (
    me
  ) {

    me.percentile =
      leaderboard.length <= 1
        ? 100
        : Number(
            (
              (
                (
                  leaderboard.length -
                  me.rank
                ) /
                leaderboard.length
              ) *
              100
            ).toFixed(2)
          );
  }

  return {

    success:
      true,

    leaderboard,

    participants:
      leaderboard.length,

    user:
      me ||
      null,

    percentile:
      me?.percentile ??
      null
  };
}


/* ============================================================
   RANK SUBMIT
   ============================================================ */

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
    success:
      true,

    source:
      'cloudflare_d1'
  });
}


/* ============================================================
   RANK LEADERBOARD
   ============================================================ */

async function handleRankLeaderboard(
  request,
  env,
  url
) {

  const testId =
    String(
      url.searchParams.get(
        'test_id'
      ) ||
      ''
    ).trim();

  const userId =
    String(
      url.searchParams.get(
        'user_id'
      ) ||
      ''
    ).trim();

  const attemptId =
    String(
      url.searchParams.get(
        'attempt_id'
      ) ||
      ''
    ).trim();

  if (
    !testId
  ) {

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
      rows.results ||
      [],
      userId,
      attemptId
    )
  );
}


/* ============================================================
   ROUTER
   ============================================================ */

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
        status:
          204,

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
      '/api/analytics/event'
    ) {

      return await handleAnalyticsEvent(
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
     * LIFETIME ENTITLEMENT RPC
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
     * REST TABLE API
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
              '/rest/v1/'
                .length
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
          'V5.144-ACTIVATION-HASH-LIFETIME-FIX',

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


/* ============================================================
   CLOUDFLARE ENTRY
   ============================================================ */

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
