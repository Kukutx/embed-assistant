-- 1.0.3: scheduled re-sync of crawled sources.
ALTER TABLE knowledge_sources ADD COLUMN sync_interval_hours integer;
