async function handleRedeemActivation(request, env) {
  let body;

  try {
    body = await request.json();
  } catch (_) {
    return bad('Invalid JSON body');
  }

  const code = String(body.p_code || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

  const bundleId = String(body.p_bundle_id ?? '').trim();
  const userKey = String(body.p_user_key || '').trim();

  if (!code || !bundleId || !userKey) {
    return bad('p_code, p_bundle_id and p_user_key are required', 400);
  }

  // Current HTML stores SHA-256 hashes, not the original activation code.
  const codeHash = await sha256Hex(code);

  // Support both hashed codes and legacy plaintext codes.
  const codeRow = await env.DB.prepare(
    'SELECT * FROM activation_codes WHERE UPPER(code) = ? OR UPPER(code) = ? LIMIT 1'
  ).bind(codeHash.toUpperCase(), code).first();

  if (!codeRow) {
    return json({ status: 'invalid' });
  }

  const activation = d1RowToSource(codeRow);

  if (String(activation.bundle_id) !== bundleId) {
    return json({
      status: 'wrong_bundle',
      bundle_id: String(activation.bundle_id)
    });
  }

  const currentStatus = String(activation.status || '').toLowerCase();

  if (
    ['used', 'redeemed'].includes(currentStatus) ||
    activation.redeemed_by
  ) {
    return json({
      status: 'used',
      bundle_id: bundleId
    });
  }

  const existing = await env.DB.prepare(
    'SELECT 1 FROM entitlements WHERE user_key = ? AND bundle_id = ? LIMIT 1'
  ).bind(userKey, bundleId).first();

  if (existing) {
    return json({
      status: 'already_owned',
      bundle_id: bundleId
    });
  }

  const now = nowIso();

  const updatedActivation = {
    ...activation,
    status: 'used',
    redeemed_by: userKey,
    redeemed_at: now
  };

  await env.DB.prepare(
    'UPDATE activation_codes SET status = ?, redeemed_by = ?, redeemed_at = ?, data_json = ? WHERE id = ?'
  ).bind(
    'used',
    userKey,
    now,
    JSON.stringify(updatedActivation),
    String(codeRow.id)
  ).run();

  const entitlement = {
    id: crypto.randomUUID(),
    user_key: userKey,
    bundle_id: bundleId,
    created_at: now
  };

  await upsertSourceRow(
    env,
    'entitlements',
    entitlement,
    null
  );

  return json({
    status: 'success',
    bundle_id: bundleId,
    user_key: userKey
  });
}
