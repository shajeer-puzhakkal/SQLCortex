-- SQLCortex test query (Postgres)
SELECT
  42::int AS id,
  'hello'::text AS label,
  now() AS queried_at,
  ARRAY[1,2,3]::int[] AS sample_array,
  jsonb_build_object('env', 'test', 'ok', true) AS meta;