WITH active_users AS (
  SELECT id
  FROM users
  WHERE org_id = $1
),
ranked_events AS (
  SELECT *
  FROM events e
  WHERE e.user_id IN (
    SELECT au.id
    FROM active_users au
    WHERE au.id IN (
      SELECT user_id
      FROM sessions
      WHERE ended_at IS NULL
    )
  )
)
SELECT id
FROM ranked_events
WHERE user_id = $2;
