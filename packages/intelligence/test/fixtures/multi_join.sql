SELECT
  u.id,
  a.name,
  p.plan_name
FROM users u
JOIN accounts a ON a.id = u.account_id
JOIN memberships m ON m.user_id = u.id
JOIN plans p ON p.id = m.plan_id
WHERE u.org_id = $1
ORDER BY u.created_at DESC
LIMIT 100;
