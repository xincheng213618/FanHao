export function workInfoDetailQuery(parameterCount = 1) {
  const count = Math.max(1, Math.min(400, Math.trunc(Number(parameterCount) || 1)));
  const placeholders = Array.from({ length: count }, () => "?").join(", ");
  return `
    SELECT
      CAST(w.id AS TEXT) AS work_id,
      CAST(p.id AS TEXT) AS person_id,
      COALESCE(p.name, '') AS person_name,
      lw.source_info_id,
      lw.source_name,
      lw.source_info_path AS source_path,
      lw.source_size,
      lw.source_mtime,
      w.code,
      w.title,
      w.release_date,
      w.duration_minutes,
      w.rating,
      w.rating_count,
      w.director,
      maker.name AS maker,
      label.name AS label,
      series.name AS series,
      vref.url AS javdb_url,
      cover.remote_url AS image_url,
      (
        SELECT json_group_array(i.remote_url)
        FROM fanhao_images.images i
        WHERE i.owner_type = 'work'
          AND i.owner_id = w.id
          AND i.kind = 'preview'
          AND i.remote_url IS NOT NULL
          AND i.remote_url <> ''
      ) AS preview_images_json,
      NULL AS preview_video_url,
      (
        SELECT json_group_array(pp.name)
        FROM work_people wpa
        JOIN people pp ON pp.id = wpa.person_id
        WHERE wpa.work_id = w.id
          AND wpa.role = 'actor'
      ) AS actors_json,
      (
        SELECT json_group_array(json_object('name', pp.name, 'url', COALESCE(pref.url, '')))
        FROM work_people wpa
        JOIN people pp ON pp.id = wpa.person_id
        LEFT JOIN person_external_refs pref
          ON pref.person_id = pp.id
         AND pref.provider = 'javdb-actor'
        WHERE wpa.work_id = w.id
          AND wpa.role = 'actor'
      ) AS actor_links_json,
      '[]' AS tags_json,
      '[]' AS tag_links_json,
      maker_ref.url AS maker_url,
      label_ref.url AS label_url,
      series_ref.url AS series_url,
      w.fields_json,
      w.raw_text,
      0 AS raw_truncated,
      w.status,
      w.error,
      w.updated_at
    FROM works w
    LEFT JOIN local_works lw ON lw.work_id = w.id
    LEFT JOIN work_people wp ON wp.work_id = w.id AND wp.role = 'actor'
    LEFT JOIN people p ON p.id = wp.person_id
    LEFT JOIN work_external_refs vref ON vref.work_id = w.id AND vref.provider = 'javdb-video'
    LEFT JOIN fanhao_images.images cover
      ON cover.id = (
        SELECT i.id
        FROM fanhao_images.images i
        WHERE i.owner_type = 'work'
          AND i.owner_id = w.id
          AND i.kind = 'cover'
        ORDER BY CASE WHEN i.image_blob IS NOT NULL THEN 0 ELSE 1 END, i.id ASC
        LIMIT 1
      )
    LEFT JOIN work_makers maker_link ON maker_link.work_id = w.id AND maker_link.role = 'maker'
    LEFT JOIN makers maker ON maker.id = maker_link.maker_id
    LEFT JOIN maker_external_refs maker_ref ON maker_ref.maker_id = maker.id AND maker_ref.provider = 'javdb-maker'
    LEFT JOIN work_makers label_link ON label_link.work_id = w.id AND label_link.role = 'label'
    LEFT JOIN makers label ON label.id = label_link.maker_id
    LEFT JOIN maker_external_refs label_ref ON label_ref.maker_id = label.id AND label_ref.provider = 'javdb-maker'
    LEFT JOIN work_series ws ON ws.work_id = w.id
    LEFT JOIN series ON series.id = ws.series_id
    LEFT JOIN series_external_refs series_ref ON series_ref.series_id = series.id AND series_ref.provider = 'javdb-series'
    WHERE w.status = 'ok'
      AND lw.id IS NOT NULL
      AND w.id IN (${placeholders})
    GROUP BY w.id
  `;
}
