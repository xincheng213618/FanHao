export const LOCAL_SHORT_VIDEO_USER_ID = "local:self";

export const SHORT_VIDEO_RECOMMENDATION_SCORE_SQL = `(
  CASE
    WHEN COALESCE(v.author_following, 0) = 1 THEN 8000000000000
    ELSE 0
  END
  + CASE
    WHEN (
      COALESCE(v.digg_count, 0)
      + COALESCE(v.comment_count, 0) * 6
      + COALESCE(v.collect_count, 0) * 4
      + COALESCE(v.share_count, 0) * 3
    ) >= 1000000 THEN 5000000000000
    WHEN (
      COALESCE(v.digg_count, 0)
      + COALESCE(v.comment_count, 0) * 6
      + COALESCE(v.collect_count, 0) * 4
      + COALESCE(v.share_count, 0) * 3
    ) >= 100000 THEN 4000000000000
    WHEN (
      COALESCE(v.digg_count, 0)
      + COALESCE(v.comment_count, 0) * 6
      + COALESCE(v.collect_count, 0) * 4
      + COALESCE(v.share_count, 0) * 3
    ) >= 10000 THEN 3000000000000
    WHEN (
      COALESCE(v.digg_count, 0)
      + COALESCE(v.comment_count, 0) * 6
      + COALESCE(v.collect_count, 0) * 4
      + COALESCE(v.share_count, 0) * 3
    ) >= 1000 THEN 2000000000000
    ELSE 1000000000000
  END
  + (
    ABS(CAST(SUBSTR(v.id, -9) AS INTEGER) * 1103515245 + 12345) % 1000000000
  ) * 1000
  + COALESCE(v.create_time, 0)
)`;
