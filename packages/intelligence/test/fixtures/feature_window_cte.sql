WITH active_users AS (
  SELECT
    u.id,
    lower(u.email) AS email_key
  FROM users u
  WHERE u.status = 'active'
)
SELECT
  au.*,
  count(*) OVER (PARTITION BY au.id) AS session_count
FROM active_users au
JOIN sessions s ON s.user_id = au.id
WHERE au.email_key LIKE 'a%'
GROUP BY au.id, au.email_key
ORDER BY au.email_key
LIMIT 20;
