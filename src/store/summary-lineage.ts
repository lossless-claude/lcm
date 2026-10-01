/** The selected summary and every summary it was condensed from. One bound id. */
export const SUMMARY_SOURCE_IDS_SQL = `
  WITH RECURSIVE source_ids(summary_id) AS (
    SELECT summary_id FROM summaries WHERE summary_id = ?
    UNION
    SELECT sp.parent_summary_id FROM summary_parents sp
    JOIN source_ids ON sp.summary_id = source_ids.summary_id
  )
  SELECT summary_id FROM source_ids`;
